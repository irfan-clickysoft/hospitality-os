import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { DB } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createDb(connectionString: string, max = 10): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max }) }) });
}

/**
 * Runs `fn` in a transaction whose RLS context is `tenantId`. The setting is transaction-local (set_config(..., true)),
 * so it cannot leak to another request on a pooled connection. Every tenant-scoped query MUST go through this.
 */
export async function withTenant<T>(db: Kysely<DB>, tenantId: string, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error('withTenant: tenantId must be a UUID');
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}
