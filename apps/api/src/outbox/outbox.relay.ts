import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@hos/db';
import { DB_ADMIN } from '../db/db.module.js';

export interface OutboxRecord {
  id: string; tenantId: string; aggregateType: string; aggregateId: string; eventType: string;
  eventVersion: number; propertyId: string | null; businessDate: string | null; payload: unknown; createdAt: Date;
}
/** Where events go (BullMQ queues in production). Delivery is at-least-once; consumers must be idempotent (see InboxService). */
export interface EventDispatcher { dispatch(e: OutboxRecord): Promise<void> }
export const EVENT_DISPATCHER = Symbol('EVENT_DISPATCHER');

export interface DrainResult { dispatched: number; failed: number; deadLettered: number }

/**
 * Platform job (BYPASSRLS connection): publishes pending outbox rows across tenants. Multiple relays are safe (FOR UPDATE SKIP LOCKED).
 * Per-aggregate ordering: once an event for an aggregate fails in a batch, its later events wait for the next pass.
 */
@Injectable()
export class OutboxRelay {
  constructor(
    @Inject(DB_ADMIN) private readonly admin: Kysely<DB> | null,
    @Inject(EVENT_DISPATCHER) private readonly dispatcher: EventDispatcher,
    private readonly maxAttempts = 8,
  ) {}

  async drainOnce(limit = 100): Promise<DrainResult> {
    if (!this.admin) throw new Error('Outbox relay requires DATABASE_URL_ADMIN');
    const result: DrainResult = { dispatched: 0, failed: 0, deadLettered: 0 };
    await this.admin.transaction().execute(async (trx) => {
      const rows = await sql<{
        tenant_id: string; id: string; aggregate_type: string; aggregate_id: string; event_type: string; event_version: number;
        property_id: string | null; business_date: string | null; payload: unknown; created_at: Date; attempts: number;
      }>`SELECT tenant_id, id, aggregate_type, aggregate_id, event_type, event_version, property_id,
                to_char(business_date,'YYYY-MM-DD') AS business_date, payload, created_at, attempts
         FROM outbox_event
         WHERE published_at IS NULL AND dead_lettered_at IS NULL
         ORDER BY seq
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED`.execute(trx);

      const blocked = new Set<string>();
      for (const r of rows.rows) {
        const key = `${r.tenant_id}|${r.aggregate_type}|${r.aggregate_id}`;
        if (blocked.has(key)) continue;
        try {
          await this.dispatcher.dispatch({
            id: r.id, tenantId: r.tenant_id, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id, eventType: r.event_type,
            eventVersion: r.event_version, propertyId: r.property_id, businessDate: r.business_date, payload: r.payload, createdAt: r.created_at,
          });
          await sql`UPDATE outbox_event SET published_at = now(), last_error = NULL WHERE tenant_id = ${r.tenant_id} AND id = ${r.id}`.execute(trx);
          result.dispatched++;
        } catch (e) {
          blocked.add(key);
          const attempts = r.attempts + 1;
          const dead = attempts >= this.maxAttempts;
          await sql`UPDATE outbox_event SET attempts = ${attempts}, last_error = ${String((e as Error).message).slice(0, 500)},
                    dead_lettered_at = ${dead ? sql`now()` : null} WHERE tenant_id = ${r.tenant_id} AND id = ${r.id}`.execute(trx);
          result.failed++;
          if (dead) result.deadLettered++;
        }
      }
    });
    return result;
  }
}
