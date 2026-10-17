import { createHash } from 'node:crypto';
import { HttpException, Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type { DB } from '@hos/db';
import { currentTenant } from '../tenancy/tenant-context.js';

export class IdempotencyKeyReuseError extends HttpException {
  constructor() { super({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency-Key was already used with a different request' }, 422); }
}

export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method.toUpperCase()} ${path}\n${canonical(body)}`).digest('hex');
}
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

export interface IdempotentResult<T> { replayed: boolean; statusCode: number; body: T }

@Injectable()
export class IdempotencyService {
  /**
   * Executes `fn` at most once per key, inside the caller's transaction. The key row and the business effects commit together,
   * so a concurrent duplicate blocks on the unique index until the first finishes, then replays its stored response.
   * If `fn` throws, the transaction rolls back (including the key), so a failed attempt can be retried.
   */
  async run<T>(trx: Transaction<DB>, key: string, requestHash: string, fn: () => Promise<{ statusCode: number; body: T }>): Promise<IdempotentResult<T>> {
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) throw new HttpException({ code: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key must be 8-200 URL-safe characters' }, 400);
    const tenantId = currentTenant().tenantId;
    const ins = await trx.insertInto('idempotency_key').values({ tenant_id: tenantId, key, request_hash: requestHash, status_code: null, response: null })
      .onConflict((oc) => oc.columns(['tenant_id', 'key']).doNothing()).returning('key').executeTakeFirst();
    if (!ins) {
      const row = await trx.selectFrom('idempotency_key').select(['request_hash', 'status_code', 'response']).where('key', '=', key).executeTakeFirstOrThrow();
      if (row.request_hash !== requestHash) throw new IdempotencyKeyReuseError();
      if (row.status_code === null) throw new HttpException({ code: 'REQUEST_IN_PROGRESS', message: 'A request with this key is still being processed' }, 409);
      return { replayed: true, statusCode: row.status_code, body: row.response as T };
    }
    const out = await fn();
    await trx.updateTable('idempotency_key').set({ status_code: out.statusCode, response: JSON.stringify(out.body) }).where('key', '=', key).execute();
    return { replayed: false, ...out };
  }
}
