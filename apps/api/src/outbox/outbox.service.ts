import { Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type { DB } from '@hos/db';
import { currentTenant } from '../tenancy/tenant-context.js';

export interface DomainEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: string;          // e.g. 'ReservationCreated'
  eventVersion?: number;
  propertyId?: string;
  businessDate?: string;      // hotel business date (YYYY-MM-DD), not system date
  payload: unknown;
}

@Injectable()
export class OutboxService {
  /** Records the event in the caller's transaction: state change and event commit together or not at all. */
  async publish(trx: Transaction<DB>, e: DomainEvent): Promise<void> {
    await trx.insertInto('outbox_event').values({
      tenant_id: currentTenant().tenantId,
      aggregate_type: e.aggregateType, aggregate_id: e.aggregateId, event_type: e.eventType,
      event_version: e.eventVersion ?? 1, property_id: e.propertyId ?? null, business_date: e.businessDate ?? null,
      payload: JSON.stringify(e.payload), published_at: null,
    }).execute();
  }
}
