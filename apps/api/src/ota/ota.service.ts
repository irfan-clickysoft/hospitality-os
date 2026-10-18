import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { CompaniesService, fail, fmt, type Trx } from '../companies/companies.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { FolioService } from '../folio/folio.service.js';
import { IdempotencyService, hashRequest } from '../idempotency/idempotency.service.js';
import { PaymentAccountsService } from '../payment-accounts/payment-accounts.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

type Row = Awaited<ReturnType<OtaService['row']>>;
const OPEN = ['CLAIMABLE', 'CLAIMED', 'DISPUTED'];

/** Fees an OTA owes the property. The amount leaves the guest's bill when claimed; from then on it is chased, received, disputed or written off, and every step is recorded. */
@Injectable()
export class OtaService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(FolioService) private readonly folios: FolioService,
    @Inject(CompaniesService) private readonly mfa: CompaniesService,
    @Inject(IdempotencyService) private readonly idem: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PaymentAccountsService) private readonly accounts: PaymentAccountsService,
  ) {}

  async row(trx: Trx, propertyId: string, id: string, lock = false) {
    let q = trx.selectFrom('ota_receivable').selectAll().where('id', '=', id).where('property_id', '=', propertyId);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'OTA claim not found' });
    return r;
  }
  private view(r: Row, bd?: string) {
    const remaining = OPEN.includes(r.status) ? BigInt(r.amount_minor) - BigInt(r.received_minor) - BigInt(r.written_off_minor) : 0n;
    const c = r.currency;
    const age = bd ? Math.max(0, Math.round((Date.parse(`${bd}T00:00:00Z`) - Date.parse(`${r.incurred_on}T00:00:00Z`)) / 86_400_000)) : null;
    return { id: r.id, propertyId: r.property_id, reservationId: r.reservation_id, confirmationNo: r.confirmation_no, otaRef: r.ota_ref, source: r.source, guest: r.guest_name, kind: r.kind, status: r.status,
      amount: fmt(r.amount_minor, c), received: fmt(r.received_minor, c), writtenOff: fmt(r.written_off_minor, c), remaining: fmt(remaining, c), claimRef: r.claim_ref, claimedOn: r.claimed_on, incurredOn: r.incurred_on, ageDays: age, note: r.note, version: r.version };
  }
  private async event(trx: Trx, id: string, action: string, bd: string, userId: string, e: { amount?: bigint; reference?: string | null; note?: string | null; accountId?: string | null } = {}) {
    await trx.insertInto('ota_receivable_event').values({ payment_account_id: e.accountId ?? null, tenant_id: currentTenant().tenantId, receivable_id: id, action, amount_minor: e.amount?.toString() ?? null, reference: e.reference ?? null, note: e.note ?? null, business_date: bd, actor_id: userId } as never).execute();
  }

  // ───────────── moving a fee off the guest's bill ─────────────
  async claim(propertyId: string, reservationId: string, userId: string, key: string, i: z.infer<typeof S.ClaimFee>) {
    const hash = hashRequest('POST', `/v1/properties/${propertyId}/reservations/${reservationId}/ota-claim`, i);
    return this.tdb.tx(async (trx) => {
      const r = await this.idem.run(trx, key, hash, async () => ({ statusCode: 201, body: await this.claimIn(trx, propertyId, reservationId, userId, i) }));
      return { ...r.body, replayed: r.replayed };
    });
  }
  private async claimIn(trx: Trx, propertyId: string, reservationId: string, userId: string, i: z.infer<typeof S.ClaimFee>) {
    const p = await this.folios.property(trx, propertyId);
    const res = await trx.selectFrom('reservation as r').innerJoin('guest as g', 'g.id', 'r.guest_id').select(['r.id', 'r.source', 'r.external_ref', 'r.confirmation_no', 'r.penalty_minor', 'g.full_name']).where('r.id', '=', reservationId).where('r.property_id', '=', propertyId).executeTakeFirst();
    if (!res) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Reservation not found' });
    if (res.source !== 'OTA_BOOKING_COM' && res.source !== 'OTA_OTHER') throw fail(422, 'NOT_AN_OTA_BOOKING', 'Only a booking that came from an OTA can be claimed from the OTA');
    const folio = await this.folios.ensureGuestFolio(trx, propertyId, reservationId);
    const f = await this.folios.folioRow(trx, propertyId, folio.id, true);
    if (f.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'This folio is closed');
    const balance = BigInt(f.balance_minor);
    if (balance <= 0n) throw fail(422, 'NOTHING_TO_CLAIM', 'There is nothing owing on this bill');
    const penalty = BigInt(res.penalty_minor);
    const amount = i.amount ? Money.parse(i.amount, f.currency).minor : penalty > 0n && penalty <= balance ? penalty : balance;
    if (amount <= 0n) throw fail(422, 'AMOUNT_INVALID', 'The amount must be more than zero');
    if (amount > balance) throw fail(422, 'AMOUNT_TOO_LARGE', 'That is more than the bill', { balance: fmt(balance, f.currency) });
    const postingId = await this.folios.post(trx, { folioId: f.id, propertyId, currency: f.currency, type: 'PAYMENT', txnCode: 'OTA_TRANSFER', amount: -amount, businessDate: p.business_date, sourceType: 'OTA',
      description: `Claimed from ${res.source === 'OTA_BOOKING_COM' ? 'Booking.com' : 'the OTA'}`, note: i.note ?? undefined, userId });
    const rec = await trx.insertInto('ota_receivable').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, reservation_id: reservationId, folio_id: f.id, posting_id: postingId, source: res.source, ota_ref: res.external_ref,
      confirmation_no: res.confirmation_no, guest_name: res.full_name, kind: i.kind, amount_minor: amount.toString(), currency: f.currency, incurred_on: p.business_date, note: i.note ?? null, created_by: userId } as never).returningAll().executeTakeFirstOrThrow();
    await this.event(trx, rec.id, 'CREATE', p.business_date, userId, { amount, note: i.note });
    await this.audit.record(trx, { action: 'ota.claim_create', resourceType: 'ota_receivable', resourceId: rec.id, propertyId, after: { reservationId, kind: i.kind, amount: amount.toString() } });
    await this.outbox.publish(trx, { aggregateType: 'ota_receivable', aggregateId: rec.id, eventType: 'OtaReceivableCreated', propertyId, businessDate: p.business_date, payload: { receivableId: rec.id, reservationId, amountMinor: amount.toString(), kind: i.kind, currency: f.currency } });
    return { claim: this.view(rec, p.business_date), balance: fmt((await this.folios.folioRow(trx, propertyId, f.id)).balance_minor, f.currency) };
  }

  /** A claim made by mistake, before it was sent to the OTA, goes back on the guest's bill. */
  async voidClaim(propertyId: string, id: string, userId: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      const r = await this.row(trx, propertyId, id, true);
      if (r.status !== 'CLAIMABLE') throw fail(409, 'WRONG_STATE', 'Only a claim that has not been sent to the OTA can be taken back');
      const p = await this.folios.property(trx, propertyId);
      const f = await this.folios.folioRow(trx, propertyId, r.folio_id, true);
      if (f.status === 'CLOSED') await trx.updateTable('folio').set({ status: 'OPEN', closed_at: null }).where('id', '=', f.id).execute();
      await this.folios.post(trx, { folioId: f.id, propertyId, currency: f.currency, type: 'REVERSAL', txnCode: 'OTA_TRANSFER', amount: BigInt(r.amount_minor), businessDate: p.business_date, sourceType: 'REVERSAL', reversesId: r.posting_id,
        description: 'Reversal: claimed from OTA', reasonCode: 'OTA_VOID', note: reason, userId });
      const u = await trx.updateTable('ota_receivable').set({ status: 'VOID', version: sql`version + 1` as never } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.event(trx, id, 'VOID', p.business_date, userId, { note: reason });
      await this.audit.record(trx, { action: 'ota.claim_void', resourceType: 'ota_receivable', resourceId: id, propertyId, before: { amount: r.amount_minor }, reasonCode: 'OTA_VOID', note: reason });
      return this.view(u, p.business_date);
    });
  }

  // ───────────── chasing it ─────────────
  async markClaimed(propertyId: string, id: string, userId: string, i: z.infer<typeof S.MarkClaimed>) {
    return this.step(propertyId, id, userId, async (trx, r, bd) => {
      if (r.status !== 'CLAIMABLE') throw fail(409, 'WRONG_STATE', 'This claim was already sent to the OTA');
      await this.event(trx, id, 'CLAIM', bd, userId, { reference: i.claimRef });
      return { status: 'CLAIMED', claim_ref: i.claimRef ?? null, claimed_on: i.claimedOn ?? bd };
    });
  }
  async receive(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Receive>) {
    return this.step(propertyId, id, userId, async (trx, r, bd) => {
      if (r.status !== 'CLAIMED' && r.status !== 'DISPUTED') throw fail(409, 'WRONG_STATE', 'Send the claim to the OTA before recording money from it');
      const amt = Money.parse(i.amount, r.currency).minor;
      const remaining = BigInt(r.amount_minor) - BigInt(r.received_minor) - BigInt(r.written_off_minor);
      if (amt <= 0n) throw fail(422, 'AMOUNT_INVALID', 'The amount must be more than zero');
      if (amt > remaining) throw fail(422, 'AMOUNT_TOO_LARGE', 'That is more than is still owed', { remaining: fmt(remaining, r.currency) });
      const accountId = await this.accounts.resolve(trx, propertyId, 'BANK_TRANSFER', i.paymentAccountId, r.currency);
      await this.event(trx, id, 'RECEIVE', i.receivedOn ?? bd, userId, { amount: amt, reference: i.reference, note: i.note, accountId });
      const done = amt === remaining;
      return { received_minor: (BigInt(r.received_minor) + amt).toString(), status: done ? (BigInt(r.written_off_minor) > 0n ? 'WRITTEN_OFF' : 'RECEIVED') : r.status };
    });
  }
  async dispute(propertyId: string, id: string, userId: string, reason: string) {
    return this.step(propertyId, id, userId, async (trx, r, bd) => {
      if (r.status !== 'CLAIMED') throw fail(409, 'WRONG_STATE', 'Only a claim sent to the OTA can be disputed');
      await this.event(trx, id, 'DISPUTE', bd, userId, { note: reason });
      return { status: 'DISPUTED' };
    });
  }
  async resolve(propertyId: string, id: string, userId: string, note: string) {
    return this.step(propertyId, id, userId, async (trx, r, bd) => {
      if (r.status !== 'DISPUTED') throw fail(409, 'WRONG_STATE', 'This claim is not in dispute');
      await this.event(trx, id, 'RESOLVE', bd, userId, { note });
      return { status: 'CLAIMED' };
    });
  }
  /** The money will not come. A manager’s decision: it needs a reason and a fresh second factor. */
  async writeOff(propertyId: string, id: string, userId: string, i: z.infer<typeof S.WriteOff>) {
    this.mfa.requireFreshMfa();
    return this.step(propertyId, id, userId, async (trx, r, bd) => {
      if (!OPEN.includes(r.status)) throw fail(409, 'WRONG_STATE', 'This claim is already settled');
      const remaining = BigInt(r.amount_minor) - BigInt(r.received_minor) - BigInt(r.written_off_minor);
      const amt = i.amount ? Money.parse(i.amount, r.currency).minor : remaining;
      if (amt <= 0n || amt > remaining) throw fail(422, 'AMOUNT_INVALID', 'The write-off must be more than zero and no more than is still owed', { remaining: fmt(remaining, r.currency) });
      await this.event(trx, id, 'WRITE_OFF', bd, userId, { amount: amt, note: i.reason });
      await this.audit.record(trx, { action: 'ota.writeoff', resourceType: 'ota_receivable', resourceId: id, propertyId, before: { remaining: remaining.toString() }, after: { writtenOff: amt.toString() }, reasonCode: 'OTA_WRITE_OFF', note: i.reason });
      return { written_off_minor: (BigInt(r.written_off_minor) + amt).toString(), status: amt === remaining ? 'WRITTEN_OFF' : r.status };
    });
  }
  private async step(propertyId: string, id: string, userId: string, fn: (trx: Trx, r: Row, bd: string) => Promise<Record<string, unknown>>) {
    return this.tdb.tx(async (trx) => {
      const r = await this.row(trx, propertyId, id, true);
      const p = await this.folios.property(trx, propertyId);
      const set = await fn(trx, r, p.business_date);
      const u = await trx.updateTable('ota_receivable').set({ ...set, version: sql`version + 1` as never } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: `ota.${String(set.status ?? r.status).toLowerCase()}`, resourceType: 'ota_receivable', resourceId: id, propertyId, before: { status: r.status }, after: set });
      if (set.status === 'RECEIVED' || set.received_minor) await this.outbox.publish(trx, { aggregateType: 'ota_receivable', aggregateId: id, eventType: 'OtaMoneyReceived', propertyId, businessDate: p.business_date, payload: { receivableId: id, receivedMinor: u.received_minor, currency: u.currency } });
      return this.view(u, p.business_date);
    });
  }

  // ───────────── reading ─────────────
  async list(propertyId: string, q: z.infer<typeof S.ListQuery>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      let qb = trx.selectFrom('ota_receivable').selectAll().where('property_id', '=', propertyId).orderBy('incurred_on').orderBy('created_at').limit(q.limit);
      if (q.status === 'OPEN') qb = qb.where('status', 'in', OPEN as never); else if (q.status) qb = qb.where('status', '=', q.status);
      const rows = await qb.execute();
      const agg = await sql<{ status: string; n: number; remaining: string }>`SELECT status, count(*)::int AS n, coalesce(sum(amount_minor - received_minor - written_off_minor),0)::text AS remaining
        FROM ota_receivable WHERE tenant_id = ${currentTenant().tenantId} AND property_id = ${propertyId} GROUP BY status`.execute(trx);
      const openTotal = agg.rows.filter((a) => OPEN.includes(a.status)).reduce((s, a) => s + BigInt(a.remaining), 0n);
      return { items: rows.map((r) => this.view(r, p.business_date)), openTotal: fmt(openTotal, p.currency), counts: Object.fromEntries(agg.rows.map((a) => [a.status, a.n])) };
    });
  }
  /** What the OTAs owe, by how long it has been owed. */
  async ageing(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const rows = await sql<{ b0: string; b1: string; b2: string; b3: string }>`
        SELECT coalesce(sum(o) FILTER (WHERE age <= 30),0)::text AS b0, coalesce(sum(o) FILTER (WHERE age BETWEEN 31 AND 60),0)::text AS b1, coalesce(sum(o) FILTER (WHERE age BETWEEN 61 AND 90),0)::text AS b2, coalesce(sum(o) FILTER (WHERE age > 90),0)::text AS b3
        FROM (SELECT amount_minor - received_minor - written_off_minor AS o, (${p.business_date}::date - incurred_on) AS age FROM ota_receivable WHERE tenant_id = ${currentTenant().tenantId} AND property_id = ${propertyId} AND status IN ('CLAIMABLE','CLAIMED','DISPUTED')) x`.execute(trx);
      const b = rows.rows[0]!;
      return { asOf: p.business_date, buckets: { d0_30: fmt(b.b0, p.currency), d31_60: fmt(b.b1, p.currency), d61_90: fmt(b.b2, p.currency), d90plus: fmt(b.b3, p.currency) }, total: fmt(BigInt(b.b0) + BigInt(b.b1) + BigInt(b.b2) + BigInt(b.b3), p.currency) };
    });
  }
  async history(propertyId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const r = await this.row(trx, propertyId, id);
      const ev = await trx.selectFrom('ota_receivable_event').selectAll().where('receivable_id', '=', id).orderBy('at').execute();
      return { claim: this.view(r, p.business_date), events: ev.map((e) => ({ action: e.action, amount: e.amount_minor === null ? null : fmt(e.amount_minor, r.currency), reference: e.reference, note: e.note, businessDate: e.business_date, at: e.at, actorId: e.actor_id })) };
    });
  }
  async forReservation(propertyId: string, reservationId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const rows = await trx.selectFrom('ota_receivable').selectAll().where('property_id', '=', propertyId).where('reservation_id', '=', reservationId).orderBy('created_at').execute();
      return { items: rows.map((r) => this.view(r, p.business_date)) };
    });
  }
}
