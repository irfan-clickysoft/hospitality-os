import { createHash } from 'node:crypto';
import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import type { DB } from '@hos/db';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

type Trx = Transaction<DB>;
const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const fmt = (m: bigint | string | number, cur: string) => ({ amount: Money.ofMinor(BigInt(m), cur).toDecimalString(), currency: cur });

export interface InvoiceLine { postingId: string; date: string; description: string; txnCode: string; quantity: number; unitMinor: string | null; netMinor: string; taxMinor: string; taxes: Array<{ code: string; rateBp: number; taxableMinor: string; taxMinor: string }> }
export interface TaxSummaryRow { code: string; rateBp: number; taxableMinor: string; taxMinor: string }

/** The fiscal year an issue date falls in, as a number and as the label printed in the invoice number. */
export function fiscalYear(date: string, startMonth: number): { year: number; label: string } {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  const year = startMonth === 1 || m >= startMonth ? y : y - 1;
  return { year, label: startMonth === 1 ? String(year) : `${year}-${String((year + 1) % 100).padStart(2, '0')}` };
}

@Injectable()
export class InvoiceService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  private async nextNumber(trx: Trx, legalEntityId: string, series: 'INV' | 'CN', date: string, startMonth: number) {
    const fy = fiscalYear(date, startMonth);
    // one row per entity, series and fiscal year, locked by the upsert: numbers are gapless because a rolled-back issue gives its number back
    const r = await sql<{ seq: number }>`INSERT INTO invoice_counter (tenant_id, legal_entity_id, series, fiscal_year, last_seq) VALUES (${currentTenant().tenantId}, ${legalEntityId}, ${series}, ${fy.year}, 1)
      ON CONFLICT (tenant_id, legal_entity_id, series, fiscal_year) DO UPDATE SET last_seq = invoice_counter.last_seq + 1 RETURNING last_seq AS seq`.execute(trx);
    const seq = r.rows[0]!.seq;
    return { seq, fiscalYear: fy.year, number: `${series}-${fy.label}-${String(seq).padStart(6, '0')}` };
  }
  private hash(x: unknown): string { return createHash('sha256').update(JSON.stringify(x)).digest('hex'); }

  // ───────────── issue ─────────────
  async issue(propertyId: string, reservationId: string, userId: string, i: z.infer<typeof S.IssueInvoice>) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['id', 'code', 'name', 'currency', 'business_date', 'legal_entity_id']).where('id', '=', propertyId).executeTakeFirst();
      if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
      const res = await trx.selectFrom('reservation as r').innerJoin('guest as g', 'g.id', 'r.guest_id').select(['r.id', 'r.confirmation_no', 'r.currency', 'g.full_name', 'g.phone', 'g.nationality']).where('r.id', '=', reservationId).where('r.property_id', '=', propertyId).executeTakeFirst();
      if (!res) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Reservation not found' });
      const folio = await trx.selectFrom('folio').selectAll().where('reservation_id', '=', reservationId).where('folio_type', '=', 'GUEST').where('status', '<>', 'VOID').forUpdate().executeTakeFirst();
      if (!folio) throw fail(422, 'NOTHING_TO_INVOICE', 'There is nothing on the bill yet');
      const live = await trx.selectFrom('reservation_room').select('id').where('reservation_id', '=', reservationId).where('status', 'in', ['CHECKED_IN', 'CONFIRMED', 'OPTION']).executeTakeFirst();
      if (live) throw fail(409, 'STAY_NOT_FINISHED', 'The stay is not finished. Check the guest out first (until then the bill can be shown as an interim bill, not a tax invoice).');

      const rows = await sql<{ id: string; posting_type: string; txn_code: string; description: string | null; quantity: string; unit_price_minor: string | null; amount_minor: string; business_date: string; parent_posting_id: string | null; tax_code: string | null; tax_rate_bp: number | null; taxable_minor: string | null }>`
        SELECT p.id, p.posting_type, p.txn_code, p.description, p.quantity::text, p.unit_price_minor::text, p.amount_minor::text, p.business_date::text, p.parent_posting_id, p.tax_code, p.tax_rate_bp, p.taxable_minor::text
        FROM folio_posting p WHERE p.tenant_id = ${currentTenant().tenantId} AND p.folio_id = ${folio.id} AND p.posting_type IN ('CHARGE','DISCOUNT','TAX','ADJUSTMENT')
          AND NOT EXISTS (SELECT 1 FROM folio_posting r WHERE r.tenant_id = p.tenant_id AND r.reverses_posting_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM invoice_posting ip JOIN invoice i ON i.tenant_id = ip.tenant_id AND i.id = ip.invoice_id AND i.doc_type = 'TAX_INVOICE'
                          WHERE ip.tenant_id = p.tenant_id AND ip.posting_id = p.id AND NOT EXISTS (SELECT 1 FROM invoice c WHERE c.tenant_id = i.tenant_id AND c.credits_invoice_id = i.id))
        ORDER BY p.business_date, p.seq`.execute(trx);
      if (!rows.rows.length) throw fail(422, 'NOTHING_TO_INVOICE', 'Everything on this bill is already on an invoice');

      const taxByParent = new Map<string, typeof rows.rows>();
      for (const r of rows.rows) if (r.posting_type === 'TAX' && r.parent_posting_id) taxByParent.set(r.parent_posting_id, [...(taxByParent.get(r.parent_posting_id) ?? []), r]);
      const ids = new Set(rows.rows.map((r) => r.id));
      const lines: InvoiceLine[] = [];
      for (const r of rows.rows) {
        if (r.posting_type === 'TAX' && r.parent_posting_id && ids.has(r.parent_posting_id)) continue;           // shown on its charge's line
        const taxes = r.posting_type === 'TAX' ? [r] : (taxByParent.get(r.id) ?? []);
        lines.push({ postingId: r.id, date: r.business_date, description: r.posting_type === 'TAX' ? `${r.description ?? 'Tax'} (on an item invoiced earlier)` : r.description ?? r.txn_code, txnCode: r.txn_code, quantity: Number(r.quantity),
          unitMinor: r.unit_price_minor, netMinor: r.posting_type === 'TAX' ? '0' : r.amount_minor, taxMinor: taxes.reduce((a, t) => a + BigInt(t.amount_minor), 0n).toString(),
          taxes: taxes.map((t) => ({ code: t.tax_code ?? 'TAX', rateBp: t.tax_rate_bp ?? 0, taxableMinor: t.taxable_minor ?? '0', taxMinor: t.amount_minor })) });
      }
      const net = lines.reduce((a, l) => a + BigInt(l.netMinor), 0n), tax = lines.reduce((a, l) => a + BigInt(l.taxMinor), 0n);
      if (net < 0n) throw fail(422, 'NEGATIVE_INVOICE', 'The items to invoice add up to less than zero. Correct the bill first.');
      const summary = new Map<string, TaxSummaryRow>();
      for (const l of lines) for (const t of l.taxes) { const k = `${t.code}:${t.rateBp}`; const e = summary.get(k) ?? { code: t.code, rateBp: t.rateBp, taxableMinor: '0', taxMinor: '0' }; e.taxableMinor = (BigInt(e.taxableMinor) + BigInt(t.taxableMinor)).toString(); e.taxMinor = (BigInt(e.taxMinor) + BigInt(t.taxMinor)).toString(); summary.set(k, e); }

      const le = await trx.selectFrom('legal_entity').selectAll().where('id', '=', p.legal_entity_id).executeTakeFirstOrThrow();
      const stay = await trx.selectFrom('reservation_room').select(['arrival', 'departure', 'room_type_id', 'status']).where('reservation_id', '=', reservationId).where('status', 'in', ['CHECKED_OUT', 'CANCELLED', 'NO_SHOW']).execute();
      const rooms = await sql<{ number: string }>`SELECT DISTINCT rm.number FROM room_assignment a JOIN room rm ON rm.id = a.room_id JOIN reservation_room l ON l.id = a.assignment_ref WHERE l.reservation_id = ${reservationId} ORDER BY rm.number`.execute(trx);
      const pays = await trx.selectFrom('payment').select(['kind', 'method', 'amount_minor']).where('folio_id', '=', folio.id).where('status', '=', 'CAPTURED').execute();
      const paid = new Map<string, bigint>();
      for (const x of pays) { const k = `${x.method}`; paid.set(k, (paid.get(k) ?? 0n) + (x.kind === 'REFUND' ? -BigInt(x.amount_minor) : BigInt(x.amount_minor))); }

      const n = await this.nextNumber(trx, le.id, 'INV', p.business_date, le.fiscal_year_start_month);
      const issuer = { name: le.name, ntn: le.ntn, strn: le.strn, address: le.address, property: p.name };
      const billTo = i.billTo ? { name: i.billTo.name, ntn: i.billTo.ntn ?? null, strn: i.billTo.strn ?? null, address: i.billTo.address ?? null } : { name: res.full_name, phone: res.phone, nationality: res.nationality };
      const reference = { confirmationNo: res.confirmation_no, folioNo: folio.folio_no, arrival: stay.length ? stay.map((s) => s.arrival).sort()[0] : null, departure: stay.length ? stay.map((s) => s.departure).sort().reverse()[0] : null, rooms: rooms.rows.map((r) => r.number) };
      const payments = { received: [...paid.entries()].map(([method, amt]) => ({ method, amountMinor: amt.toString() })), balanceAtIssueMinor: folio.balance_minor };
      const content = { number: n.number, issueDate: p.business_date, issuer, billTo, lines, taxSummary: [...summary.values()], netMinor: net.toString(), taxMinor: tax.toString(), currency: p.currency, reference };
      const inv = await trx.insertInto('invoice').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, legal_entity_id: le.id, folio_id: folio.id, reservation_id: reservationId, doc_type: 'TAX_INVOICE', series: 'INV', fiscal_year: n.fiscalYear,
        seq: n.seq, number: n.number, issue_date: p.business_date, currency: p.currency, issuer: JSON.stringify(issuer), bill_to: JSON.stringify(billTo), lines: JSON.stringify(lines), tax_summary: JSON.stringify([...summary.values()]), payments: JSON.stringify(payments),
        reference: JSON.stringify(reference), net_minor: net.toString(), tax_minor: tax.toString(), total_minor: (net + tax).toString(), content_hash: this.hash(content), issued_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('invoice_posting').values(rows.rows.map((r) => ({ tenant_id: currentTenant().tenantId, invoice_id: inv.id, posting_id: r.id })) as never).execute();
      await this.audit.record(trx, { action: 'invoice.issue', resourceType: 'invoice', resourceId: inv.id, propertyId, after: { number: n.number, net: net.toString(), tax: tax.toString(), reservation: res.confirmation_no } });
      await this.outbox.publish(trx, { aggregateType: 'invoice', aggregateId: inv.id, eventType: 'InvoiceIssued', propertyId, businessDate: p.business_date, payload: { invoiceId: inv.id, number: n.number, reservationId, totalMinor: (net + tax).toString(), currency: p.currency } });
      const warnings = [!le.ntn && 'ISSUER_NTN_MISSING', !le.strn && 'ISSUER_STRN_MISSING'].filter(Boolean);
      return { ...(await this.viewIn(trx, inv.id)), warnings };
    });
  }

  // ───────────── credit note ─────────────
  /** Reverses a whole invoice. The folio's postings are untouched (correct them with reversals if the bill was wrong); the invoiced items become available for a fresh invoice. */
  async credit(propertyId: string, invoiceId: string, userId: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['business_date', 'currency']).where('id', '=', propertyId).executeTakeFirstOrThrow();
      const inv = await trx.selectFrom('invoice').selectAll().where('id', '=', invoiceId).where('property_id', '=', propertyId).executeTakeFirst();
      if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found' });
      await trx.selectFrom('folio').select('id').where('id', '=', inv.folio_id).forUpdate().executeTakeFirstOrThrow();           // serialises credit notes and issues on the same folio (the invoice table itself is append-only)
      if (inv.doc_type !== 'TAX_INVOICE') throw fail(422, 'NOT_CREDITABLE', 'A credit note cannot be credited');
      if (await trx.selectFrom('invoice').select('id').where('credits_invoice_id', '=', invoiceId).executeTakeFirst()) throw fail(409, 'ALREADY_CREDITED', 'This invoice already has a credit note');
      const le = await trx.selectFrom('legal_entity').select(['fiscal_year_start_month']).where('id', '=', inv.legal_entity_id).executeTakeFirstOrThrow();
      const neg = (v: string) => (-BigInt(v)).toString();
      const lines = (inv.lines as InvoiceLine[]).map((l) => ({ ...l, netMinor: neg(l.netMinor), taxMinor: neg(l.taxMinor), taxes: l.taxes.map((t) => ({ ...t, taxableMinor: neg(t.taxableMinor), taxMinor: neg(t.taxMinor) })) }));
      const summary = (inv.tax_summary as TaxSummaryRow[]).map((t) => ({ ...t, taxableMinor: neg(t.taxableMinor), taxMinor: neg(t.taxMinor) }));
      const n = await this.nextNumber(trx, inv.legal_entity_id, 'CN', p.business_date, le.fiscal_year_start_month);
      const reference = { ...(inv.reference as object), creditsInvoiceNumber: inv.number };
      const content = { number: n.number, issueDate: p.business_date, issuer: inv.issuer, billTo: inv.bill_to, lines, taxSummary: summary, netMinor: neg(inv.net_minor), taxMinor: neg(inv.tax_minor), currency: inv.currency, reference, reason };
      const cn = await trx.insertInto('invoice').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, legal_entity_id: inv.legal_entity_id, folio_id: inv.folio_id, reservation_id: inv.reservation_id, doc_type: 'CREDIT_NOTE', series: 'CN',
        fiscal_year: n.fiscalYear, seq: n.seq, number: n.number, issue_date: p.business_date, currency: inv.currency, issuer: JSON.stringify(inv.issuer), bill_to: JSON.stringify(inv.bill_to), lines: JSON.stringify(lines), tax_summary: JSON.stringify(summary),
        payments: JSON.stringify({ received: [], balanceAtIssueMinor: '0' }), reference: JSON.stringify(reference), net_minor: neg(inv.net_minor), tax_minor: neg(inv.tax_minor), total_minor: neg(inv.total_minor), credits_invoice_id: invoiceId, reason,
        content_hash: this.hash(content), issued_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'invoice.credit', resourceType: 'invoice', resourceId: cn.id, propertyId, before: { number: inv.number, total: inv.total_minor }, after: { number: n.number }, reasonCode: 'CREDIT_NOTE', note: reason });
      await this.outbox.publish(trx, { aggregateType: 'invoice', aggregateId: cn.id, eventType: 'CreditNoteIssued', propertyId, businessDate: p.business_date, payload: { creditNoteId: cn.id, number: n.number, creditsInvoiceId: invoiceId, totalMinor: neg(inv.total_minor), reason } });
      return this.viewIn(trx, cn.id);
    });
  }

  // ───────────── reading ─────────────
  async viewIn(trx: Trx, id: string) {
    const r = await trx.selectFrom('invoice').selectAll().where('id', '=', id).executeTakeFirst();
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found' });
    const c = r.currency;
    const credit = r.doc_type === 'TAX_INVOICE' ? await trx.selectFrom('invoice').select(['id', 'number']).where('credits_invoice_id', '=', id).executeTakeFirst() : null;
    return {
      id: r.id, docType: r.doc_type, number: r.number, issueDate: r.issue_date, issuedAt: r.issued_at, currency: c, issuer: r.issuer, billTo: r.bill_to, reference: r.reference, reservationId: r.reservation_id, folioId: r.folio_id,
      lines: (r.lines as InvoiceLine[]).map((l) => ({ ...l, net: fmt(l.netMinor, c), tax: fmt(l.taxMinor, c), unit: l.unitMinor ? fmt(l.unitMinor, c) : null })),
      taxSummary: (r.tax_summary as TaxSummaryRow[]).map((t) => ({ code: t.code, ratePercent: t.rateBp / 100, taxable: fmt(t.taxableMinor, c), tax: fmt(t.taxMinor, c) })),
      net: fmt(r.net_minor, c), tax: fmt(r.tax_minor, c), total: fmt(r.total_minor, c), payments: r.payments, creditsInvoiceId: r.credits_invoice_id, creditedBy: credit ? { id: credit.id, number: credit.number } : null, reason: r.reason, contentHash: r.content_hash,
    };
  }
  async get(propertyId: string, id: string) {
    return this.tdb.tx(async (trx) => { if (!(await trx.selectFrom('invoice').select('id').where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst())) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found' }); return this.viewIn(trx, id); });
  }
  async forReservation(propertyId: string, reservationId: string) {
    return this.tdb.tx(async (trx) => {
      const rows = await trx.selectFrom('invoice').select(['id']).where('property_id', '=', propertyId).where('reservation_id', '=', reservationId).orderBy('issued_at').orderBy('number').execute();
      const out = []; for (const r of rows) out.push(await this.viewIn(trx, r.id));
      return { items: out };
    });
  }
  async search(propertyId: string, number: string) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.selectFrom('invoice').select('id').where('property_id', '=', propertyId).where('number', '=', number.trim().toUpperCase()).executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found' });
      return this.viewIn(trx, r.id);
    });
  }
}
