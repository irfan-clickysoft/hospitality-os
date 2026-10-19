import { HttpException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { money } from '../folio/schemas.js';
import { FolioService } from '../folio/folio.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const fmt = (m: bigint | string | number, cur: string) => ({ amount: Money.ofMinor(BigInt(m), cur).toDecimalString(), currency: cur });

export const Handover = z.object({
  amount: money, receivedByName: z.string().trim().min(2).max(120), receivedByTitle: z.string().trim().max(80).nullish(), note: z.string().trim().max(300).nullish(),
  /** The safe balance the screen showed. If the safe has changed since, the handover is refused and the new balance shown. */
  safeBefore: money,
});

/**
 * The property's safe: every closed register's takings (what was counted, less the float left in the drawer, plus anything dropped into the safe during the shift) go in as that
 * day's "envelope"; every handover to head office comes out. Never edited: a mistake is corrected by a later, explained handover.
 */
@Injectable()
export class CashHandoverService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(FolioService) private readonly folios: FolioService, @Inject(AuditService) private readonly audit: AuditService, @Inject(OutboxService) private readonly outbox: OutboxService) {}

  private async figures(trx: Parameters<Parameters<TenantDb['tx']>[0]>[0], propertyId: string) {
    const t = currentTenant().tenantId;
    const env = await sql<{ day: string; register_name: string; sessions: number; envelope: string; variance: string }>`
      SELECT s.opened_business_date::text AS day, s.register_name, count(*)::int AS sessions,
        sum(coalesce(s.counted_minor,0) - s.opening_float_minor + coalesce((SELECT sum(d.amount_minor) FROM cash_drop d WHERE d.tenant_id = s.tenant_id AND d.cashier_session_id = s.id),0))::text AS envelope,
        sum(coalesce(s.variance_minor,0))::text AS variance
      FROM cashier_session s WHERE s.tenant_id = ${t} AND s.property_id = ${propertyId} AND s.status IN ('CLOSED','REVIEWED')
      GROUP BY 1, 2 ORDER BY 1 DESC, 2`.execute(trx);
    const handed = (await sql<{ n: string }>`SELECT coalesce(sum(amount_minor),0)::text AS n FROM cash_handover WHERE tenant_id = ${t} AND property_id = ${propertyId}`.execute(trx)).rows[0]!.n;
    const total = env.rows.reduce((a, r) => a + BigInt(r.envelope), 0n);
    return { envelopes: env.rows, inSafe: total - BigInt(handed), handedTotal: BigInt(handed), collected: total };
  }

  async safe(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId); const c = p.currency;
      const f = await this.figures(trx, propertyId);
      const hs = await trx.selectFrom('cash_handover').selectAll().where('property_id', '=', propertyId).orderBy('created_at', 'desc').limit(30).execute();
      return { balance: fmt(f.inSafe, c), collected: fmt(f.collected, c), handedOver: fmt(f.handedTotal, c),
        envelopes: f.envelopes.slice(0, 60).map((e) => ({ date: e.day, register: e.register_name, sessions: e.sessions, amount: fmt(e.envelope, c), variance: fmt(e.variance, c) })),
        handovers: hs.map((h) => ({ id: h.id, date: h.business_date, amount: fmt(h.amount_minor, c), safeBefore: fmt(h.safe_before_minor, c), difference: fmt(h.difference_minor, c), receivedBy: h.received_by_name, receivedByTitle: h.received_by_title, note: h.note, createdAt: h.created_at })) };
    });
  }

  async handOver(propertyId: string, userId: string, i: z.infer<typeof Handover>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId); const c = p.currency;
      await sql`SELECT 1 FROM property WHERE tenant_id = ${currentTenant().tenantId} AND id = ${propertyId} FOR UPDATE`.execute(trx);     // one handover at a time per property
      const f = await this.figures(trx, propertyId);
      const amount = Money.parse(i.amount, c).minor, seen = Money.parse(i.safeBefore, c).minor;
      if (seen !== f.inSafe) throw fail(409, 'SAFE_CHANGED', 'The safe balance has changed since you looked. Check the new balance and try again.', { balance: fmt(f.inSafe, c) });
      if (amount <= 0n) throw fail(422, 'AMOUNT_INVALID', 'The amount must be more than zero');
      if (amount > f.inSafe) throw fail(422, 'HANDOVER_EXCEEDS_SAFE', 'That is more cash than the envelopes say the safe holds', { balance: fmt(f.inSafe, c) });
      const diff = amount - f.inSafe;
      if (diff !== 0n && (i.note?.length ?? 0) < 3) throw fail(422, 'NOTE_REQUIRED', 'Say why less than the whole safe is being handed over');
      const h = await trx.insertInto('cash_handover').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, business_date: p.business_date, amount_minor: amount.toString(), safe_before_minor: f.inSafe.toString(), difference_minor: diff.toString(),
        received_by_name: i.receivedByName, received_by_title: i.receivedByTitle ?? null, note: i.note ?? null, currency: c, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'cash.handover', resourceType: 'cash_handover', resourceId: h.id, propertyId, after: { amount: amount.toString(), safeBefore: f.inSafe.toString(), receivedBy: i.receivedByName }, ...(i.note ? { note: i.note } : {}) });
      await this.outbox.publish(trx, { aggregateType: 'cash_handover', aggregateId: h.id, eventType: 'CashHandedOver', propertyId, businessDate: p.business_date, payload: { handoverId: h.id, amountMinor: amount.toString(), currency: c, receivedBy: i.receivedByName } });
      return { id: h.id, balance: fmt(f.inSafe - amount, c) };
    });
  }
}
