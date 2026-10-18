import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { FolioService } from '../folio/folio.service.js';
import { IdempotencyService, hashRequest } from '../idempotency/idempotency.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { CompaniesService, fail, fmt, type Trx } from './companies.service.js';
import type * as S from './schemas.js';

const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;

@Injectable()
export class ArService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(CompaniesService) private readonly companies: CompaniesService,
    @Inject(FolioService) private readonly folios: FolioService,
    @Inject(IdempotencyService) private readonly idem: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
  ) {}

  private async requirePermission(userId: string, permission: string, propertyId: string) {
    if ((await this.authz.check(userId, { permission, scope: { propertyId } })).effect !== 'ALLOW') throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: `This action needs the "${permission}" permission` });
  }

  // ───────────── billing a stay to a company ─────────────
  /** Moves part or all of a guest's balance onto a company's account. Needs an Idempotency-Key. */
  async bill(propertyId: string, reservationId: string, userId: string, key: string, i: z.infer<typeof S.BillToCompany>) {
    const hash = hashRequest('POST', `/v1/properties/${propertyId}/reservations/${reservationId}/bill-to-company`, i);
    return this.tdb.tx(async (trx) => {
      const r = await this.idem.run(trx, key, hash, async () => ({ statusCode: 201, body: await this.billIn(trx, propertyId, reservationId, userId, i) }));
      return { ...r.body, replayed: r.replayed };
    });
  }
  private async billIn(trx: Trx, propertyId: string, reservationId: string, userId: string, i: z.infer<typeof S.BillToCompany>) {
    const p = await this.folios.property(trx, propertyId);
    const res = await trx.selectFrom('reservation as r').innerJoin('guest as g', 'g.id', 'r.guest_id').select(['r.id', 'r.company_id', 'r.confirmation_no', 'g.full_name']).where('r.id', '=', reservationId).where('r.property_id', '=', propertyId).executeTakeFirst();
    if (!res) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Reservation not found' });
    const companyId = i.companyId ?? res.company_id;
    if (!companyId) throw fail(422, 'COMPANY_REQUIRED', 'Choose the company to bill');
    const company = await this.companies.row(trx, companyId, true);                                // serialises credit checks for this company
    if (company.status === 'ARCHIVED') throw fail(409, 'COMPANY_ARCHIVED', 'That company is archived');
    const folio = await this.folios.ensureGuestFolio(trx, propertyId, reservationId);
    const f = await this.folios.folioRow(trx, propertyId, folio.id, true);
    if (f.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'This folio is closed');
    if (f.currency !== company.currency) throw fail(422, 'CURRENCY_MISMATCH', `The bill is in ${f.currency}; this company is billed in ${company.currency}`);
    const balance = BigInt(f.balance_minor);
    if (balance <= 0n) throw fail(422, 'NOTHING_TO_BILL', 'There is nothing owing on this bill');
    const amount = i.amount ? Money.parse(i.amount, f.currency).minor : balance;
    if (amount <= 0n) throw fail(422, 'AMOUNT_INVALID', 'The amount must be more than zero');
    if (amount > balance) throw fail(422, 'AMOUNT_TOO_LARGE', 'That is more than the bill', { balance: fmt(balance, f.currency) });

    const st = (await this.companies.standing(trx, [companyId])).get(companyId)!;
    const limit = BigInt(company.credit_limit_minor);
    const onHold = company.status === 'ON_HOLD';
    const over = st.owed + amount > limit;
    if (onHold || over) {
      const detail = { companyId, overridable: true, limit: fmt(limit, f.currency), owed: fmt(st.owed, f.currency), requested: fmt(amount, f.currency) };
      if (!i.override) throw onHold
        ? fail(403, 'COMPANY_ON_HOLD', `${company.name} is on hold${company.hold_reason ? `: ${company.hold_reason}` : ''}. A manager must approve billing it.`, detail)
        : fail(403, 'CREDIT_LIMIT_EXCEEDED', limit === 0n ? `${company.name} has no credit. A manager must approve billing it.` : `This would take ${company.name} over its credit limit. A manager must approve.`, detail);
      await this.requirePermission(userId, 'ar.override_credit', propertyId);
      this.companies.requireFreshMfa();
    }
    const postingId = await this.folios.post(trx, { folioId: f.id, propertyId, currency: f.currency, type: 'PAYMENT', txnCode: 'AR_TRANSFER', amount: -amount, businessDate: p.business_date, sourceType: 'AR',
      description: `Billed to ${company.name}`, note: i.note ?? undefined, userId });
    const item = await trx.insertInto('ar_item').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, company_id: companyId, folio_id: f.id, reservation_id: reservationId, posting_id: postingId, amount_minor: amount.toString(),
      currency: f.currency, item_date: p.business_date, due_date: sql`${p.business_date}::date + ${company.terms_days}::int` as never, confirmation_no: res.confirmation_no, guest_name: res.full_name, note: i.note ?? null,
      override_reason: (onHold || over) ? i.override!.reason : null, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
    await this.applyCredit(trx, companyId);
    await this.audit.record(trx, { action: 'ar.bill', resourceType: 'ar_item', resourceId: item.id, propertyId, after: { companyId, amount: amount.toString(), folioId: f.id, reservationId, overridden: onHold || over }, ...(i.override ? { reasonCode: 'CREDIT_OVERRIDE', note: i.override.reason } : {}) });
    await this.outbox.publish(trx, { aggregateType: 'ar_item', aggregateId: item.id, eventType: 'BilledToCompany', propertyId, businessDate: p.business_date, payload: { itemId: item.id, companyId, reservationId, folioId: f.id, amountMinor: amount.toString(), currency: f.currency } });
    return { item: (await this.itemsIn(trx, { itemId: item.id }))[0], balance: fmt((await this.folios.folioRow(trx, propertyId, f.id)).balance_minor, f.currency) };
  }

  /** Cancels a billing that was wrong: the amount goes back on the guest's bill. Only while nothing has been paid against it. */
  async voidItem(propertyId: string, itemId: string, userId: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      const it = await trx.selectFrom('ar_item').selectAll().where('id', '=', itemId).where('property_id', '=', propertyId).executeTakeFirst();
      if (!it) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Receivable not found' });
      await this.companies.row(trx, it.company_id, true);
      if (await trx.selectFrom('ar_item_void').select('item_id').where('item_id', '=', itemId).executeTakeFirst()) throw fail(409, 'ALREADY_VOID', 'This billing was already cancelled');
      if (await trx.selectFrom('ar_allocation').select('id').where('item_id', '=', itemId).executeTakeFirst()) throw fail(409, 'ITEM_HAS_PAYMENTS', 'Money has already been applied to this billing');
      const p = await this.folios.property(trx, propertyId);
      const f = await this.folios.folioRow(trx, propertyId, it.folio_id, true);
      if (f.status === 'CLOSED') await trx.updateTable('folio').set({ status: 'OPEN', closed_at: null }).where('id', '=', f.id).execute();
      else if (f.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'This folio cannot take the amount back');
      await this.folios.post(trx, { folioId: f.id, propertyId, currency: f.currency, type: 'REVERSAL', txnCode: 'AR_TRANSFER', amount: BigInt(it.amount_minor), businessDate: p.business_date, sourceType: 'REVERSAL',
        reversesId: it.posting_id, description: 'Reversal: billed to company', reasonCode: 'AR_VOID', note: reason, userId });
      await trx.insertInto('ar_item_void').values({ tenant_id: currentTenant().tenantId, item_id: itemId, reason, void_date: p.business_date, voided_by: userId } as never).execute();
      await this.audit.record(trx, { action: 'ar.void', resourceType: 'ar_item', resourceId: itemId, propertyId, before: { companyId: it.company_id, amount: it.amount_minor }, reasonCode: 'AR_VOID', note: reason });
      await this.outbox.publish(trx, { aggregateType: 'ar_item', aggregateId: itemId, eventType: 'CompanyBillingCancelled', propertyId, payload: { itemId, companyId: it.company_id, amountMinor: it.amount_minor, reason } });
      return (await this.itemsIn(trx, { itemId }))[0];
    });
  }

  // ───────────── receipts ─────────────
  private receiptView(r: { id: string; company_id: string; method: string; amount_minor: string; withheld_minor: string; withholding_ref: string | null; currency: string; reference: string; counterparty: string | null; received_on: string; status: string; note: string | null; created_by: string; created_at: Date; verified_by: string | null; decision_note: string | null }, allocated = 0n) {
    const total = BigInt(r.amount_minor) + BigInt(r.withheld_minor);
    return { id: r.id, companyId: r.company_id, method: r.method, amount: fmt(r.amount_minor, r.currency), withheld: fmt(r.withheld_minor, r.currency), withholdingRef: r.withholding_ref, total: fmt(total, r.currency), reference: r.reference, counterparty: r.counterparty,
      receivedOn: r.received_on, status: r.status, note: r.note, createdBy: r.created_by, verifiedBy: r.verified_by, decisionNote: r.decision_note, applied: fmt(allocated, r.currency), onAccount: fmt(r.status === 'CAPTURED' ? total - allocated : 0n, r.currency) };
  }
  async recordReceipt(companyId: string, userId: string, i: z.infer<typeof S.RecordReceipt>) {
    return this.tdb.tx(async (trx) => {
      const c = await this.companies.row(trx, companyId, true);
      if (c.status === 'ARCHIVED') throw fail(409, 'COMPANY_ARCHIVED', 'That company is archived');
      const amount = Money.parse(i.amount, c.currency).minor; const withheld = Money.parse(i.withheld, c.currency).minor;
      if (amount <= 0n) throw fail(422, 'AMOUNT_INVALID', 'The amount must be more than zero');
      if (withheld > 0n && !i.withholdingRef) throw fail(422, 'WITHHOLDING_REF_REQUIRED', 'Enter the certificate or challan number for the tax withheld');
      let r;
      try {
        r = await trx.insertInto('ar_receipt').values({ tenant_id: currentTenant().tenantId, company_id: companyId, method: i.method, amount_minor: amount.toString(), withheld_minor: withheld.toString(), withholding_ref: i.withholdingRef || null,
          currency: c.currency, reference: i.reference, counterparty: i.counterparty || null, received_on: i.receivedOn, apply_to: sql`${i.applyTo}::uuid[]` as never, note: i.note || null, created_by: userId } as never).returningAll().executeTakeFirstOrThrow();
      } catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE_REFERENCE', 'This reference was already recorded for the company'); throw e; }
      await this.audit.record(trx, { action: 'ar.receipt_record', resourceType: 'ar_receipt', resourceId: r.id, after: { companyId, method: i.method, amount: amount.toString(), withheld: withheld.toString(), reference: i.reference } });
      await this.outbox.publish(trx, { aggregateType: 'ar_receipt', aggregateId: r.id, eventType: 'CompanyReceiptPendingVerification', payload: { receiptId: r.id, companyId, amountMinor: amount.toString() } });
      return this.receiptView(r);
    });
  }
  async verifyReceipt(receiptId: string, userId: string, i: z.infer<typeof S.VerifyReceipt>) {
    return this.tdb.tx(async (trx) => {
      const found = await trx.selectFrom('ar_receipt').select(['company_id']).where('id', '=', receiptId).executeTakeFirst();
      if (!found) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Receipt not found' });
      await this.companies.row(trx, found.company_id, true);
      const r = await trx.selectFrom('ar_receipt').selectAll().where('id', '=', receiptId).forUpdate().executeTakeFirstOrThrow();
      if (r.status !== 'PENDING_VERIFICATION') throw fail(409, 'NOT_PENDING', 'This receipt is not waiting for verification');
      if (r.created_by === userId) throw fail(403, 'SELF_VERIFICATION', 'A different person must verify this entry');
      if (!i.approve && !i.note) throw fail(422, 'NOTE_REQUIRED', 'Say why the receipt is rejected');
      const u = await trx.updateTable('ar_receipt').set({ status: i.approve ? 'CAPTURED' : 'REJECTED', verified_by: userId, verified_at: new Date(), decision_note: i.note || null } as never).where('id', '=', receiptId).returningAll().executeTakeFirstOrThrow();
      if (i.approve) await this.applyCredit(trx, r.company_id);
      await this.audit.record(trx, { action: i.approve ? 'ar.receipt_verify' : 'ar.receipt_reject', resourceType: 'ar_receipt', resourceId: receiptId, after: { companyId: r.company_id, amount: r.amount_minor, withheld: r.withheld_minor }, note: i.note ?? undefined });
      if (i.approve) await this.outbox.publish(trx, { aggregateType: 'ar_receipt', aggregateId: receiptId, eventType: 'CompanyReceiptCaptured', payload: { receiptId, companyId: r.company_id, amountMinor: r.amount_minor, withheldMinor: r.withheld_minor, currency: r.currency } });
      const al = await sql<{ s: string }>`SELECT coalesce(sum(applied_minor),0)::text AS s FROM ar_allocation WHERE tenant_id = ${currentTenant().tenantId} AND receipt_id = ${receiptId}`.execute(trx);
      return this.receiptView(u, BigInt(al.rows[0]!.s));
    });
  }
  async receipts(q: { companyId?: string; status?: string }) {
    return this.tdb.tx(async (trx) => {
      const t = currentTenant().tenantId;
      const rows = await sql<Record<string, never>>`SELECT r.*, c.name AS company_name, coalesce((SELECT sum(a.applied_minor) FROM ar_allocation a WHERE a.tenant_id = r.tenant_id AND a.receipt_id = r.id),0)::text AS applied
        FROM ar_receipt r JOIN company c ON c.tenant_id = r.tenant_id AND c.id = r.company_id WHERE r.tenant_id = ${t}
        ${q.companyId ? sql`AND r.company_id = ${q.companyId}` : sql``} ${q.status ? sql`AND r.status = ${q.status}` : sql``} ORDER BY r.created_at DESC LIMIT 200`.execute(trx);
      return { items: rows.rows.map((r: any) => ({ ...this.receiptView({ ...r, received_on: String(r.received_on instanceof Date ? r.received_on.toISOString().slice(0, 10) : r.received_on) }, BigInt(r.applied)), companyName: r.company_name })) };
    });
  }

  /** Puts money that has been verified against what is owed: the receipt's chosen items first, then the oldest due. Runs again whenever something is billed, so credit on account is used. */
  private async applyCredit(trx: Trx, companyId: string) {
    const t = currentTenant().tenantId;
    const receipts = (await sql<{ id: string; apply_to: string[]; remaining: string }>`
      SELECT r.id, r.apply_to, (r.amount_minor + r.withheld_minor - coalesce((SELECT sum(a.applied_minor) FROM ar_allocation a WHERE a.tenant_id = r.tenant_id AND a.receipt_id = r.id),0))::text AS remaining
      FROM ar_receipt r WHERE r.tenant_id = ${t} AND r.company_id = ${companyId} AND r.status = 'CAPTURED' ORDER BY r.verified_at, r.created_at, r.id`.execute(trx)).rows.filter((r) => BigInt(r.remaining) > 0n);
    if (!receipts.length) return;
    const items = (await sql<{ id: string; open: string }>`
      SELECT i.id, (i.amount_minor - coalesce((SELECT sum(a.applied_minor) FROM ar_allocation a WHERE a.tenant_id = i.tenant_id AND a.item_id = i.id),0))::text AS open
      FROM ar_item i WHERE i.tenant_id = ${t} AND i.company_id = ${companyId} AND NOT EXISTS (SELECT 1 FROM ar_item_void v WHERE v.tenant_id = i.tenant_id AND v.item_id = i.id) ORDER BY i.due_date, i.created_at, i.id`.execute(trx)).rows
      .map((x) => ({ id: x.id, open: BigInt(x.open) })).filter((x) => x.open > 0n);
    for (const r of receipts) {
      let left = BigInt(r.remaining);
      const order = [...items.filter((x) => r.apply_to.includes(x.id)).sort((a, b) => r.apply_to.indexOf(a.id) - r.apply_to.indexOf(b.id)), ...items.filter((x) => !r.apply_to.includes(x.id))];
      for (const it of order) {
        if (left === 0n) break;
        if (it.open === 0n) continue;
        const use = left < it.open ? left : it.open;
        await trx.insertInto('ar_allocation').values({ tenant_id: t, receipt_id: r.id, item_id: it.id, applied_minor: use.toString() } as never).execute();
        it.open -= use; left -= use;
      }
    }
  }

  // ───────────── reading ─────────────
  private async itemsIn(trx: Trx, q: { companyId?: string; reservationId?: string; itemId?: string; openOnly?: boolean }) {
    const t = currentTenant().tenantId;
    const rows = await sql<{ id: string; company_id: string; company_name: string; property_id: string; reservation_id: string | null; confirmation_no: string | null; guest_name: string | null; amount: string; applied: string; currency: string; item_date: string; due_date: string; bd: string; note: string | null; override_reason: string | null; voided: boolean; void_reason: string | null; invoices: string[] | null }>`
      SELECT i.id, i.company_id, c.name AS company_name, i.property_id, i.reservation_id, i.confirmation_no, i.guest_name, i.amount_minor::text AS amount, i.currency, i.item_date::text, i.due_date::text, p.business_date::text AS bd, i.note, i.override_reason,
        coalesce((SELECT sum(a.applied_minor) FROM ar_allocation a WHERE a.tenant_id = i.tenant_id AND a.item_id = i.id),0)::text AS applied,
        (v.item_id IS NOT NULL) AS voided, v.reason AS void_reason,
        (SELECT array_agg(n.number ORDER BY n.number) FROM invoice n WHERE n.tenant_id = i.tenant_id AND n.reservation_id = i.reservation_id AND n.doc_type = 'TAX_INVOICE') AS invoices
      FROM ar_item i JOIN company c ON c.tenant_id = i.tenant_id AND c.id = i.company_id JOIN property p ON p.tenant_id = i.tenant_id AND p.id = i.property_id LEFT JOIN ar_item_void v ON v.tenant_id = i.tenant_id AND v.item_id = i.id
      WHERE i.tenant_id = ${t} ${q.companyId ? sql`AND i.company_id = ${q.companyId}` : sql``} ${q.reservationId ? sql`AND i.reservation_id = ${q.reservationId}` : sql``} ${q.itemId ? sql`AND i.id = ${q.itemId}` : sql``}
      ORDER BY i.due_date, i.created_at LIMIT 500`.execute(trx);
    return rows.rows.map((r) => {
      const open = r.voided ? 0n : BigInt(r.amount) - BigInt(r.applied);
      return { id: r.id, companyId: r.company_id, companyName: r.company_name, propertyId: r.property_id, reservationId: r.reservation_id, confirmationNo: r.confirmation_no, guest: r.guest_name, amount: fmt(r.amount, r.currency), applied: fmt(r.applied, r.currency),
        open: fmt(open, r.currency), billedOn: r.item_date, dueOn: r.due_date, overdue: open > 0n && r.due_date < r.bd, status: r.voided ? 'CANCELLED' : open === 0n ? 'PAID' : BigInt(r.applied) > 0n ? 'PART_PAID' : 'OPEN',
        note: r.note, overrideReason: r.override_reason, voidReason: r.void_reason, invoices: r.invoices ?? [] };
    }).filter((x) => !q.openOnly || x.status === 'OPEN' || x.status === 'PART_PAID');
  }
  async items(q: { companyId?: string; reservationId?: string; openOnly?: boolean }) { return this.tdb.tx(async (trx) => ({ items: await this.itemsIn(trx, q) })); }

  private async asOfDefault(trx: Trx): Promise<string> {
    const r = await sql<{ d: string | null }>`SELECT max(business_date)::text AS d FROM property WHERE tenant_id = ${currentTenant().tenantId}`.execute(trx);
    return r.rows[0]?.d ?? new Date().toISOString().slice(0, 10);
  }
  private async agingIn(trx: Trx, asOf: string, companyId?: string) {
    const t = currentTenant().tenantId;
    const rows = await sql<{ company_id: string; name: string; currency: string; b0: string; b1: string; b2: string; b3: string; b4: string; on_account: string }>`
      WITH open AS (
        SELECT i.company_id, i.due_date, i.amount_minor - coalesce((SELECT sum(a.applied_minor) FROM ar_allocation a WHERE a.tenant_id = i.tenant_id AND a.item_id = i.id),0) AS o
        FROM ar_item i WHERE i.tenant_id = ${t} AND NOT EXISTS (SELECT 1 FROM ar_item_void v WHERE v.tenant_id = i.tenant_id AND v.item_id = i.id) ${companyId ? sql`AND i.company_id = ${companyId}` : sql``})
      SELECT c.id AS company_id, c.name, c.currency,
        coalesce(sum(o) FILTER (WHERE due_date >= ${asOf}::date),0)::text AS b0,
        coalesce(sum(o) FILTER (WHERE ${asOf}::date - due_date BETWEEN 1 AND 30),0)::text AS b1,
        coalesce(sum(o) FILTER (WHERE ${asOf}::date - due_date BETWEEN 31 AND 60),0)::text AS b2,
        coalesce(sum(o) FILTER (WHERE ${asOf}::date - due_date BETWEEN 61 AND 90),0)::text AS b3,
        coalesce(sum(o) FILTER (WHERE ${asOf}::date - due_date > 90),0)::text AS b4,
        (coalesce((SELECT sum(r.amount_minor + r.withheld_minor) FROM ar_receipt r WHERE r.tenant_id = c.tenant_id AND r.company_id = c.id AND r.status = 'CAPTURED'),0)
         - coalesce((SELECT sum(a.applied_minor) FROM ar_allocation a JOIN ar_receipt r ON r.tenant_id = a.tenant_id AND r.id = a.receipt_id WHERE a.tenant_id = c.tenant_id AND r.company_id = c.id),0))::text AS on_account
      FROM company c LEFT JOIN open ON open.company_id = c.id AND open.o > 0
      WHERE c.tenant_id = ${t} ${companyId ? sql`AND c.id = ${companyId}` : sql``} GROUP BY c.tenant_id, c.id, c.name, c.currency ORDER BY c.name`.execute(trx);
    return rows.rows.map((r) => {
      const b = [r.b0, r.b1, r.b2, r.b3, r.b4].map(BigInt);
      const total = b.reduce((a, x) => a + x, 0n);
      return { companyId: r.company_id, company: r.name, currency: r.currency, buckets: Object.fromEntries(BUCKETS.map((k, n) => [k, fmt(b[n]!, r.currency)])), totalOpen: fmt(total, r.currency), onAccount: fmt(r.on_account, r.currency), net: fmt(total - BigInt(r.on_account), r.currency), _total: total, _onAccount: BigInt(r.on_account), _b: b };
    });
  }
  /** Every company that owes money, by how late it is. */
  async aging(asOfIn?: string) {
    return this.tdb.tx(async (trx) => {
      const asOf = asOfIn ?? await this.asOfDefault(trx);
      const rows = (await this.agingIn(trx, asOf)).filter((r) => r._total !== 0n || r._onAccount !== 0n);
      const cur = rows[0]?.currency ?? 'PKR';
      const sum = (f: (r: typeof rows[number]) => bigint) => rows.reduce((a, r) => a + f(r), 0n);
      const totals = Object.fromEntries(BUCKETS.map((k, n) => [k, fmt(sum((r) => r._b[n]!), cur)]));
      return { asOf, items: rows.map(({ _total, _onAccount, _b, ...r }) => (void _total, void _onAccount, void _b, r)), totals, totalOpen: fmt(sum((r) => r._total), cur) };
    });
  }

  /** A company's account between two dates: what was billed, what was received, and where it stands. */
  async statement(companyId: string, fromIn?: string, toIn?: string) {
    return this.tdb.tx(async (trx) => {
      const c = await this.companies.row(trx, companyId);
      const t = currentTenant().tenantId;
      const to = toIn ?? await this.asOfDefault(trx);
      const from = fromIn ?? `${to.slice(0, 8)}01`;
      if (to < from) throw fail(400, 'VALIDATION_FAILED', 'The end date is before the start date');
      const ev = await sql<{ date: string; kind: string; ref: string | null; text: string | null; debit: string; credit: string; due: string | null; sort: string }>`
        SELECT i.item_date::text AS date, 'BILLED' AS kind, i.confirmation_no AS ref, i.guest_name AS text, i.amount_minor::text AS debit, '0' AS credit, i.due_date::text AS due, i.created_at::text AS sort
          FROM ar_item i WHERE i.tenant_id = ${t} AND i.company_id = ${companyId}
        UNION ALL SELECT v.void_date::text, 'CANCELLED', i.confirmation_no, i.guest_name, '0', i.amount_minor::text, NULL, v.voided_at::text
          FROM ar_item_void v JOIN ar_item i ON i.tenant_id = v.tenant_id AND i.id = v.item_id WHERE v.tenant_id = ${t} AND i.company_id = ${companyId}
        UNION ALL SELECT r.received_on::text, 'RECEIPT', r.reference, r.method, '0', r.amount_minor::text, NULL, r.verified_at::text FROM ar_receipt r WHERE r.tenant_id = ${t} AND r.company_id = ${companyId} AND r.status = 'CAPTURED'
        UNION ALL SELECT r.received_on::text, 'WITHHELD', coalesce(r.withholding_ref, r.reference), 'tax withheld', '0', r.withheld_minor::text, NULL, r.verified_at::text FROM ar_receipt r WHERE r.tenant_id = ${t} AND r.company_id = ${companyId} AND r.status = 'CAPTURED' AND r.withheld_minor > 0
        ORDER BY 1, 8`.execute(trx);
      let opening = 0n; let run = 0n; let debit = 0n; let credit = 0n;
      const lines: Array<{ date: string; kind: string; ref: string | null; text: string | null; debit: ReturnType<typeof fmt>; credit: ReturnType<typeof fmt>; balance: ReturnType<typeof fmt>; due: string | null }> = [];
      for (const e of ev.rows) {
        if (e.date > to) continue;
        const d = BigInt(e.debit), cr = BigInt(e.credit);
        run += d - cr;
        if (e.date < from) { opening = run; continue; }
        debit += d; credit += cr;
        lines.push({ date: e.date, kind: e.kind, ref: e.ref, text: e.text, debit: fmt(d, c.currency), credit: fmt(cr, c.currency), balance: fmt(run, c.currency), due: e.due });
      }
      const aging = (await this.agingIn(trx, to, companyId))[0];
      const { _total, _onAccount, _b, ...ag } = aging ?? { companyId, company: c.name, currency: c.currency, buckets: {}, totalOpen: fmt(0n, c.currency), onAccount: fmt(0n, c.currency), net: fmt(0n, c.currency), _total: 0n, _onAccount: 0n, _b: [] as bigint[] };
      void _total; void _onAccount; void _b;
      return { company: this.companies.view(c), from, to, opening: fmt(opening, c.currency), billed: fmt(debit, c.currency), received: fmt(credit, c.currency), closing: fmt(run, c.currency), lines, aging: ag };
    });
  }
}
