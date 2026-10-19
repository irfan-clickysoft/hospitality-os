import { Inject, Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type { DB } from '@hos/db';
import { currentTenant } from '../tenancy/tenant-context.js';
import { redact } from './redact.js';

export interface AuditEntry {
  action: string;               // e.g. 'folio.adjust', 'reservation.cancel'
  resourceType: string;
  resourceId?: string;
  propertyId?: string;
  before?: unknown;
  after?: unknown;
  reasonCode?: string;
  note?: string;
}

/** Writes the audit row inside the caller's transaction, so the trail commits (or rolls back) with the change it describes. */
@Injectable()
export class AuditService {
  async record(trx: Transaction<DB>, e: AuditEntry): Promise<void> {
    const ctx = currentTenant();
    await trx.insertInto('audit_log').values({
      tenant_id: ctx.tenantId,
      actor_type: ctx.actorId ? 'USER' : 'SYSTEM',
      actor_id: ctx.actorId ?? null,
      on_behalf_of: null,
      action: e.action,
      resource_type: e.resourceType,
      resource_id: e.resourceId ?? null,
      property_id: e.propertyId ?? null,
      before: e.before === undefined ? null : JSON.stringify(redact(e.before)),
      after: e.after === undefined ? null : JSON.stringify(redact(e.after)),
      reason_code: e.reasonCode ?? null,
      note: e.note ?? null,
      request_id: ctx.requestId ?? null,
      ip: ctx.ip ?? null,
      user_agent: ctx.userAgent ?? null,
    }).execute();
  }
}
