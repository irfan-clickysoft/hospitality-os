import { Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type { DB } from '@hos/db';

@Injectable()
export class InboxService {
  /** Runs `fn` at most once per (consumer, event) — the receipt and the consumer's effects commit in the same transaction. */
  async once<T>(trx: Transaction<DB>, tenantId: string, consumer: string, eventId: string, fn: () => Promise<T>): Promise<{ ran: boolean; value?: T }> {
    const ins = await trx.insertInto('inbox_receipt').values({ tenant_id: tenantId, consumer, event_id: eventId })
      .onConflict((oc) => oc.columns(['tenant_id', 'consumer', 'event_id']).doNothing()).returning('event_id').executeTakeFirst();
    if (!ins) return { ran: false };
    return { ran: true, value: await fn() };
  }
}
