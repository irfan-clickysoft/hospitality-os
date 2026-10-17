import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import type { PaymentMethod } from '@hos/db';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { TenantDb } from '../db/tenant-db.js';
import { IdempotencyService, hashRequest } from '../idempotency/idempotency.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { FolioService, fmt, type Trx } from './folio.service.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
type PaymentRow = Awaited<ReturnType<PaymentsService['row']>>;

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(FolioService) private readonly folios: FolioService,
    @Inject(IdempotencyService) private readonly idem: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  async row(trx: Trx, propertyId: string, id: string, lock = false) {
    let q = trx.selectFrom('payment').selectAll().where('id', '=', id).where('property_id', '=', propertyId);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found' });
    return r;
  }
  private async openSession(trx: Trx, propertyId: string, userId: string) {
    return trx.selectFrom('cashier_session').select(['id']).where('property_id', '=', propertyId).where('user_id', '=', userId).where('status', '=', 'OPEN').executeTakeFirst();
  }
  private async limit(userId: string, permission: string, propertyId: string, amount: bigint) {
    const d = await this.authz.check(userId, { permission, scope: { propertyId }, amountMinor: amount });
    if (d.effect !== 'ALLOW') throw fail(403, 'APPROVAL_REQUIRED', 'This amount is above your limit and needs a manager');
  }
  private needs(method: PaymentMethod, i: { reference?: string | null; counterparty?: string | null; approvalCode?: string | null }) {
    if (method === 'BANK_TRANSFER' && !i.reference) throw fail(422, 'REFERENCE_REQUIRED', 'Enter the bank transfer reference');
    if (method === 'BANK_TRANSFER' && !i.counterparty) throw fail(422, 'COUNTERPARTY_REQUIRED', 'Enter the bank the money came from');
    if (method === 'CARD_SLIP' && (!i.reference || !i.approvalCode)) throw fail(422, 'REFERENCE_REQUIRED', 'Enter the slip reference (RRN) and approval code');
    if (method === 'WALLET' && !i.reference) throw fail(422, 'REFERENCE_REQUIRED', 'Enter the wallet transaction id');
  }

  // ───────────── record ─────────────
  async record(propertyId: string, reservationId: string, userId: string, key: string, i: z.infer<typeof S.RecordPayment>) {
    const hash = hashRequest('POST', `/v1/properties/${propertyId}/reservations/${reservationId}/payments`, i);
    return this.tdb.tx(async (trx) => {
      const r = await this.idem.run(trx, key, hash, async () => ({ statusCode: 201, body: await this.recordIn(trx, propertyId, reservationId, userId, i) }));
      return { ...r.body, replayed: r.replayed };
    });
  }
  private async recordIn(trx: Trx, propertyId: string, reservationId: string, userId: string, i: z.infer<typeof S.RecordPayment>) {
    const p = await this.folios.property(trx, propertyId);
    const folio = await this.folios.ensureGuestFolio(trx, propertyId, reservationId);
    await this.folios.folioRow(trx, propertyId, folio.id, true);
    if (folio.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'This folio is closed');
    const amount = Money.parse(i.amount, folio.currency).minor;
    if (amount <= 0n) throw fail(422, 'AMOUNT_INVALID', 'The amount must be more than zero');
    await this.limit(userId, 'payment.take', propertyId, amount);
    this.needs(i.method, i);
    const session = await this.openSession(trx, propertyId, userId);
    if (i.method === 'CASH' && !session) throw fail(409, 'NO_OPEN_SESSION', 'Open your cashier session before taking cash');
    const status = i.method === 'BANK_TRANSFER' ? 'PENDING_VERIFICATION' : 'CAPTURED';
    const pay = await trx.insertInto('payment').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, folio_id: folio.id, kind: i.kind, method: i.method, status, amount_minor: amount.toString(),
      currency: folio.currency, reference: i.reference ?? null, card_last4: i.cardLast4 ?? null, approval_code: i.approvalCode ?? null, counterparty: i.counterparty ?? null, note: i.note ?? null,
      cashier_session_id: session?.id ?? null, business_date: p.business_date, created_by: userId } as never).returningAll().executeTakeFirstOrThrow();
    if (status === 'CAPTURED') await this.capture(trx, propertyId, pay, folio.currency, userId);
    else await this.outbox.publish(trx, { aggregateType: 'payment', aggregateId: pay.id, eventType: 'PaymentPendingVerification', propertyId, payload: { paymentId: pay.id, folioId: folio.id, amountMinor: amount.toString(), method: i.method } });
    await this.audit.record(trx, { action: 'payment.record', resourceType: 'payment', resourceId: pay.id, propertyId, after: { kind: i.kind, method: i.method, amount: amount.toString(), status, folioId: folio.id } });
    return { payment: this.folios.paymentView(pay, folio.currency), balance: fmt((await this.folios.folioRow(trx, propertyId, folio.id)).balance_minor, folio.currency), folioId: folio.id };
  }

  /** Puts a verified payment on the ledger. Idempotent per payment. */
  private async capture(trx: Trx, propertyId: string, pay: PaymentRow, currency: string, userId: string) {
    const p = await this.folios.property(trx, propertyId);
    const type = pay.kind === 'DEPOSIT' ? 'DEPOSIT_RECEIVED' : pay.kind === 'REFUND' ? 'REFUND' : 'PAYMENT';
    const txn = pay.kind === 'DEPOSIT' ? 'DEPOSIT' : pay.kind === 'REFUND' ? 'REFUND' : `PAY_${pay.method}`;
    const amt = BigInt(pay.amount_minor);
    await this.folios.post(trx, { folioId: pay.folio_id, propertyId, currency, type, txnCode: txn, amount: type === 'REFUND' ? amt : -amt, businessDate: p.business_date, sourceType: 'PAYMENT',
      paymentId: pay.id, sessionId: pay.cashier_session_id, idempotencyKey: `payment:${pay.id}:capture`, description: `${pay.kind === 'REFUND' ? 'Refund' : pay.kind === 'DEPOSIT' ? 'Deposit' : 'Payment'} (${pay.method.replace('_', ' ').toLowerCase()})${pay.reference ? ' ' + pay.reference : ''}`, userId });
    const folio = await this.folios.folioRow(trx, propertyId, pay.folio_id);
    if (folio.reservation_id) await this.syncGuarantee(trx, propertyId, folio.reservation_id);
    await this.outbox.publish(trx, { aggregateType: 'payment', aggregateId: pay.id, eventType: pay.kind === 'REFUND' ? 'PaymentRefunded' : 'PaymentCaptured', propertyId, businessDate: p.business_date,
      payload: { paymentId: pay.id, folioId: pay.folio_id, reservationId: folio.reservation_id, kind: pay.kind, method: pay.method, amountMinor: pay.amount_minor, currency } });
  }

  /** Deposits received (net of refunds) decide whether an unguaranteed booking is secured — this is where the "guaranteed by deposit" rule lands. */
  async syncGuarantee(trx: Trx, propertyId: string, reservationId: string) {
    const res = await trx.selectFrom('reservation').select(['id', 'status', 'guarantee_type', 'at_risk', 'deposit_required_minor', 'confirmation_no']).where('id', '=', reservationId).executeTakeFirstOrThrow();
    const sums = await sql<{ dep: string; ref: string }>`
      SELECT coalesce(sum(p.amount_minor) FILTER (WHERE p.kind = 'DEPOSIT'),0)::text AS dep,
             coalesce(sum(p.amount_minor) FILTER (WHERE p.kind = 'REFUND' AND o.kind = 'DEPOSIT'),0)::text AS ref
      FROM payment p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id LEFT JOIN payment o ON o.tenant_id = p.tenant_id AND o.id = p.refund_of_payment_id
      WHERE p.tenant_id = ${currentTenant().tenantId} AND f.reservation_id = ${reservationId} AND p.status = 'CAPTURED'`.execute(trx);
    const paid = BigInt(sums.rows[0]!.dep) - BigInt(sums.rows[0]!.ref);
    const required = BigInt(res.deposit_required_minor);
    const set: Record<string, unknown> = { deposit_paid_minor: (paid < 0n ? 0n : paid).toString() };
    let secured = false;
    if (res.guarantee_type !== 'COMPANY') {
      if (required > 0n && paid >= required) { if (res.guarantee_type !== 'DEPOSIT') secured = true; set.guarantee_type = 'DEPOSIT'; set.at_risk = false; }
      else if (res.guarantee_type === 'DEPOSIT') { set.guarantee_type = 'NONE'; set.at_risk = required > 0n && res.status === 'CONFIRMED'; }
    }
    await trx.updateTable('reservation').set({ ...set, version: sql`version + 1` as never } as never).where('id', '=', reservationId).execute();
    if (secured) await this.outbox.publish(trx, { aggregateType: 'reservation', aggregateId: reservationId, eventType: 'GuaranteeSecured', propertyId, payload: { reservationId, confirmationNo: res.confirmation_no, depositPaidMinor: paid.toString() } });
  }

  // ───────────── verify (maker–checker) ─────────────
  async verify(propertyId: string, paymentId: string, userId: string, i: z.infer<typeof S.VerifyPayment>) {
    return this.tdb.tx(async (trx) => {
      const pay = await this.row(trx, propertyId, paymentId, true);
      if (pay.status !== 'PENDING_VERIFICATION') throw fail(409, 'NOT_PENDING', 'This payment is not waiting for verification');
      if (pay.created_by === userId) throw fail(403, 'SELF_VERIFICATION', 'A different person must verify this entry');
      if (!i.approve && !i.note) throw fail(422, 'NOTE_REQUIRED', 'Say why the payment is rejected');
      const folio = await this.folios.folioRow(trx, propertyId, pay.folio_id, true);
      if (i.approve) {
        if (folio.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'This folio is closed');
        if (pay.kind === 'REFUND') await this.assertRefundable(trx, pay.refund_of_payment_id!, BigInt(pay.amount_minor), pay.id);
        const upd = await trx.updateTable('payment').set({ status: 'CAPTURED', verified_by: userId, verified_at: new Date(this.clock.now()), note: i.note ?? pay.note })
          .where('id', '=', paymentId).where('status', '=', 'PENDING_VERIFICATION').returningAll().executeTakeFirstOrThrow();
        await this.capture(trx, propertyId, upd, folio.currency, userId);
      } else {
        await trx.updateTable('payment').set({ status: 'REJECTED', verified_by: userId, verified_at: new Date(this.clock.now()), note: i.note }).where('id', '=', paymentId).execute();
        await this.outbox.publish(trx, { aggregateType: 'payment', aggregateId: paymentId, eventType: 'PaymentRejected', propertyId, payload: { paymentId, folioId: pay.folio_id, reason: i.note } });
      }
      await this.audit.record(trx, { action: i.approve ? 'payment.verify' : 'payment.reject', resourceType: 'payment', resourceId: paymentId, propertyId, after: { amount: pay.amount_minor, kind: pay.kind }, note: i.note ?? undefined });
      return { payment: this.folios.paymentView(await this.row(trx, propertyId, paymentId), folio.currency), balance: fmt((await this.folios.folioRow(trx, propertyId, pay.folio_id)).balance_minor, folio.currency) };
    });
  }
  async pending(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      await this.folios.property(trx, propertyId);
      const rows = await trx.selectFrom('payment as p').innerJoin('folio as f', 'f.id', 'p.folio_id').leftJoin('reservation as r', 'r.id', 'f.reservation_id')
        .select(['p.id', 'p.kind', 'p.method', 'p.amount_minor', 'p.currency', 'p.reference', 'p.counterparty', 'p.created_by', 'p.created_at', 'f.folio_no', 'r.confirmation_no'])
        .where('p.property_id', '=', propertyId).where('p.status', '=', 'PENDING_VERIFICATION').orderBy('p.created_at').execute();
      return { items: rows.map((x) => ({ id: x.id, kind: x.kind, method: x.method, amount: fmt(x.amount_minor, x.currency), reference: x.reference, counterparty: x.counterparty, createdBy: x.created_by, createdAt: x.created_at, folioNo: x.folio_no, confirmationNo: x.confirmation_no })) };
    });
  }

  // ───────────── void ─────────────
  async void(propertyId: string, paymentId: string, userId: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const pay = await this.row(trx, propertyId, paymentId, true);
      if (pay.status !== 'CAPTURED' || pay.kind === 'REFUND') throw fail(409, 'NOT_VOIDABLE', 'Only a captured payment or deposit can be voided');
      const folio = await this.folios.folioRow(trx, propertyId, pay.folio_id, true);
      if (folio.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'This folio is closed');
      if (pay.method === 'CASH') {
        const s = pay.cashier_session_id ? await trx.selectFrom('cashier_session').select('status').where('id', '=', pay.cashier_session_id).executeTakeFirst() : null;
        if (!s || s.status !== 'OPEN') throw fail(409, 'USE_REFUND', 'The cashier session for this cash payment is closed. Refund it instead.');
      }
      const refunds = await trx.selectFrom('payment').select('id').where('refund_of_payment_id', '=', paymentId).where('status', 'in', ['CAPTURED', 'PENDING_VERIFICATION']).executeTakeFirst();
      if (refunds) throw fail(409, 'HAS_REFUNDS', 'This payment already has a refund against it');
      const posting = await trx.selectFrom('folio_posting').selectAll().where('payment_id', '=', paymentId).where('posting_type', 'in', ['PAYMENT', 'DEPOSIT_RECEIVED']).executeTakeFirstOrThrow();
      await this.folios.post(trx, { folioId: pay.folio_id, propertyId, currency: folio.currency, type: 'REVERSAL', txnCode: posting.txn_code, amount: -BigInt(posting.amount_minor), businessDate: p.business_date, sourceType: 'REVERSAL',
        reversesId: posting.id, paymentId, sessionId: pay.cashier_session_id, description: `Void: ${posting.description ?? posting.txn_code}`, reasonCode: 'PAYMENT_VOID', note: reason, userId });
      await trx.updateTable('payment').set({ status: 'VOIDED', void_reason: reason }).where('id', '=', paymentId).execute();
      if (folio.reservation_id) await this.syncGuarantee(trx, propertyId, folio.reservation_id);
      await this.audit.record(trx, { action: 'payment.void', resourceType: 'payment', resourceId: paymentId, propertyId, before: { amount: pay.amount_minor, method: pay.method }, reasonCode: 'PAYMENT_VOID', note: reason });
      await this.outbox.publish(trx, { aggregateType: 'payment', aggregateId: paymentId, eventType: 'PaymentVoided', propertyId, payload: { paymentId, folioId: pay.folio_id, amountMinor: pay.amount_minor, reason } });
      return { payment: this.folios.paymentView(await this.row(trx, propertyId, paymentId), folio.currency), balance: fmt((await this.folios.folioRow(trx, propertyId, pay.folio_id)).balance_minor, folio.currency) };
    });
  }

  // ───────────── refund ─────────────
  private async assertRefundable(trx: Trx, originalId: string, amount: bigint, excludingId?: string) {
    const orig = await trx.selectFrom('payment').selectAll().where('id', '=', originalId).executeTakeFirstOrThrow();
    let q = trx.selectFrom('payment').select('amount_minor').where('refund_of_payment_id', '=', originalId).where('status', 'in', ['CAPTURED', 'PENDING_VERIFICATION']);
    if (excludingId) q = q.where('id', '<>', excludingId);
    const taken = (await q.execute()).reduce((a, x) => a + BigInt(x.amount_minor), 0n);
    const left = BigInt(orig.amount_minor) - taken;
    if (amount > left) throw fail(422, 'REFUND_TOO_LARGE', `Only ${fmt(left, orig.currency).amount} of this payment can still be refunded`, { refundable: fmt(left, orig.currency) });
  }
  async refund(propertyId: string, paymentId: string, userId: string, key: string, i: z.infer<typeof S.RefundPayment>) {
    const hash = hashRequest('POST', `/v1/properties/${propertyId}/payments/${paymentId}/refund`, i);
    return this.tdb.tx(async (trx) => {
      const r = await this.idem.run(trx, key, hash, async () => ({ statusCode: 201, body: await this.refundIn(trx, propertyId, paymentId, userId, i) }));
      return { ...r.body, replayed: r.replayed };
    });
  }
  private async refundIn(trx: Trx, propertyId: string, paymentId: string, userId: string, i: z.infer<typeof S.RefundPayment>) {
    const p = await this.folios.property(trx, propertyId);
    const orig = await this.row(trx, propertyId, paymentId, true);
    if (orig.status !== 'CAPTURED' || orig.kind === 'REFUND') throw fail(409, 'NOT_REFUNDABLE', 'Only a captured payment or deposit can be refunded');
    const folio = await this.folios.folioRow(trx, propertyId, orig.folio_id, true);
    if (folio.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'This folio is closed. Reopen it to refund.');
    const amount = Money.parse(i.amount, folio.currency).minor;
    if (amount <= 0n) throw fail(422, 'AMOUNT_INVALID', 'The amount must be more than zero');
    await this.limit(userId, 'payment.refund', propertyId, amount);
    await this.assertRefundable(trx, paymentId, amount);
    const method = (i.method ?? orig.method) as PaymentMethod;
    const session = await this.openSession(trx, propertyId, userId);
    if (method === 'CASH' && !session) throw fail(409, 'NO_OPEN_SESSION', 'Open your cashier session to pay cash out');
    if (method !== 'CASH' && !i.counterparty) throw fail(422, 'COUNTERPARTY_REQUIRED', 'Enter the beneficiary (bank account / wallet) the refund goes to');
    const status = method === 'CASH' ? 'CAPTURED' : 'PENDING_VERIFICATION';
    const pay = await trx.insertInto('payment').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, folio_id: orig.folio_id, kind: 'REFUND', method, status, amount_minor: amount.toString(),
      currency: folio.currency, reference: i.reference ?? null, counterparty: i.counterparty ?? null, note: i.reason, refund_of_payment_id: paymentId, cashier_session_id: session?.id ?? null,
      business_date: p.business_date, created_by: userId } as never).returningAll().executeTakeFirstOrThrow();
    if (status === 'CAPTURED') await this.capture(trx, propertyId, pay, folio.currency, userId);
    else await this.outbox.publish(trx, { aggregateType: 'payment', aggregateId: pay.id, eventType: 'PaymentPendingVerification', propertyId, payload: { paymentId: pay.id, folioId: orig.folio_id, amountMinor: amount.toString(), method, refund: true } });
    await this.audit.record(trx, { action: 'payment.refund', resourceType: 'payment', resourceId: pay.id, propertyId, before: { originalPayment: paymentId }, after: { amount: amount.toString(), method, status }, reasonCode: 'REFUND', note: i.reason });
    return { payment: this.folios.paymentView(pay, folio.currency), balance: fmt((await this.folios.folioRow(trx, propertyId, orig.folio_id)).balance_minor, folio.currency), folioId: orig.folio_id };
  }
}
