import { randomBytes } from 'node:crypto';
import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { ArService } from '../companies/ar.service.js';
import { fmt, type Trx } from '../companies/companies.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { PaymentsService } from '../folio/payments.service.js';
import { InvoiceService } from '../invoices/invoice.service.js';
import { renderInvoiceHtml } from '../invoices/render.js';
import { MediaService, mediaUrl } from '../media/media.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant, runWithTenant } from '../tenancy/tenant-context.js';
import { renderDocument, fmtAmt, type Brand, type Doc } from './render.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const TOKEN = /^[0-9a-f]{32}-[0-9a-f]{32}$/; const HEX = /^[0-9a-f]{32}$/;
const toUuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
const METHOD: Record<string, string> = { CASH: 'Cash', CARD_SLIP: 'Card', WALLET: 'Wallet', BANK_TRANSFER: 'Bank transfer' };
const day = (d: string | Date) => new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const MAX_OPEN_SLIPS = 5;

/** The property's printable documents and the bank-transfer slips: what staff and guests can open, print and upload. */
@Injectable()
export class DocumentsService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(MediaService) private readonly media: MediaService,
    @Inject(OutboxService) private readonly outbox: OutboxService, @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(InvoiceService) private readonly invoices: InvoiceService, @Inject(ArService) private readonly ar: ArService,
  ) {}

  // ───────────── the look ─────────────
  async brand(trx: Trx, propertyId: string): Promise<Brand> {
    const p = await trx.selectFrom('property').select(['name', 'address', 'city', 'phone', 'brand_color', 'logo_file', 'receipt_footer']).where('id', '=', propertyId).executeTakeFirstOrThrow();
    return { name: p.name, address: p.address, city: p.city, phone: p.phone, color: p.brand_color ?? '#1d4e5f', logoUrl: p.logo_file ? mediaUrl(currentTenant().tenantId, p.logo_file, '') : null, footer: p.receipt_footer };
  }
  async setLogo(propertyId: string, userId: string, data: Buffer) {
    const stored = await this.media.storePublic(data);
    try {
      if (stored.kind !== 'IMAGE') throw fail(422, 'MEDIA_TYPE_UNSUPPORTED', 'The logo must be a JPG, PNG or WebP picture');
      const old = await this.tdb.tx(async (trx) => {
        const p = await trx.selectFrom('property').select('logo_file').where('id', '=', propertyId).executeTakeFirst();
        if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
        await trx.updateTable('property').set({ logo_file: stored.fileName } as never).where('id', '=', propertyId).execute();
        await this.audit.record(trx, { action: 'property.logo_set', resourceType: 'property', resourceId: propertyId, propertyId });
        return p.logo_file;
      });
      if (old) await this.media.removePublic(old);
      return { logoUrl: mediaUrl(currentTenant().tenantId, stored.fileName, '') };
    } catch (e) { await this.media.removePublic(stored.fileName); throw e; }
  }
  async removeLogo(propertyId: string) {
    const old = await this.tdb.tx(async (trx) => { const p = await trx.selectFrom('property').select('logo_file').where('id', '=', propertyId).executeTakeFirst(); await trx.updateTable('property').set({ logo_file: null } as never).where('id', '=', propertyId).execute(); return p?.logo_file; });
    if (old) await this.media.removePublic(old);
  }

  // ───────────── documents ─────────────
  private async paymentDoc(trx: Trx, propertyId: string, id: string): Promise<Doc> {
    const p = await trx.selectFrom('payment').selectAll().where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found' });
    const f = await trx.selectFrom('folio').select(['folio_no', 'reservation_id', 'company_id', 'guest_id', 'balance_minor', 'currency']).where('id', '=', p.folio_id).executeTakeFirstOrThrow();
    const res = f.reservation_id ? await trx.selectFrom('reservation').select(['confirmation_no', 'guest_id']).where('id', '=', f.reservation_id).executeTakeFirst() : undefined;
    const gid = res?.guest_id ?? f.guest_id;
    const guest = gid ? await trx.selectFrom('guest').select('full_name').where('id', '=', gid).executeTakeFirst() : undefined;
    const co = f.company_id ? await trx.selectFrom('company').select('name').where('id', '=', f.company_id).executeTakeFirst() : undefined;
    const original = p.refund_of_payment_id ? await trx.selectFrom('payment').select('receipt_no').where('id', '=', p.refund_of_payment_id).executeTakeFirst() : undefined;
    const refund = p.kind === 'REFUND'; const amt = { amount: Money.ofMinor(BigInt(p.amount_minor), p.currency).toDecimalString(), currency: p.currency };
    const status = p.status === 'CAPTURED' ? { text: refund ? 'REFUNDED' : 'PAID', tone: 'ok' as const } : p.status === 'PENDING_VERIFICATION' ? { text: 'RECEIVED — AWAITING BANK CONFIRMATION', tone: 'warn' as const } : p.status === 'VOIDED' ? { text: 'VOID', tone: 'bad' as const } : { text: 'NOT ACCEPTED', tone: 'bad' as const };
    return {
      title: refund ? 'REFUND VOUCHER' : p.kind === 'DEPOSIT' ? 'RECEIPT — ADVANCE DEPOSIT' : 'RECEIPT', number: p.receipt_no, status,
      meta: [[refund ? 'Paid to' : 'Received from', guest?.full_name ?? co?.name ?? null], ['Booking', res?.confirmation_no ?? null], ['Bill', f.folio_no], ['Date', day(p.business_date)], ['Method', METHOD[p.method] ?? p.method],
        ['Reference', p.reference], ['Bank', p.counterparty], ['Card', p.card_last4 ? `•••• ${p.card_last4}` : null], ['Refund of receipt', original?.receipt_no ?? null], ['Note', p.status === 'VOIDED' ? p.void_reason : p.note]],
      totals: [[refund ? 'Amount refunded' : 'Amount received', fmtAmt(amt), true], ['Balance on the bill when printed', fmtAmt({ amount: Money.ofMinor(BigInt(f.balance_minor), f.currency).toDecimalString(), currency: f.currency })]],
      notes: p.status === 'PENDING_VERIFICATION' ? ['A bank transfer is confirmed once the money is seen in the hotel’s account. This page is updated when that happens.'] : [],
    };
  }
  private async statementDoc(trx: Trx, propertyId: string, reservationId: string): Promise<Doc> {
    const r = await trx.selectFrom('reservation').select(['confirmation_no', 'guest_id']).where('id', '=', reservationId).where('property_id', '=', propertyId).executeTakeFirst();
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Booking not found' });
    const f = await trx.selectFrom('folio').selectAll().where('reservation_id', '=', reservationId).where('folio_type', '=', 'GUEST').where('status', '<>', 'VOID').orderBy('created_at').executeTakeFirst();
    if (!f) throw new NotFoundException({ code: 'NOT_FOUND', message: 'There is no bill for this booking yet' });
    const [guest, lines, stay] = await Promise.all([
      trx.selectFrom('guest').select('full_name').where('id', '=', r.guest_id).executeTakeFirstOrThrow(),
      trx.selectFrom('folio_posting').select(['business_date', 'description', 'amount_minor', 'posting_type', 'txn_code', 'seq']).where('folio_id', '=', f.id).orderBy('business_date').orderBy('seq').execute(),
      trx.selectFrom('reservation_room').select(['arrival', 'departure']).where('reservation_id', '=', reservationId).orderBy('arrival').execute(),
    ]);
    const cur = f.currency; const a = (m: bigint) => fmtAmt({ amount: Money.ofMinor(m, cur).toDecimalString(), currency: cur });
    let charges = 0n, credits = 0n;
    const rows = lines.filter((l) => BigInt(l.amount_minor) !== 0n).map((l) => { const m = BigInt(l.amount_minor); if (m > 0n) charges += m; else credits += -m; return [day(l.business_date), l.description ?? l.txn_code, m > 0n ? a(m) : '', m < 0n ? a(-m) : '']; });
    const bal = BigInt(f.balance_minor);
    return {
      title: f.status === 'CLOSED' ? 'FINAL BILL' : 'STATEMENT OF ACCOUNT', number: f.folio_no, status: bal === 0n ? { text: 'SETTLED', tone: 'ok' } : bal > 0n ? { text: 'BALANCE DUE', tone: 'warn' } : { text: 'CREDIT BALANCE', tone: 'ok' },
      meta: [['Guest', guest.full_name], ['Booking', r.confirmation_no], ['Stay', stay.length ? `${day(stay[0]!.arrival)} → ${day(stay[stay.length - 1]!.departure)}` : null]],
      table: { head: ['Date', 'Description', `Charges`, `Payments`], rows, right: [2, 3] },
      totals: [['Total charges', a(charges)], ['Total payments and credits', a(credits)], [bal > 0n ? 'Balance due' : bal < 0n ? 'Credit balance' : 'Balance', a(bal < 0n ? -bal : bal), true]],
      notes: f.status === 'CLOSED' ? ['Thank you for staying with us.'] : ['This statement is as of the time it was opened and may change until check-out.'],
    };
  }
  private async orderDoc(trx: Trx, propertyId: string, id: string): Promise<Doc> {
    const o = await trx.selectFrom('fnb_order').selectAll().where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst();
    if (!o) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found' });
    const ls = (await trx.selectFrom('fnb_order_line').selectAll().where('order_id', '=', id).orderBy('name').execute()) as Array<{ name: string; quantity: number; unit_price_minor: string; line_minor: string; note: string | null; variant_name?: string | null; modifiers?: unknown; removed?: string[] }>;   // sizes, extras and removals exist once the menu work is in
    const cur = o.currency; const a = (m: bigint | string) => fmtAmt({ amount: Money.ofMinor(BigInt(m), cur).toDecimalString(), currency: cur });
    const mods = (l: (typeof ls)[number]) => ((l.modifiers as Array<{ name: string }> | undefined) ?? []).map((m) => m.name);
    return {
      title: 'ROOM SERVICE ORDER', number: o.number, status: o.status === 'CANCELLED' ? { text: 'CANCELLED', tone: 'bad' } : o.status === 'DELIVERED' ? { text: 'DELIVERED', tone: 'ok' } : { text: o.status, tone: 'warn' },
      meta: [['Room', o.room_number], ['Guest', o.guest_name], ['Ordered', new Date(o.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })], ['Note', o.note]],
      table: { head: ['Qty', 'Item', 'Price', 'Total'], rows: ls.map((l) => [String(l.quantity), [l.name, l.variant_name && `(${l.variant_name})`, mods(l).length ? `+ ${mods(l).join(', ')}` : '', l.removed?.length ? `— no ${l.removed.join(', ')}` : '', l.note && `— ${l.note}`].filter(Boolean).join(' '), a(l.unit_price_minor), a(l.line_minor)]), right: [0, 2, 3] },
      totals: [['Total', a(o.total_minor), true]], notes: [o.pay_digital ? 'Paid digitally (card, wallet or bank).' : 'Charged to the room bill.'],
    };
  }
  private async build(trx: Trx, propertyId: string, kind: (typeof import('./schemas.js'))['KINDS'][number], refId: string) {
    return kind === 'PAYMENT' ? this.paymentDoc(trx, propertyId, refId) : kind === 'STATEMENT' ? this.statementDoc(trx, propertyId, refId) : this.orderDoc(trx, propertyId, refId);
  }
  /** A document for staff, drawn now. */
  async html(propertyId: string, kind: (typeof import('./schemas.js'))['KINDS'][number], refId: string, nonce: string) {
    if (kind === 'INVOICE') return renderInvoiceHtml((await this.invoices.get(propertyId, refId)) as never);
    return this.tdb.tx(async (trx) => renderDocument(await this.brand(trx, propertyId), await this.build(trx, propertyId, kind, refId), nonce));
  }
  /** The private link to a document: one live link per document, made on first use. */
  async linkFor(propertyId: string, i: z.infer<typeof S.LinkBody>, userId: string | null, origin?: string) {
    const tenantId = currentTenant().tenantId;
    return this.tdb.tx(async (trx) => {
      if (i.kind === 'INVOICE') await this.invoices.get(propertyId, i.refId); else await this.build(trx, propertyId, i.kind, i.refId);       // the document must exist, and belong to this property
      const had = await trx.selectFrom('document_link').select(['token']).where('kind', '=', i.kind).where('ref_id', '=', i.refId).where('revoked_at', 'is', null).executeTakeFirst();
      if (!had) await trx.insertInto('document_link').values({ tenant_id: tenantId, property_id: propertyId, kind: i.kind, ref_id: i.refId, token: `${tenantId.replace(/-/g, '')}-${randomBytes(16).toString('hex')}`, created_by: userId } as never)
        .onConflict((oc) => oc.columns(['tenant_id', 'kind', 'ref_id']).where('revoked_at', 'is', null).doNothing()).execute();
      const l = (had ?? (await trx.selectFrom('document_link').select(['token']).where('kind', '=', i.kind).where('ref_id', '=', i.refId).where('revoked_at', 'is', null).executeTakeFirstOrThrow()));
      if (!had) await this.audit.record(trx, { action: 'document.link_create', resourceType: i.kind.toLowerCase(), resourceId: i.refId, propertyId });
      return { token: l.token, url: `${(origin ?? process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/v1/guest/doc/${l.token}` };
    });
  }
  async revoke(propertyId: string, i: z.infer<typeof S.LinkBody>) {
    return this.tdb.tx(async (trx) => { await trx.updateTable('document_link').set({ revoked_at: sql`now()` } as never).where('property_id', '=', propertyId).where('kind', '=', i.kind).where('ref_id', '=', i.refId).where('revoked_at', 'is', null).execute(); return { ok: true }; });
  }
  /** What a guest opens from the link. The tenant comes from the token and is then enforced by row-level security like any other request. */
  async htmlByToken(token: string, nonce: string): Promise<string | null> {
    if (!TOKEN.test(token) || !HEX.test(token.slice(0, 32))) return null;
    return runWithTenant({ tenantId: toUuid(token.slice(0, 32)) }, () => this.tdb.tx(async (trx) => {
      const l = await trx.selectFrom('document_link').selectAll().where('token', '=', token).where('revoked_at', 'is', null).executeTakeFirst();
      if (!l || (l.expires_at && new Date(l.expires_at) < new Date())) return null;
      if (l.kind === 'QUOTATION') return null;                 // quotations have their own page and answer form
      if (l.kind === 'COMPANY_STATEMENT') {
        const cdoc = await this.companyDoc(l.ref_id).catch(() => null);
        if (!cdoc) return null;
        await trx.updateTable('document_link').set({ views: sql`views + 1`, last_viewed_at: sql`now()` } as never).where('id', '=', l.id).execute();
        return renderDocument(await this.brand(trx, l.property_id), cdoc, nonce);
      }
      const inv = l.kind === 'INVOICE' ? await this.invoices.get(l.property_id, l.ref_id).catch(() => null) : null;
      const doc = l.kind === 'INVOICE' ? null : await this.build(trx, l.property_id, l.kind, l.ref_id).catch(() => null);
      if (!doc && !inv) return null;
      await trx.updateTable('document_link').set({ views: sql`views + 1`, last_viewed_at: sql`now()` } as never).where('id', '=', l.id).execute();
      return inv ? renderInvoiceHtml(inv as never) : renderDocument(await this.brand(trx, l.property_id), doc!, nonce);
    }));
  }

  // ───────────── a company's account statement ─────────────
  /** The company's account for the last 90 days, with ageing: what is shown when someone opens the company's private link. */
  private async companyDoc(companyId: string): Promise<Doc> {
    const probe = await this.ar.statement(companyId);                      // with no dates it ends on the property's current business date
    const to = probe.to; const from = new Date(new Date(`${to}T00:00:00Z`).getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
    const v = await this.ar.statement(companyId, from, to);
    const a = (x: { amount: string; currency: string }) => fmtAmt(x);
    const kind: Record<string, string> = { BILLED: 'Billed', CANCELLED: 'Cancelled', RECEIPT: 'Received', WITHHELD: 'Tax withheld' };
    const buckets: Array<[string, string]> = [['current', 'Not yet due'], ['d1_30', '1–30 days overdue'], ['d31_60', '31–60 days overdue'], ['d61_90', '61–90 days overdue'], ['d90plus', 'Over 90 days overdue']];
    const aged = buckets.filter(([k]) => v.aging.buckets[k as never] && (v.aging.buckets[k as never] as { amount: string }).amount !== '0.00').map(([k, l]) => `${l}: ${a(v.aging.buckets[k as never] as never)}`);
    const closing = BigInt(String(v.closing.amount).replace(/[^0-9-]/g, '') || '0');
    return {
      title: 'STATEMENT OF ACCOUNT', number: null, status: closing === 0n ? { text: 'SETTLED', tone: 'ok' } : closing > 0n ? { text: 'BALANCE DUE', tone: 'warn' } : { text: 'CREDIT BALANCE', tone: 'ok' },
      meta: [['Company', v.company.name], ['NTN', v.company.ntn], ['STRN', v.company.strn], ['Address', v.company.address], ['Period', `${day(v.from)} → ${day(v.to)}`], ['Payment terms', `Net ${v.company.termsDays} days`]],
      table: { head: ['Date', 'Details', 'Billed', 'Received', 'Balance'], rows: [['', 'Balance brought forward', '', '', a(v.opening as never)], ...v.lines.map((l) => [day(l.date), [kind[l.kind] ?? l.kind, l.ref, l.text].filter(Boolean).join(' · '), l.debit.amount === '0.00' ? '' : a(l.debit as never), l.credit.amount === '0.00' ? '' : a(l.credit as never), a(l.balance as never)])], right: [2, 3, 4] },
      totals: [['Billed in the period', a(v.billed as never)], ['Received in the period', a(v.received as never)], ['Balance due', a(v.closing as never), true]],
      notes: aged.length ? [`Ageing — ${aged.join(' · ')}`] : undefined,
    };
  }
  /** The private link to a company's statement. One live link per company; the page always shows the account as it stands. */
  async companyLink(propertyId: string, companyId: string, userId: string | null, origin?: string) {
    const tenantId = currentTenant().tenantId;
    await this.tdb.tx(async (trx) => { if (!(await trx.selectFrom('company').select('id').where('id', '=', companyId).executeTakeFirst())) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found' }); });
    return this.tdb.tx(async (trx) => {
      const had = await trx.selectFrom('document_link').select(['token']).where('kind', '=', 'COMPANY_STATEMENT').where('ref_id', '=', companyId).where('revoked_at', 'is', null).executeTakeFirst();
      if (!had) await trx.insertInto('document_link').values({ tenant_id: tenantId, property_id: propertyId, kind: 'COMPANY_STATEMENT', ref_id: companyId, token: `${tenantId.replace(/-/g, '')}-${randomBytes(16).toString('hex')}`, created_by: userId } as never)
        .onConflict((oc) => oc.columns(['tenant_id', 'kind', 'ref_id']).where('revoked_at', 'is', null).doNothing()).execute();
      const l = (had ?? (await trx.selectFrom('document_link').select(['token']).where('kind', '=', 'COMPANY_STATEMENT').where('ref_id', '=', companyId).where('revoked_at', 'is', null).executeTakeFirstOrThrow()));
      if (!had) await this.audit.record(trx, { action: 'document.link_create', resourceType: 'company_statement', resourceId: companyId, propertyId });
      return { token: l.token, url: `${(origin ?? process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/v1/guest/doc/${l.token}` };
    });
  }
  async companyRevoke(propertyId: string, companyId: string) {
    return this.tdb.tx(async (trx) => {
      await trx.updateTable('document_link').set({ revoked_at: sql`now()` } as never).where('kind', '=', 'COMPANY_STATEMENT').where('ref_id', '=', companyId).where('revoked_at', 'is', null).execute();
      await this.audit.record(trx, { action: 'document.link_revoke', resourceType: 'company_statement', resourceId: companyId, propertyId });
      return { revoked: true };
    });
  }
  /** For staff, drawn now. */
  async companyHtml(propertyId: string, companyId: string, nonce: string) {
    const doc = await this.companyDoc(companyId);
    return this.tdb.tx(async (trx) => renderDocument(await this.brand(trx, propertyId), doc, nonce));
  }

  // ───────────── bank-transfer slips ─────────────
  private slipView(s: { id: string; reservation_id: string | null; payment_id: string | null; source: string; claimed_amount_minor: string | null; reference: string | null; bank: string | null; note: string | null; status: string; reject_reason: string | null; submitted_at: Date; confirmation_no?: string | null; guest?: string | null; receipt_no?: string | null }, cur: string) {
    return { id: s.id, reservationId: s.reservation_id, paymentId: s.payment_id, source: s.source, claimed: s.claimed_amount_minor === null ? null : fmt(s.claimed_amount_minor, cur), reference: s.reference, bank: s.bank, note: s.note, status: s.status, rejectReason: s.reject_reason, submittedAt: s.submitted_at, confirmationNo: s.confirmation_no ?? null, guest: s.guest ?? null, receiptNo: s.receipt_no ?? null };
  }
  /** A guest sends the picture or PDF of their transfer from their booking page. It waits for the desk, who match it to the money in the bank. */
  async submitGuest(reservationId: string, data: Buffer, f: z.infer<typeof S.SlipFields>) {
    const stored = await this.media.storePrivate(data);
    try {
      return await this.tdb.tx(async (trx) => {
        const r = await trx.selectFrom('reservation').select(['id', 'property_id', 'status', 'currency']).where('id', '=', reservationId).executeTakeFirstOrThrow();
        if (!['CONFIRMED', 'OPTION', 'CHECKED_IN'].includes(r.status)) throw fail(409, 'BOOKING_CLOSED', 'This booking is no longer open');
        const open = await trx.selectFrom('payment_slip').select('id').where('reservation_id', '=', reservationId).where('status', '=', 'SUBMITTED').execute();
        if (open.length >= MAX_OPEN_SLIPS) throw fail(429, 'TOO_MANY_SLIPS', 'The hotel already has several slips from you to check. Please wait for them to be confirmed.');
        const prop = await trx.selectFrom('property').select(['currency', 'business_date']).where('id', '=', r.property_id).executeTakeFirstOrThrow();
        const s = await trx.insertInto('payment_slip').values({ tenant_id: currentTenant().tenantId, property_id: r.property_id, reservation_id: reservationId, source: 'GUEST', file_name: stored.fileName, content_type: stored.contentType, size_bytes: String(stored.size),
          claimed_amount_minor: f.amount ? Money.parse(f.amount, prop.currency).minor.toString() : null, reference: f.reference || null, bank: f.bank || null, note: f.note || null } as never).returning('id').executeTakeFirstOrThrow();
        await this.outbox.publish(trx, { aggregateType: 'payment_slip', aggregateId: s.id, eventType: 'PaymentSlipSubmitted', propertyId: r.property_id, businessDate: prop.business_date, payload: { slipId: s.id, reservationId } });
        return { id: s.id, status: 'SUBMITTED' as const };
      });
    } catch (e) { await this.media.removePrivate(stored.fileName); throw e; }
  }
  async slips(propertyId: string, q: z.infer<typeof S.SlipQuery>) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select('currency').where('id', '=', propertyId).executeTakeFirstOrThrow();
      let qb = trx.selectFrom('payment_slip as s').leftJoin('reservation as r', 'r.id', 's.reservation_id').leftJoin('guest as g', 'g.id', 'r.guest_id').leftJoin('payment as pay', 'pay.id', 's.payment_id')
        .select(['s.id', 's.reservation_id', 's.payment_id', 's.source', 's.claimed_amount_minor', 's.reference', 's.bank', 's.note', 's.status', 's.reject_reason', 's.submitted_at', 'r.confirmation_no', 'g.full_name as guest', 'pay.receipt_no'])
        .where('s.property_id', '=', propertyId).orderBy('s.submitted_at', q.status === 'SUBMITTED' ? 'asc' : 'desc').limit(q.limit);
      if (q.status !== 'ALL') qb = qb.where('s.status', '=', q.status);
      const rows = await qb.execute();
      return { items: rows.map((s) => this.slipView(s as never, p.currency)) };
    });
  }
  async slipsOfPayment(propertyId: string, paymentId: string) {
    return this.tdb.tx(async (trx) => {
      const rows = await trx.selectFrom('payment_slip').select(['id', 'source', 'submitted_at']).where('property_id', '=', propertyId).where('payment_id', '=', paymentId).orderBy('submitted_at').execute();
      return { items: rows.map((s) => ({ id: s.id, source: s.source, at: s.submitted_at })) };
    });
  }
  async slipFile(propertyId: string, id: string) {
    const s = await this.tdb.tx((trx) => trx.selectFrom('payment_slip').select(['file_name']).where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst());
    if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Slip not found' });
    return this.media.openPrivate(s.file_name);
  }
  /** The desk enters the money from a guest's slip: it becomes a bank transfer waiting for verification, and the slip is attached to it. */
  async recordFromSlip(propertyId: string, id: string, userId: string, i: z.infer<typeof S.SlipRecord>) {
    const s = await this.tdb.tx((trx) => trx.selectFrom('payment_slip').selectAll().where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst());
    if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Slip not found' });
    if (s.status !== 'SUBMITTED') throw fail(409, 'WRONG_STATE', `A slip that is ${s.status.toLowerCase()} cannot be recorded again`);
    if (!s.reservation_id) throw fail(422, 'NO_BOOKING', 'This slip is not for a booking');
    const r = await this.payments.record(propertyId, s.reservation_id, userId, `slip:${id}`, { kind: i.kind, method: 'BANK_TRANSFER', amount: i.amount, reference: i.reference, counterparty: i.counterparty, paymentAccountId: i.paymentAccountId ?? null, note: i.note ?? null } as never);
    await this.tdb.tx(async (trx) => {
      await trx.updateTable('payment_slip').set({ status: 'LINKED', payment_id: r.payment.id, handled_by: userId, handled_at: sql`now()` } as never).where('id', '=', id).where('status', '=', 'SUBMITTED').execute();
      await this.audit.record(trx, { action: 'payment.slip_record', resourceType: 'payment_slip', resourceId: id, propertyId, after: { paymentId: r.payment.id, amount: i.amount } });
    });
    return r;
  }
  async rejectSlip(propertyId: string, id: string, userId: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      const s = await trx.selectFrom('payment_slip').select(['status']).where('id', '=', id).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
      if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Slip not found' });
      if (s.status !== 'SUBMITTED') throw fail(409, 'WRONG_STATE', `A slip that is ${s.status.toLowerCase()} cannot be rejected`);
      await trx.updateTable('payment_slip').set({ status: 'REJECTED', reject_reason: reason, handled_by: userId, handled_at: sql`now()` } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'payment.slip_reject', resourceType: 'payment_slip', resourceId: id, propertyId, after: { reason } });
      return { id, status: 'REJECTED' };
    });
  }
  /** The desk keeps the picture of a transfer it recorded itself, so whoever verifies the money can see what the guest sent. */
  async attachToPayment(propertyId: string, paymentId: string, userId: string, data: Buffer) {
    const stored = await this.media.storePrivate(data);
    try {
      return await this.tdb.tx(async (trx) => {
        const pay = await trx.selectFrom('payment as p').innerJoin('folio as f', 'f.id', 'p.folio_id').select(['p.id', 'p.method', 'p.status', 'f.reservation_id']).where('p.id', '=', paymentId).where('p.property_id', '=', propertyId).executeTakeFirst();
        if (!pay) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found' });
        if (pay.method !== 'BANK_TRANSFER') throw fail(422, 'NOT_A_TRANSFER', 'A slip belongs to a bank transfer');
        if (!['PENDING_VERIFICATION', 'CAPTURED'].includes(pay.status)) throw fail(409, 'WRONG_STATE', 'This payment is closed');
        const count = await trx.selectFrom('payment_slip').select('id').where('payment_id', '=', paymentId).execute();
        if (count.length >= 5) throw fail(409, 'TOO_MANY_SLIPS', 'A payment can have up to 5 slips');
        const s = await trx.insertInto('payment_slip').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, reservation_id: pay.reservation_id, payment_id: paymentId, source: 'STAFF', file_name: stored.fileName, content_type: stored.contentType, size_bytes: String(stored.size), status: 'LINKED', submitted_by: userId, handled_by: userId, handled_at: sql`now()` } as never).returning('id').executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'payment.slip_attach', resourceType: 'payment', resourceId: paymentId, propertyId, after: { slipId: s.id } });
        return { id: s.id };
      });
    } catch (e) { await this.media.removePrivate(stored.fileName); throw e; }
  }
  /** For the guest's booking page: what they sent and what became of it. */
  async slipsForGuest(trx: Trx, reservationId: string) {
    const rows = await trx.selectFrom('payment_slip').select(['id', 'status', 'claimed_amount_minor', 'reference', 'reject_reason', 'submitted_at']).where('reservation_id', '=', reservationId).where('source', '=', 'GUEST').orderBy('submitted_at').execute();
    return rows.map((s) => ({ id: s.id, status: s.status, claimedAmountMinor: s.claimed_amount_minor, reference: s.reference, rejectReason: s.reject_reason, submittedAt: s.submitted_at }));
  }
}
