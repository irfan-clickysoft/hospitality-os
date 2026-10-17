import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import type { DB } from '@hos/db';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { TenantDb } from '../db/tenant-db.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';
import { SYSTEM_CODES } from './txn-codes.js';

export type Trx = Transaction<DB>;
export const fmt = (m: bigint | string | number, cur: string) => ({ amount: Money.ofMinor(BigInt(m), cur).toDecimalString(), currency: cur });
const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);

export interface PostArgs {
  folioId: string; propertyId: string; currency: string; type: 'CHARGE' | 'TAX' | 'DISCOUNT' | 'PAYMENT' | 'DEPOSIT_RECEIVED' | 'REFUND' | 'ADJUSTMENT' | 'REVERSAL';
  txnCode: string; amount: bigint; businessDate: string; sourceType: string; description?: string; quantity?: number; unitPrice?: bigint; sourceRef?: string;
  parentId?: string; reversesId?: string; paymentId?: string; sessionId?: string | null; lineId?: string; reasonCode?: string; note?: string; idempotencyKey?: string; userId?: string;
}

@Injectable()
export class FolioService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  async property(trx: Trx, id: string) {
    const p = await trx.selectFrom('property').select(['id', 'code', 'currency', 'business_date']).where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return p;
  }
  async folioRow(trx: Trx, propertyId: string, folioId: string, lock = false) {
    let q = trx.selectFrom('folio').selectAll().where('id', '=', folioId).where('property_id', '=', propertyId);
    if (lock) q = q.forUpdate();
    const f = await q.executeTakeFirst();
    if (!f) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Folio not found' });
    return f;
  }

  /** The one guest folio of a reservation, created on first need (deposit, check-in, penalty). */
  async ensureGuestFolio(trx: Trx, propertyId: string, reservationId: string) {
    const existing = await trx.selectFrom('folio').selectAll().where('reservation_id', '=', reservationId).where('folio_type', '=', 'GUEST').where('status', '<>', 'VOID').executeTakeFirst();
    if (existing) return existing;
    const r = await trx.selectFrom('reservation').select(['guest_id', 'currency', 'company_id']).where('id', '=', reservationId).where('property_id', '=', propertyId).executeTakeFirst();
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Reservation not found' });
    const p = await this.property(trx, propertyId);
    const seq = (await sql<{ v: string }>`INSERT INTO property_counter (tenant_id, property_id, name, value) VALUES (${currentTenant().tenantId}, ${propertyId}, 'folio', 1)
      ON CONFLICT (tenant_id, property_id, name) DO UPDATE SET value = property_counter.value + 1 RETURNING value::text AS v`.execute(trx)).rows[0]!.v;
    try {
      return await trx.insertInto('folio').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, folio_no: `${p.code}-F${seq.padStart(6, '0')}`, folio_type: 'GUEST',
        reservation_id: reservationId, guest_id: r.guest_id, company_id: r.company_id, currency: r.currency } as never).returningAll().executeTakeFirstOrThrow();
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return trx.selectFrom('folio').selectAll().where('reservation_id', '=', reservationId).where('folio_type', '=', 'GUEST').where('status', '<>', 'VOID').executeTakeFirstOrThrow();
      throw e;
    }
  }

  /** The only way money moves. Appends to the immutable ledger; the folio balance moves with it inside the database. */
  async post(trx: Trx, a: PostArgs): Promise<string> {
    const row = await trx.insertInto('folio_posting').values({
      tenant_id: currentTenant().tenantId, property_id: a.propertyId, folio_id: a.folioId, posting_type: a.type, txn_code: a.txnCode, description: a.description ?? null,
      amount_minor: a.amount.toString(), currency: a.currency, quantity: String(a.quantity ?? 1), unit_price_minor: a.unitPrice?.toString() ?? null, business_date: a.businessDate,
      source_type: a.sourceType, source_ref: a.sourceRef ?? null, parent_posting_id: a.parentId ?? null, reverses_posting_id: a.reversesId ?? null, payment_id: a.paymentId ?? null,
      cashier_session_id: a.sessionId ?? null, reservation_room_id: a.lineId ?? null, reason_code: a.reasonCode ?? null, note: a.note ?? null, idempotency_key: a.idempotencyKey ?? null,
      created_by: a.userId ?? currentTenant().actorId ?? null,
    } as never).returning('id').executeTakeFirstOrThrow();
    return row.id;
  }

  // ───────────── room nights ─────────────
  /**
   * Posts the room charges of a stay line for every night up to and including `upTo` that is not on the folio yet. Safe to repeat (the ledger has one
   * room charge per night per code). The nightly audit will call this for each in-house line; check-out calls it to catch up anything missed.
   */
  async postRoomNights(trx: Trx, propertyId: string, line: { id: string; reservation_id: string }, upTo: string, userId?: string): Promise<{ posted: number; total: bigint }> {
    const p = await this.property(trx, propertyId);
    const folio = await this.ensureGuestFolio(trx, propertyId, line.reservation_id);
    await this.folioRow(trx, propertyId, folio.id, true);
    const nights = await trx.selectFrom('stay_night').selectAll().where('reservation_room_id', '=', line.id).where('business_date', '<=', upTo).orderBy('business_date').execute();
    if (!nights.length) return { posted: 0, total: 0n };
    const done = new Set((await trx.selectFrom('folio_posting').select('source_ref').where('folio_id', '=', folio.id).where('source_type', '=', 'ROOM_NIGHT')
      .where('source_ref', 'in', nights.map((n) => `${line.id}:${n.business_date}`)).execute()).map((x) => x.source_ref));
    let posted = 0, total = 0n;
    for (const n of nights) {
      const ref = `${line.id}:${n.business_date}`;
      if (done.has(ref)) continue;
      const date = n.business_date < p.business_date ? p.business_date : n.business_date;       // a night that was never audited lands on today, never on a closed date
      const base = { folioId: folio.id, propertyId, currency: folio.currency, businessDate: date, sourceType: 'ROOM_NIGHT', sourceRef: ref, lineId: line.id, userId, note: n.business_date < p.business_date ? `Night of ${n.business_date}` : undefined };
      const room = BigInt(n.room_minor), extras = BigInt(n.extras_minor), disc = BigInt(n.discount_minor);
      if (room > 0n) await this.post(trx, { ...base, type: 'CHARGE', txnCode: 'ROOM', amount: room, description: `Room ${n.business_date}` });
      if (extras > 0n) await this.post(trx, { ...base, type: 'CHARGE', txnCode: 'ROOM_EXTRAS', amount: extras, description: `Room extras ${n.business_date}` });
      if (disc > 0n) await this.post(trx, { ...base, type: 'DISCOUNT', txnCode: 'ROOM_DISCOUNT', amount: -disc, description: `Room discount ${n.business_date}` });
      posted++; total += room + extras - disc;
    }
    return { posted, total };
  }

  // ───────────── read ─────────────
  async forReservation(propertyId: string, reservationId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.property(trx, propertyId);
      const res = await trx.selectFrom('reservation').select(['id', 'confirmation_no', 'currency']).where('id', '=', reservationId).where('property_id', '=', propertyId).executeTakeFirst();
      if (!res) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Reservation not found' });
      const folio = await trx.selectFrom('folio').selectAll().where('reservation_id', '=', reservationId).where('folio_type', '=', 'GUEST').where('status', '<>', 'VOID').executeTakeFirst();
      const cur = res.currency;
      const lines = await trx.selectFrom('reservation_room').select(['id', 'status', 'arrival', 'departure', 'total_minor']).where('reservation_id', '=', reservationId).execute();
      const live = lines.filter((l) => l.status === 'CHECKED_IN');
      const postings = folio ? await trx.selectFrom('folio_posting').selectAll().where('folio_id', '=', folio.id).orderBy('posted_at').orderBy('id').execute() : [];
      const payments = folio ? await trx.selectFrom('payment').selectAll().where('folio_id', '=', folio.id).orderBy('created_at').execute() : [];
      const posted = new Set(postings.filter((x) => x.source_type === 'ROOM_NIGHT').map((x) => x.source_ref));
      const nights = live.length ? await trx.selectFrom('stay_night').select(['reservation_room_id', 'business_date', 'total_minor']).where('reservation_room_id', 'in', live.map((l) => l.id)).orderBy('business_date').execute() : [];
      const unposted = nights.filter((n) => !posted.has(`${n.reservation_room_id}:${n.business_date}`));
      const due = unposted.filter((n) => n.business_date <= p.business_date);
      const sum = (xs: Array<{ total_minor: string }>) => xs.reduce((a, x) => a + BigInt(x.total_minor), 0n);
      const reversed = new Set(postings.filter((x) => x.reverses_posting_id).map((x) => x.reverses_posting_id));
      const balance = BigInt(folio?.balance_minor ?? '0');
      return {
        reservationId, confirmationNo: res.confirmation_no,
        folio: folio ? { id: folio.id, folioNo: folio.folio_no, status: folio.status, currency: cur, balance: fmt(balance, cur), version: folio.version } : null,
        projection: { unpostedDue: fmt(sum(due), cur), unpostedRemainingStay: fmt(sum(unposted), cur), balanceAfterDue: fmt(balance + sum(due), cur), balanceAtEndOfStay: fmt(balance + sum(unposted), cur), unpostedNights: unposted.length },
        postings: postings.map((x) => ({ id: x.id, type: x.posting_type, txnCode: x.txn_code, description: x.description, amount: fmt(x.amount_minor, cur), quantity: Number(x.quantity), businessDate: x.business_date, postedAt: x.posted_at,
          sourceType: x.source_type, parentId: x.parent_posting_id, reversesId: x.reverses_posting_id, reversed: reversed.has(x.id), paymentId: x.payment_id, reason: x.note, createdBy: x.created_by })),
        payments: payments.map((x) => this.paymentView(x, cur)),
      };
    });
  }
  paymentView(x: { id: string; kind: string; method: string; status: string; amount_minor: string; reference: string | null; card_last4: string | null; approval_code: string | null; counterparty: string | null; note: string | null; business_date: string; created_by: string; created_at: Date; verified_by: string | null; refund_of_payment_id: string | null; void_reason: string | null; cashier_session_id: string | null }, cur: string) {
    return { id: x.id, kind: x.kind, method: x.method, status: x.status, amount: fmt(x.amount_minor, cur), reference: x.reference, cardLast4: x.card_last4, approvalCode: x.approval_code, counterparty: x.counterparty,
      note: x.note, businessDate: x.business_date, createdBy: x.created_by, createdAt: x.created_at, verifiedBy: x.verified_by, refundOf: x.refund_of_payment_id, voidReason: x.void_reason, cashierSessionId: x.cashier_session_id };
  }

  // ───────────── manual charges, discounts, reversals ─────────────
  async charge(propertyId: string, folioId: string, userId: string, i: z.infer<typeof S.ManualCharge>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.property(trx, propertyId);
      const f = await this.folioRow(trx, propertyId, folioId, true);
      if (f.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'This folio is closed');
      const unit = Money.parse(i.amount, f.currency).minor;
      const qtyMilli = BigInt(Math.round(i.quantity * 1000));
      const total = (unit * qtyMilli + 500n) / 1000n;
      if (total <= 0n) throw fail(422, 'AMOUNT_INVALID', 'The charge must be more than zero');
      const d = await this.authz.check(userId, { permission: 'folio.post', scope: { propertyId }, amountMinor: total });
      if (d.effect !== 'ALLOW') throw fail(403, 'APPROVAL_REQUIRED', 'This charge is above your posting limit and needs a manager');
      const id = await this.post(trx, { folioId, propertyId, currency: f.currency, type: 'CHARGE', txnCode: i.txnCode, amount: total, quantity: i.quantity, unitPrice: unit, businessDate: p.business_date,
        sourceType: 'MANUAL', description: i.description, note: i.note ?? undefined, userId });
      await this.audit.record(trx, { action: 'folio.charge', resourceType: 'folio', resourceId: folioId, propertyId, after: { postingId: id, txnCode: i.txnCode, total: total.toString() } });
      await this.outbox.publish(trx, { aggregateType: 'folio', aggregateId: folioId, eventType: 'FolioPosted', propertyId, businessDate: p.business_date, payload: { folioId, postingId: id, txnCode: i.txnCode, amountMinor: total.toString(), currency: f.currency } });
      return { postingId: id, total: fmt(total, f.currency), balance: fmt((await this.folioRow(trx, propertyId, folioId)).balance_minor, f.currency) };
    });
  }

  async discount(propertyId: string, folioId: string, postingId: string, userId: string, i: z.infer<typeof S.DiscountPosting>) {
    const d = await this.authz.check(userId, { permission: 'folio.post', scope: { propertyId }, discountPct: i.pct });
    if (d.effect !== 'ALLOW') throw fail(403, 'APPROVAL_REQUIRED', 'This discount is above your limit and needs a manager');
    return this.tdb.tx(async (trx) => {
      const p = await this.property(trx, propertyId);
      const f = await this.folioRow(trx, propertyId, folioId, true);
      if (f.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'This folio is closed');
      const orig = await trx.selectFrom('folio_posting').selectAll().where('id', '=', postingId).where('folio_id', '=', folioId).executeTakeFirst();
      if (!orig) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Posting not found' });
      if (orig.posting_type !== 'CHARGE') throw fail(422, 'NOT_DISCOUNTABLE', 'Only charges can be discounted');
      if (await trx.selectFrom('folio_posting').select('id').where('reverses_posting_id', '=', postingId).executeTakeFirst()) throw fail(409, 'ALREADY_REVERSED', 'This charge was reversed');
      const bp = BigInt(Math.round(i.pct * 100));
      const prior = (await trx.selectFrom('folio_posting').select('amount_minor').where('parent_posting_id', '=', postingId).where('posting_type', '=', 'DISCOUNT').execute()).reduce((a, x) => a + -BigInt(x.amount_minor), 0n);
      const amount = (BigInt(orig.amount_minor) * bp) / 10000n;
      if (amount <= 0n) throw fail(422, 'AMOUNT_INVALID', 'That discount rounds to nothing');
      if (prior + amount > BigInt(orig.amount_minor)) throw fail(422, 'DISCOUNT_TOO_LARGE', 'Discounts on this charge would exceed the charge');
      const id = await this.post(trx, { folioId, propertyId, currency: f.currency, type: 'DISCOUNT', txnCode: 'DISCOUNT', amount: -amount, businessDate: p.business_date, sourceType: 'MANUAL', parentId: postingId,
        description: `Discount ${i.pct}% on ${orig.description ?? orig.txn_code}`, reasonCode: 'DISCOUNT', note: i.reason, userId });
      await this.audit.record(trx, { action: 'folio.discount', resourceType: 'folio', resourceId: folioId, propertyId, after: { postingId: id, parent: postingId, pct: i.pct, amount: amount.toString() }, reasonCode: 'DISCOUNT', note: i.reason });
      return { postingId: id, discount: fmt(amount, f.currency), balance: fmt((await this.folioRow(trx, propertyId, folioId)).balance_minor, f.currency) };
    });
  }

  /** Corrections never edit: a reversal posting cancels the original (and anything hanging off it), and the original stays visible. */
  async reverse(propertyId: string, folioId: string, postingId: string, userId: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.property(trx, propertyId);
      const f = await this.folioRow(trx, propertyId, folioId, true);
      if (f.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'This folio is closed');
      const orig = await trx.selectFrom('folio_posting').selectAll().where('id', '=', postingId).where('folio_id', '=', folioId).executeTakeFirst();
      if (!orig) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Posting not found' });
      if (['PAYMENT', 'DEPOSIT_RECEIVED', 'REFUND', 'REVERSAL'].includes(orig.posting_type)) throw fail(422, 'USE_PAYMENT_FLOW', 'Payments are cancelled by voiding or refunding the payment, not by reversing the posting');
      const children = await trx.selectFrom('folio_posting').selectAll().where('parent_posting_id', '=', postingId).execute();
      const all = [orig, ...children];
      const already = await trx.selectFrom('folio_posting').select('reverses_posting_id').where('reverses_posting_id', 'in', all.map((x) => x.id)).execute();
      const doneIds = new Set(already.map((x) => x.reverses_posting_id));
      if (doneIds.has(orig.id)) throw fail(409, 'ALREADY_REVERSED', 'This posting was already reversed');
      const ids: string[] = [];
      for (const x of all) {
        if (doneIds.has(x.id)) continue;
        ids.push(await this.post(trx, { folioId, propertyId, currency: f.currency, type: 'REVERSAL', txnCode: x.txn_code, amount: -BigInt(x.amount_minor), businessDate: p.business_date, sourceType: 'REVERSAL',
          reversesId: x.id, parentId: x.id === orig.id ? undefined : ids[0], description: `Reversal: ${x.description ?? x.txn_code}`, reasonCode: 'REVERSAL', note: reason, userId, lineId: x.reservation_room_id ?? undefined }));
      }
      await this.audit.record(trx, { action: 'folio.reverse', resourceType: 'folio', resourceId: folioId, propertyId, before: { postingId, txnCode: orig.txn_code, amount: orig.amount_minor }, after: { reversals: ids }, reasonCode: 'REVERSAL', note: reason });
      await this.outbox.publish(trx, { aggregateType: 'folio', aggregateId: folioId, eventType: 'FolioPostingReversed', propertyId, businessDate: p.business_date, payload: { folioId, postingId, reversals: ids, reason } });
      return { reversals: ids, balance: fmt((await this.folioRow(trx, propertyId, folioId)).balance_minor, f.currency) };
    });
  }

  // ───────────── close / reopen ─────────────
  async closeIn(trx: Trx, propertyId: string, folioId: string, userId: string) {
    const f = await this.folioRow(trx, propertyId, folioId, true);
    if (f.status === 'CLOSED') return f;
    if (f.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'This folio cannot be closed');
    if (BigInt(f.balance_minor) !== 0n) throw fail(409, 'BALANCE_DUE', `The folio balance is ${fmt(f.balance_minor, f.currency).amount}. Settle it before closing.`, { balance: fmt(f.balance_minor, f.currency) });
    if (f.reservation_id) {
      const open = await trx.selectFrom('reservation_room').select('id').where('reservation_id', '=', f.reservation_id).where('status', 'in', ['CHECKED_IN', 'CONFIRMED', 'OPTION']).executeTakeFirst();
      if (open) throw fail(409, 'STAY_NOT_FINISHED', 'Some rooms on this reservation are still to arrive or in the house');
    }
    await trx.updateTable('folio').set({ status: 'CLOSED', closed_at: new Date(this.clock.now()), version: sql`version + 1` as never }).where('id', '=', folioId).execute();
    await this.audit.record(trx, { action: 'folio.close', resourceType: 'folio', resourceId: folioId, propertyId });
    await this.outbox.publish(trx, { aggregateType: 'folio', aggregateId: folioId, eventType: 'FolioClosed', propertyId, payload: { folioId, reservationId: f.reservation_id } });
    return { ...f, status: 'CLOSED' as const };
  }
  async close(propertyId: string, folioId: string, userId: string) {
    return this.tdb.tx(async (trx) => { const f = await this.closeIn(trx, propertyId, folioId, userId); return { id: folioId, status: f.status }; });
  }
  async reopen(propertyId: string, folioId: string, userId: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      const f = await this.folioRow(trx, propertyId, folioId, true);
      if (f.status !== 'CLOSED') throw fail(409, 'FOLIO_NOT_CLOSED', 'Only a closed folio can be reopened');
      await trx.updateTable('folio').set({ status: 'OPEN', closed_at: null, version: sql`version + 1` as never }).where('id', '=', folioId).execute();
      await this.audit.record(trx, { action: 'folio.reopen', resourceType: 'folio', resourceId: folioId, propertyId, note: reason });
      return { id: folioId, status: 'OPEN' };
    });
  }

  // ───────────── penalties (called by reservations) ─────────────
  async postPenalty(trx: Trx, propertyId: string, reservationId: string, kind: 'CANCEL_FEE' | 'NOSHOW_FEE', amount: bigint, cumulative: bigint, userId: string) {
    if (amount <= 0n) return;
    const p = await this.property(trx, propertyId);
    const f = await this.ensureGuestFolio(trx, propertyId, reservationId);
    await this.folioRow(trx, propertyId, f.id, true);
    if (f.status === 'CLOSED') await trx.updateTable('folio').set({ status: 'OPEN', closed_at: null }).where('id', '=', f.id).execute();      // a late fee can follow a settled booking
    await this.post(trx, { folioId: f.id, propertyId, currency: f.currency, type: 'CHARGE', txnCode: kind, amount, businessDate: p.business_date, sourceType: 'PENALTY',
      idempotencyKey: `penalty:${reservationId}:${kind}:${cumulative}`, description: SYSTEM_CODES[kind], userId });
  }
  async reversePenalties(trx: Trx, propertyId: string, reservationId: string, userId: string, reason: string) {
    const f = await trx.selectFrom('folio').selectAll().where('reservation_id', '=', reservationId).where('folio_type', '=', 'GUEST').where('status', '<>', 'VOID').executeTakeFirst();
    if (!f) return;
    const pen = await trx.selectFrom('folio_posting').selectAll().where('folio_id', '=', f.id).where('source_type', '=', 'PENALTY').where('posting_type', '=', 'CHARGE').execute();
    if (!pen.length) return;
    const done = new Set((await trx.selectFrom('folio_posting').select('reverses_posting_id').where('reverses_posting_id', 'in', pen.map((x) => x.id)).execute()).map((x) => x.reverses_posting_id));
    const p = await this.property(trx, propertyId);
    await this.folioRow(trx, propertyId, f.id, true);
    if (f.status === 'CLOSED') await trx.updateTable('folio').set({ status: 'OPEN', closed_at: null }).where('id', '=', f.id).execute();
    for (const x of pen) if (!done.has(x.id)) await this.post(trx, { folioId: f.id, propertyId, currency: f.currency, type: 'REVERSAL', txnCode: x.txn_code, amount: -BigInt(x.amount_minor), businessDate: p.business_date,
      sourceType: 'REVERSAL', reversesId: x.id, description: `Reversal: ${x.description}`, reasonCode: 'REINSTATED', note: reason, userId });
  }

  // ───────────── invariants ─────────────
  /** The ledger must agree with itself. Reports problems; never repairs. */
  async checkInvariants(propertyId: string): Promise<Array<{ kind: string; detail: string }>> {
    return this.tdb.tx(async (trx) => {
      await this.property(trx, propertyId);
      const t = currentTenant().tenantId;
      const out: Array<{ kind: string; detail: string }> = [];
      const bal = await sql<{ folio_no: string; cached: string; actual: string }>`SELECT f.folio_no, f.balance_minor::text AS cached, coalesce(sum(p.amount_minor),0)::text AS actual FROM folio f
        LEFT JOIN folio_posting p ON p.tenant_id = f.tenant_id AND p.folio_id = f.id WHERE f.tenant_id = ${t} AND f.property_id = ${propertyId} GROUP BY f.tenant_id, f.id HAVING f.balance_minor <> coalesce(sum(p.amount_minor),0)`.execute(trx);
      for (const r of bal.rows) out.push({ kind: 'BALANCE_MISMATCH', detail: `${r.folio_no}: cached ${r.cached}, postings ${r.actual}` });
      const pay = await sql<{ id: string; amount: string; posted: string; kind: string }>`SELECT p.id, p.amount_minor::text AS amount, p.kind, coalesce(sum(abs(fp.amount_minor)) FILTER (WHERE fp.posting_type <> 'REVERSAL'),0)::text AS posted
        FROM payment p LEFT JOIN folio_posting fp ON fp.tenant_id = p.tenant_id AND fp.payment_id = p.id WHERE p.tenant_id = ${t} AND p.property_id = ${propertyId} AND p.status IN ('CAPTURED','VOIDED')
        GROUP BY p.tenant_id, p.id HAVING p.amount_minor <> coalesce(sum(abs(fp.amount_minor)) FILTER (WHERE fp.posting_type <> 'REVERSAL'),0)`.execute(trx);
      for (const r of pay.rows) out.push({ kind: 'PAYMENT_POSTING_MISMATCH', detail: `payment ${r.id}: amount ${r.amount}, posted ${r.posted}` });
      const unposted = await sql<{ id: string }>`SELECT p.id FROM payment p WHERE p.tenant_id = ${t} AND p.property_id = ${propertyId} AND p.status = 'VOIDED'
        AND NOT EXISTS (SELECT 1 FROM folio_posting fp WHERE fp.tenant_id = p.tenant_id AND fp.payment_id = p.id AND fp.posting_type = 'REVERSAL')`.execute(trx);
      for (const r of unposted.rows) out.push({ kind: 'VOID_WITHOUT_REVERSAL', detail: `payment ${r.id} is voided but has no reversal` });
      return out;
    });
  }
}
void ConflictException; void ForbiddenException; void UnprocessableEntityException;
