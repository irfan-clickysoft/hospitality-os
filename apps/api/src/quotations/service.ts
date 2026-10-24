import { randomBytes } from 'node:crypto';
import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { DocumentsService } from '../documents/documents.service.js';
import { GuestsService } from '../guests/guests.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { RatesService } from '../rates/rates.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { currentTenant, runWithTenant } from '../tenancy/tenant-context.js';
import { allocateDiscounts, depositOf, groupNights, type Discount } from './pricing.js';
import { renderQuotation } from './render.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const TOKEN = /^[0-9a-f]{32}-[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const toUuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
const SELLER = ['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED'] as const;

type Row = { id: string; property_id: string; number: string; status: string; company_id: string | null; guest_id: string | null; customer_name: string; contact_name: string | null; phone: string | null; email: string | null;
  residency: 'RESIDENT' | 'NON_RESIDENT'; title: string | null; valid_until: string; discount_kind: 'NONE' | 'PCT' | 'AMOUNT'; discount_value: string; discount_reason: string | null; deposit_kind: 'NONE' | 'PCT' | 'AMOUNT'; deposit_value: string;
  special_requests: string | null; amenities: string[]; terms: string | null; notes_internal: string | null; pricing: Pricing | null; version: number; created_at: Date; sent_at: Date | null; viewed_at: Date | null; views: number; responded_at: Date | null;
  responded_name: string | null; responded_note: string | null; desk_seen_at: Date | null; converted_at: Date | null; reservation_ids: string[] };
type LineRow = { id: string; line_no: number; room_type_id: string; rate_plan_id: string | null; rooms: number; arrival: string; departure: string; adults: number; children: number; extra_beds: number; discount_kind: 'NONE' | 'PCT' | 'AMOUNT'; discount_value: string; note: string | null };

export interface PricedLine { lineId: string | null; roomTypeId: string; roomTypeName: string; planId: string; planName: string; mealPlan: string | null; rooms: number; arrival: string; departure: string; nights: number; adults: number; children: number; extraBeds: number;
  bands: Array<{ from: string; to: string; nights: number; rate: string; label: string }>; grossPerRoom: string; gross: string; lineDiscount: string; overallShare: string; discount: string; net: string; tax: string; total: string; roomDiscounts: string[]; roomsLeft: number; warning: string | null; note: string | null }
export interface Pricing { currency: string; lines: PricedLine[]; gross: string; lineDiscounts: string; overallDiscount: string; discount: string; net: string; tax: string; total: string; deposit: { kind: string; amount: string }; computedAt: string }

const hundredths = (v: string) => BigInt(Math.round(Number(v) * 100));
const discountMinor = (kind: 'NONE' | 'PCT' | 'AMOUNT', value: string | undefined, cur: string): Discount => kind === 'PCT' ? { kind, value: hundredths(value!) } : kind === 'AMOUNT' ? { kind, value: Money.parse(value!, cur).minor } : { kind: 'NONE', value: 0n };
const bandLabel = (src: string) => src.startsWith('SEASON:') ? `${src.slice(7)} season` : src === 'WEEKEND' ? 'Weekend rate' : src === 'OVERRIDE' ? 'Special rate' : src.startsWith('DERIVED') ? (src.includes('SEASON:') ? `${src.split('SEASON:')[1]} season` : 'Agreed rate') : '';

/** Quotations: an offer for rooms and dates with discounts, sent as a private page the customer can accept, and turned into a booking by the desk. */
@Injectable()
export class QuotationsService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(RatesService) private readonly rates: RatesService,
    @Inject(ReservationsService) private readonly reservations: ReservationsService, @Inject(GuestsService) private readonly guests: GuestsService, @Inject(DocumentsService) private readonly docs: DocumentsService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  // ───────────── pricing ─────────────
  /** Works out every figure with today's rates (seasons included) and the rules for discounts. Nothing is saved. */
  async price(propertyId: string, userId: string, i: z.infer<typeof S.QuotationBody>, lineIds: Array<string | null> = []): Promise<Pricing> {
    const channel = i.companyId ? 'CORPORATE' : 'DIRECT';
    let cur = 'PKR';
    type Opt = { roomType: { id: string; name: string }; plan: { id: string; name: string; mealPlan: string | null }; sellable: boolean; available: boolean; roomsLeft: number; nights: Array<{ date: string; source: string; total: string }>; subtotal: { amount: string; currency: string };
      totalExTax: { amount: string }; taxTotal: { amount: string }; totalIncTax: { amount: string } };
    const ask = async (l: (typeof i.lines)[number], discountAmount?: string): Promise<{ opts: Opt[]; currency: string }> => {
      const r = await this.rates.quote(propertyId, userId, { arrival: l.arrival, departure: l.departure, adults: l.adults, children: l.children, extraBeds: l.extraBeds, channel, residency: i.residency, companyId: i.companyId ?? null,
        roomTypeId: l.roomTypeId, discountPct: 0, nightDiscounts: [], includeUnavailable: true, ...(discountAmount ? { discountAmount } : {}) } as never);
      return { opts: r.options as unknown as Opt[], currency: r.currency };
    };
    const pick = (opts: Opt[], planId: string | null | undefined) => (planId ? opts.find((o) => o.plan.id === planId) : opts.find((o) => o.sellable && o.available) ?? opts.find((o) => o.sellable));
    const base: Array<{ opt: Opt; gross: bigint }> = [];
    for (const l of i.lines) {
      const { opts, currency } = await ask(l); cur = currency;
      const opt = pick(opts, l.ratePlanId);
      if (!opt || !opt.sellable) throw fail(422, 'NO_RATE', 'No rate applies to this room type for these dates and guests. Check the dates, the number of guests and the rate plan.');
      base.push({ opt, gross: Money.parse(opt.subtotal.amount, cur).minor });
    }
    const alloc = allocateDiscounts(i.lines.map((l, k) => ({ gross: base[k]!.gross, rooms: l.rooms, discount: discountMinor(l.discount.kind, 'value' in l.discount ? l.discount.value : undefined, cur) })), discountMinor(i.discount.kind, 'value' in i.discount ? i.discount.value : undefined, cur));
    const lines: PricedLine[] = []; let tGross = 0n, tLine = 0n, tOverall = 0n, tNet = 0n, tTax = 0n, tTotal = 0n;
    for (const [k, l] of i.lines.entries()) {
      const { opt, gross } = base[k]!; const a = alloc[k]!;
      const taxCache = new Map<string, { net: bigint; tax: bigint }>();
      let lineNet = 0n, lineTax = 0n;
      for (const d of a.roomDiscounts) {
        const key = d.toString();
        if (!taxCache.has(key)) {
          if (d === 0n) taxCache.set(key, { net: Money.parse(opt.totalExTax.amount, cur).minor, tax: Money.parse(opt.taxTotal.amount, cur).minor });
          else { const { opts } = await ask(l, Money.ofMinor(d, cur).toDecimalString()); const o = pick(opts, opt.plan.id); if (!o) throw fail(422, 'NO_RATE', 'The discount could not be applied to this rate'); taxCache.set(key, { net: Money.parse(o.totalExTax.amount, cur).minor, tax: Money.parse(o.taxTotal.amount, cur).minor }); }
        }
        const x = taxCache.get(key)!; lineNet += x.net; lineTax += x.tax;
      }
      const grossAll = gross * BigInt(l.rooms); const disc = a.lineDiscount + a.overallShare;
      const nights = opt.nights.map((n) => ({ date: n.date, source: n.source, total: Money.parse(n.total, cur).minor }));
      lines.push({ lineId: lineIds[k] ?? null, roomTypeId: l.roomTypeId, roomTypeName: opt.roomType.name, planId: opt.plan.id, planName: opt.plan.name, mealPlan: opt.plan.mealPlan, rooms: l.rooms, arrival: l.arrival, departure: l.departure, nights: nights.length,
        adults: l.adults, children: l.children, extraBeds: l.extraBeds, bands: groupNights(nights).map((g) => ({ from: g.from, to: g.to, nights: g.nights, rate: g.rate.toString(), label: bandLabel(g.source) })),
        grossPerRoom: gross.toString(), gross: grossAll.toString(), lineDiscount: a.lineDiscount.toString(), overallShare: a.overallShare.toString(), discount: disc.toString(), net: lineNet.toString(), tax: lineTax.toString(), total: (lineNet + lineTax).toString(),
        roomDiscounts: a.roomDiscounts.map(String), roomsLeft: opt.roomsLeft, warning: opt.roomsLeft < l.rooms ? `Only ${opt.roomsLeft} of this room type ${opt.roomsLeft === 1 ? 'is' : 'are'} free for these dates` : null, note: l.note ?? null });
      tGross += grossAll; tLine += a.lineDiscount; tOverall += a.overallShare; tNet += lineNet; tTax += lineTax; tTotal += lineNet + lineTax;
    }
    const dep = discountMinor(i.deposit.kind, 'value' in i.deposit ? i.deposit.value : undefined, cur);
    return { currency: cur, lines, gross: tGross.toString(), lineDiscounts: tLine.toString(), overallDiscount: tOverall.toString(), discount: (tLine + tOverall).toString(), net: tNet.toString(), tax: tTax.toString(), total: tTotal.toString(),
      deposit: { kind: i.deposit.kind, amount: depositOf(tTotal, dep).toString() }, computedAt: new Date().toISOString() };
  }

  // ───────────── read / write ─────────────
  private async load(trx: Parameters<Parameters<TenantDb['tx']>[0]>[0], propertyId: string, id: string) {
    const q = await trx.selectFrom('quotation').selectAll().where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst();
    if (!q) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Quotation not found' });
    const lines = await trx.selectFrom('quotation_line').selectAll().where('quotation_id', '=', id).orderBy('line_no').execute();
    return { q: q as unknown as Row, lines: lines as unknown as LineRow[] };
  }
  private view(q: Row, lines: LineRow[], bd: string) {
    const expired = q.status === 'SENT' && q.valid_until < bd;
    return { id: q.id, number: q.number, status: q.status, expired, customerName: q.customer_name, companyId: q.company_id, guestId: q.guest_id, contactName: q.contact_name, phone: q.phone, email: q.email, residency: q.residency, title: q.title, validUntil: q.valid_until,
      discount: q.discount_kind === 'NONE' ? { kind: 'NONE' } : { kind: q.discount_kind, value: q.discount_kind === 'PCT' ? String(Number(q.discount_value) / 100) : null, minor: q.discount_kind === 'AMOUNT' ? q.discount_value : null }, discountReason: q.discount_reason,
      deposit: q.deposit_kind === 'NONE' ? { kind: 'NONE' } : { kind: q.deposit_kind, value: q.deposit_kind === 'PCT' ? String(Number(q.deposit_value) / 100) : null, minor: q.deposit_kind === 'AMOUNT' ? q.deposit_value : null },
      specialRequests: q.special_requests, amenities: q.amenities, terms: q.terms, notesInternal: q.notes_internal, pricing: q.pricing, version: q.version, createdAt: q.created_at, sentAt: q.sent_at, viewedAt: q.viewed_at, views: q.views,
      response: q.responded_at ? { at: q.responded_at, name: q.responded_name, note: q.responded_note, seen: !!q.desk_seen_at } : null, convertedAt: q.converted_at, reservationIds: q.reservation_ids,
      lines: lines.map((l) => ({ id: l.id, roomTypeId: l.room_type_id, ratePlanId: l.rate_plan_id, rooms: l.rooms, arrival: l.arrival, departure: l.departure, adults: l.adults, children: l.children, extraBeds: l.extra_beds,
        discount: l.discount_kind === 'NONE' ? { kind: 'NONE' } : { kind: l.discount_kind, value: l.discount_kind === 'PCT' ? String(Number(l.discount_value) / 100) : Money.ofMinor(BigInt(l.discount_value), q.pricing?.currency ?? 'PKR').toDecimalString() }, note: l.note })) };
  }
  private async bd(trx: Parameters<Parameters<TenantDb['tx']>[0]>[0], propertyId: string) { return (await trx.selectFrom('property').select('business_date').where('id', '=', propertyId).executeTakeFirstOrThrow()).business_date as string; }

  async list(propertyId: string, q: z.infer<typeof S.ListQuery>) {
    return this.tdb.tx(async (trx) => {
      const bd = await this.bd(trx, propertyId);
      let qb = trx.selectFrom('quotation').selectAll().where('property_id', '=', propertyId).orderBy('created_at', 'desc').limit(q.limit);
      if (q.status === 'OPEN') qb = qb.where('status', 'in', ['DRAFT', 'SENT', 'ACCEPTED']); else if (q.status !== 'ALL') qb = qb.where('status', '=', q.status);
      if (q.q) { const like = `%${q.q.replace(/[%_\\]/g, '\\$&')}%`; qb = qb.where((eb) => eb.or([eb('customer_name', 'ilike', like), eb('number', 'ilike', like), eb('contact_name', 'ilike', like)])); }
      const rows = (await qb.execute()) as unknown as Row[];
      const counts = await sql<{ status: string; n: number }>`SELECT status, count(*)::int AS n FROM quotation WHERE tenant_id = ${currentTenant().tenantId} AND property_id = ${propertyId} GROUP BY status`.execute(trx);
      return { items: rows.map((r) => ({ id: r.id, number: r.number, status: r.status, expired: r.status === 'SENT' && r.valid_until < bd, customerName: r.customer_name, validUntil: r.valid_until, total: r.pricing?.total ?? null, currency: r.pricing?.currency ?? null,
        rooms: r.pricing?.lines.reduce((a, l) => a + l.rooms, 0) ?? 0, arrival: r.pricing?.lines.map((l) => l.arrival).sort()[0] ?? null, departure: r.pricing?.lines.map((l) => l.departure).sort().slice(-1)[0] ?? null,
        answered: !!r.responded_at && !r.desk_seen_at && r.status !== 'CONVERTED', views: r.views })), counts: Object.fromEntries(counts.rows.map((c) => [c.status, c.n])) };
    });
  }
  async get(propertyId: string, id: string) { return this.tdb.tx(async (trx) => { const { q, lines } = await this.load(trx, propertyId, id); return this.view(q, lines, await this.bd(trx, propertyId)); }); }

  private async save(trx: Parameters<Parameters<TenantDb['tx']>[0]>[0], propertyId: string, id: string, i: z.infer<typeof S.QuotationBody>, pricing: Pricing, cur: string) {
    const dv = (d: typeof i.discount) => (d.kind === 'NONE' ? 0n : d.kind === 'PCT' ? hundredths(d.value) : Money.parse(d.value, cur).minor);
    await trx.deleteFrom('quotation_line').where('quotation_id', '=', id).execute();
    await trx.insertInto('quotation_line').values(i.lines.map((l, k) => ({ tenant_id: currentTenant().tenantId, quotation_id: id, line_no: k + 1, room_type_id: l.roomTypeId, rate_plan_id: l.ratePlanId ?? pricing.lines[k]!.planId, rooms: l.rooms, arrival: l.arrival, departure: l.departure,
      adults: l.adults, children: l.children, extra_beds: l.extraBeds, discount_kind: l.discount.kind, discount_value: dv(l.discount).toString(), note: l.note ?? null }))).execute();
    return { customer_name: i.customerName, company_id: i.companyId ?? null, guest_id: i.guestId ?? null, contact_name: i.contactName ?? null, phone: i.phone ?? null, email: i.email ?? null, residency: i.residency, title: i.title ?? null, valid_until: i.validUntil,
      discount_kind: i.discount.kind, discount_value: dv(i.discount).toString(), discount_reason: i.discountReason ?? null, deposit_kind: i.deposit.kind, deposit_value: dv(i.deposit).toString(), special_requests: i.specialRequests ?? null,
      amenities: i.amenities, terms: i.terms ?? null, notes_internal: i.notesInternal ?? null, pricing: JSON.stringify(pricing) };
  }
  private async check(trx: Parameters<Parameters<TenantDb['tx']>[0]>[0], i: z.infer<typeof S.QuotationBody>, bd: string) {
    if (i.validUntil < bd) throw fail(422, 'VALIDATION_FAILED', 'The quotation cannot be valid until a day that has passed');
    if (i.companyId && !(await trx.selectFrom('company').select('id').where('id', '=', i.companyId).executeTakeFirst())) throw fail(422, 'REFERENCE_INVALID', 'Company not found');
    if (i.guestId && !(await trx.selectFrom('guest').select('id').where('id', '=', i.guestId).executeTakeFirst())) throw fail(422, 'REFERENCE_INVALID', 'Guest not found');
  }

  async create(propertyId: string, userId: string, i: z.infer<typeof S.QuotationBody>) {
    const pricing = await this.price(propertyId, userId, i);
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['code', 'business_date']).where('id', '=', propertyId).executeTakeFirstOrThrow();
      await this.check(trx, i, p.business_date);
      const seq = (await sql<{ v: string }>`INSERT INTO property_counter (tenant_id, property_id, name, value) VALUES (${currentTenant().tenantId}, ${propertyId}, 'quotation', 1)
        ON CONFLICT (tenant_id, property_id, name) DO UPDATE SET value = property_counter.value + 1 RETURNING value::text AS v`.execute(trx)).rows[0]!.v;
      const number = `QT-${p.code}-${p.business_date.slice(2, 4)}${seq.padStart(4, '0')}`;
      const id = (await trx.insertInto('quotation').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, number, created_by: userId, valid_until: i.validUntil, customer_name: i.customerName } as never).returning('id').executeTakeFirstOrThrow()).id;
      const set = await this.save(trx, propertyId, id, i, pricing, pricing.currency);
      await trx.updateTable('quotation').set(set as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'quotation.create', resourceType: 'quotation', resourceId: id, propertyId, after: { number, total: pricing.total } });
      const { q, lines } = await this.load(trx, propertyId, id); return this.view(q, lines, p.business_date);
    });
  }
  async update(propertyId: string, userId: string, id: string, i: z.infer<typeof S.UpdateQuotation>) {
    const cur = await this.tdb.tx((trx) => this.load(trx, propertyId, id));
    if (cur.q.status !== 'DRAFT') throw fail(409, 'WRONG_STATE', 'Only a draft can be edited. Use "Revise" to open a sent quotation again.');
    if (cur.q.version !== i.version) throw fail(412, 'VERSION_CONFLICT', 'Someone else changed this quotation. Reload it and try again.');
    const pricing = await this.price(propertyId, userId, i, cur.lines.map((l) => l.id));
    return this.tdb.tx(async (trx) => {
      const bd = await this.bd(trx, propertyId); await this.check(trx, i, bd);
      const set = await this.save(trx, propertyId, id, i, pricing, pricing.currency);
      const r = await trx.updateTable('quotation').set({ ...set, updated_at: sql`now()`, version: sql`version + 1` } as never).where('id', '=', id).where('version', '=', i.version).where('status', '=', 'DRAFT').executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw fail(412, 'VERSION_CONFLICT', 'Someone else changed this quotation. Reload it and try again.');
      await this.audit.record(trx, { action: 'quotation.update', resourceType: 'quotation', resourceId: id, propertyId, after: { total: pricing.total } });
      const { q, lines } = await this.load(trx, propertyId, id); return this.view(q, lines, bd);
    });
  }
  async priceOnly(propertyId: string, userId: string, i: z.infer<typeof S.QuotationBody>) { return this.price(propertyId, userId, i); }

  // ───────────── life of a quotation ─────────────
  private async move(propertyId: string, id: string, from: readonly string[], to: string, extra: Record<string, unknown>, action: string, note?: object) {
    return this.tdb.tx(async (trx) => {
      const { q } = await this.load(trx, propertyId, id);
      if (!from.includes(q.status)) throw fail(409, 'WRONG_STATE', `A ${q.status.toLowerCase()} quotation cannot do this`);
      await trx.updateTable('quotation').set({ status: to, updated_at: sql`now()`, version: sql`version + 1`, ...extra } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action, resourceType: 'quotation', resourceId: id, propertyId, after: note });
      const r = await this.load(trx, propertyId, id); return this.view(r.q, r.lines, await this.bd(trx, propertyId));
    });
  }
  revise(propertyId: string, id: string) { return this.move(propertyId, id, ['SENT', 'ACCEPTED', 'DECLINED'], 'DRAFT', { responded_at: null, responded_name: null, responded_note: null, desk_seen_at: null }, 'quotation.revise'); }
  cancel(propertyId: string, id: string) { return this.move(propertyId, id, ['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED'], 'CANCELLED', {}, 'quotation.cancel'); }
  mark(propertyId: string, id: string, i: z.infer<typeof S.Mark>, userId: string) {
    return this.move(propertyId, id, ['SENT', 'DECLINED', 'ACCEPTED'], i.status, { responded_at: sql`now()`, responded_name: 'By phone or message (recorded by staff)', responded_note: i.note ?? null, desk_seen_at: sql`now()` }, `quotation.mark_${i.status.toLowerCase()}`, { by: userId });
  }
  async seen(propertyId: string, id: string) { await this.tdb.tx((trx) => trx.updateTable('quotation').set({ desk_seen_at: sql`now()` } as never).where('id', '=', id).where('property_id', '=', propertyId).execute()); return { ok: true }; }

  /** Freezes the figures, makes (or reuses) the private link, and marks the quotation as sent. */
  async linkFor(propertyId: string, userId: string, id: string, origin?: string) {
    const cur = await this.tdb.tx((trx) => this.load(trx, propertyId, id));
    if (['CANCELLED', 'CONVERTED'].includes(cur.q.status)) throw fail(409, 'WRONG_STATE', 'This quotation is closed');
    const bd = await this.tdb.tx((trx) => this.bd(trx, propertyId));
    if (cur.q.valid_until < bd) throw fail(422, 'EXPIRED', 'The validity date has passed. Revise the quotation and give a later date.');
    const body = this.toBody(cur.q, cur.lines);
    const pricing = cur.q.status === 'DRAFT' ? await this.price(propertyId, userId, body, cur.lines.map((l) => l.id)) : cur.q.pricing!;
    const tenantId = currentTenant().tenantId;
    return this.tdb.tx(async (trx) => {
      let l = await trx.selectFrom('document_link').select(['token']).where('kind', '=', 'QUOTATION').where('ref_id', '=', id).where('revoked_at', 'is', null).executeTakeFirst();
      if (!l) {
        const token = `${tenantId.replace(/-/g, '')}-${randomBytes(16).toString('hex')}`;
        l = await trx.insertInto('document_link').values({ tenant_id: tenantId, property_id: propertyId, kind: 'QUOTATION', ref_id: id, token, created_by: userId } as never).returning('token').executeTakeFirstOrThrow();
      }
      if (cur.q.status === 'DRAFT') {
        await trx.updateTable('quotation').set({ status: 'SENT', pricing: JSON.stringify(pricing), sent_at: sql`now()`, sent_by: userId, updated_at: sql`now()`, version: sql`version + 1` } as never).where('id', '=', id).execute();
        await this.audit.record(trx, { action: 'quotation.send', resourceType: 'quotation', resourceId: id, propertyId, after: { total: pricing.total } });
      }
      return { token: l.token, url: `${(origin ?? process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/v1/guest/quote/${l.token}` };
    });
  }
  private toBody(q: Row, lines: LineRow[]): z.infer<typeof S.QuotationBody> {
    const cur = q.pricing?.currency ?? 'PKR';
    const d = (k: 'NONE' | 'PCT' | 'AMOUNT', v: string) => (k === 'NONE' ? { kind: 'NONE' as const } : k === 'PCT' ? { kind: 'PCT' as const, value: String(Number(v) / 100) } : { kind: 'AMOUNT' as const, value: Money.ofMinor(BigInt(v), cur).toDecimalString() });
    return { customerName: q.customer_name, companyId: q.company_id, guestId: q.guest_id, contactName: q.contact_name, phone: q.phone, email: q.email, residency: q.residency, title: q.title, validUntil: q.valid_until, discount: d(q.discount_kind, q.discount_value),
      discountReason: q.discount_reason, deposit: d(q.deposit_kind, q.deposit_value), specialRequests: q.special_requests, amenities: q.amenities, terms: q.terms, notesInternal: q.notes_internal,
      lines: lines.map((l) => ({ roomTypeId: l.room_type_id, ratePlanId: l.rate_plan_id, rooms: l.rooms, arrival: l.arrival, departure: l.departure, adults: l.adults, children: l.children, extraBeds: l.extra_beds, discount: d(l.discount_kind, l.discount_value), note: l.note })) } as never;
  }

  // ───────────── the page ─────────────
  private async page(trx: Parameters<Parameters<TenantDb['tx']>[0]>[0], propertyId: string, q: Row, nonce: string, interactive: boolean) {
    const [brand, p] = await Promise.all([this.docs.brand(trx, propertyId), trx.selectFrom('property').select(['business_date', 'terms_text']).where('id', '=', propertyId).executeTakeFirstOrThrow()]);
    return renderQuotation(brand, { number: q.number, status: q.status, expired: q.valid_until < p.business_date && q.status === 'SENT', customerName: q.customer_name, contactName: q.contact_name, title: q.title, validUntil: q.valid_until, issued: (q.sent_at ?? q.created_at).toISOString().slice(0, 10),
      discountReason: q.discount_reason, specialRequests: q.special_requests, amenities: q.amenities, terms: q.terms ?? p.terms_text, pricing: q.pricing!, response: q.responded_at ? { at: q.responded_at.toISOString().slice(0, 10), name: q.responded_name, note: q.responded_note, accepted: q.status === 'ACCEPTED' || q.status === 'CONVERTED' } : null,
      interactive: interactive && q.status === 'SENT' && q.valid_until >= p.business_date }, nonce);
  }
  /** For staff, drawn now from the saved figures. */
  async html(propertyId: string, id: string, nonce: string) { return this.tdb.tx(async (trx) => { const { q } = await this.load(trx, propertyId, id); if (!q.pricing) throw fail(409, 'NOT_PRICED', 'Nothing to show yet'); return this.page(trx, propertyId, q, nonce, false); }); }

  /** What the customer opens from the link. The tenant comes from the token and is enforced by row-level security like any other request. */
  async htmlByToken(token: string, nonce: string): Promise<string | null> {
    if (!TOKEN.test(token) || !UUID.test(toUuid(token.slice(0, 32)))) return null;
    return runWithTenant({ tenantId: toUuid(token.slice(0, 32)) }, () => this.tdb.tx(async (trx) => {
      const l = await trx.selectFrom('document_link').selectAll().where('token', '=', token).where('kind', '=', 'QUOTATION').where('revoked_at', 'is', null).executeTakeFirst();
      if (!l) return null;
      const { q } = await this.load(trx, l.property_id, l.ref_id).catch(() => ({ q: null as unknown as Row }));
      if (!q || !q.pricing || q.status === 'CANCELLED') return null;
      await trx.updateTable('document_link').set({ views: sql`views + 1`, last_viewed_at: sql`now()` } as never).where('id', '=', l.id).execute();
      await trx.updateTable('quotation').set({ views: sql`views + 1`, viewed_at: sql`now()` } as never).where('id', '=', q.id).execute();
      return q.status === 'DRAFT' ? this.page(trx, l.property_id, { ...q, pricing: q.pricing }, nonce, false) : this.page(trx, l.property_id, q, nonce, true);
    }));
  }

  /** The customer's answer. It tells the desk (inbox and an event); it does not hold rooms. */
  async respond(token: string, i: z.infer<typeof S.Respond>) {
    if (!TOKEN.test(token) || !UUID.test(toUuid(token.slice(0, 32)))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
    return runWithTenant({ tenantId: toUuid(token.slice(0, 32)) }, () => this.tdb.tx(async (trx) => {
      const l = await trx.selectFrom('document_link').selectAll().where('token', '=', token).where('kind', '=', 'QUOTATION').where('revoked_at', 'is', null).executeTakeFirst();
      if (!l) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
      const q = (await trx.selectFrom('quotation').selectAll().where('id', '=', l.ref_id).forUpdate().executeTakeFirstOrThrow()) as unknown as Row;
      const bd = await this.bd(trx, l.property_id);
      if (q.status !== 'SENT') throw fail(409, 'NOT_OPEN', q.status === 'ACCEPTED' || q.status === 'DECLINED' ? 'This quotation has already been answered.' : 'This quotation is not open for an answer.');
      if (q.valid_until < bd) throw fail(409, 'EXPIRED', 'This quotation has expired. Please ask the hotel for a new one.');
      const status = i.decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';
      await trx.updateTable('quotation').set({ status, responded_at: sql`now()`, responded_name: i.name, responded_note: i.note ?? null, desk_seen_at: null, updated_at: sql`now()`, version: sql`version + 1` } as never).where('id', '=', q.id).execute();
      await this.audit.record(trx, { action: `quotation.customer_${status.toLowerCase()}`, resourceType: 'quotation', resourceId: q.id, propertyId: l.property_id, after: { name: i.name } });
      await this.outbox.publish(trx, { aggregateType: 'quotation', aggregateId: q.id, eventType: 'QuotationAnswered', propertyId: l.property_id, businessDate: bd, payload: { quotationId: q.id, number: q.number, status, name: i.name } });
      return { status };
    }));
  }

  // ───────────── becoming a booking ─────────────
  async convert(propertyId: string, userId: string, id: string, i: z.infer<typeof S.Convert>) {
    const cur = await this.tdb.tx((trx) => this.load(trx, propertyId, id));
    if (!['ACCEPTED', 'SENT'].includes(cur.q.status)) throw fail(409, 'WRONG_STATE', cur.q.status === 'CONVERTED' ? 'This quotation is already a booking' : 'Only a quotation the customer accepted (or you marked as accepted) can become a booking');
    const body = this.toBody(cur.q, cur.lines);
    const fresh = await this.price(propertyId, userId, body, cur.lines.map((l) => l.id));
    if (cur.q.pricing && fresh.total !== cur.q.pricing.total && !i.acceptNewPrice) {
      throw fail(409, 'PRICE_CHANGED', 'Rates changed since this quotation was sent.', { was: cur.q.pricing.total, now: fresh.total, currency: fresh.currency });
    }
    // the guest who will be on the booking
    let guestId = i.guestId ?? cur.q.guest_id;
    if (!guestId) {
      if (cur.q.residency === 'NON_RESIDENT') throw fail(422, 'GUEST_NEEDED', 'This quotation is for a foreign guest. Choose the guest first (open Guests to add them).');
      const phone = cur.q.phone && /^[+\d][\d\s\-()+]{5,24}$/.test(cur.q.phone) ? cur.q.phone : null;
      guestId = (await this.tdb.tx((trx) => this.guests.createIn(trx, { fullName: (cur.q.contact_name ?? cur.q.customer_name).trim().padEnd(2, ' '), phone, email: cur.q.email, nationality: 'PK', vip: false, allowDuplicate: true } as never))).id;
    }
    await this.tdb.tx((trx) => trx.updateTable('quotation').set({ guest_id: guestId } as never).where('id', '=', id).execute());
    for (const [k, l] of cur.lines.entries()) if (fresh.lines[k]!.roomsLeft < l.rooms) throw fail(409, 'NOT_AVAILABLE', `${fresh.lines[k]!.roomTypeName} is not available for ${l.arrival} → ${l.departure} in that number: ${l.rooms} asked, ${fresh.lines[k]!.roomsLeft} free. Change the quotation or free the rooms.`);
    // one signed quote per room, carrying that room's share of the agreed discount
    const channel = cur.q.company_id ? 'CORPORATE' : 'DIRECT';
    const tokens: string[] = [];
    for (const [k, l] of cur.lines.entries()) {
      for (const d of fresh.lines[k]!.roomDiscounts) {
        const r = await this.rates.quote(propertyId, userId, { arrival: l.arrival, departure: l.departure, adults: l.adults, children: l.children, extraBeds: l.extra_beds, channel, residency: cur.q.residency, companyId: cur.q.company_id, roomTypeId: l.room_type_id,
          discountPct: 0, nightDiscounts: [], includeUnavailable: false, ...(BigInt(d) > 0n ? { discountAmount: Money.ofMinor(BigInt(d), fresh.currency).toDecimalString() } : {}) } as never);
        const o = (r.options as unknown as Array<{ plan: { id: string }; quoteToken: string | null }>).find((x) => x.plan.id === fresh.lines[k]!.planId && x.quoteToken);
        if (!o?.quoteToken) throw fail(409, 'NOT_AVAILABLE', `${fresh.lines[k]!.roomTypeName} is not available for ${l.arrival} → ${l.departure}${l.rooms > 1 ? ` (${l.rooms} rooms)` : ''}. Change the quotation or free the rooms.`);
        tokens.push(o.quoteToken);
      }
    }
    // up to ten rooms to a booking; a bigger group becomes several bookings for the same guest
    const done = [...cur.q.reservation_ids];
    for (let c = done.length * 10; c < tokens.length; c += 10) {
      let res: { id: string };
      try {
        res = await this.reservations.create(propertyId, userId, `quotation-${id}-${c / 10}`, { guestId, source: cur.q.company_id ? 'CORPORATE' : 'PHONE', companyId: cur.q.company_id, lines: tokens.slice(c, c + 10).map((quoteToken) => ({ quoteToken })),
        specialRequests: cur.q.special_requests, notesInternal: `From quotation ${cur.q.number}`, ...(cur.q.title ? { externalRef: cur.q.number } : {}) } as never) as { id: string };
      } catch (e) {
        const code = (e as { getResponse?: () => { code?: string } }).getResponse?.()?.code;
        if (code === 'AVAILABILITY_CHANGED') throw fail(409, 'NOT_AVAILABLE', 'Some of the rooms were taken while the booking was being made. Check availability and try again.');
        throw e;
      }
      done.push(res.id);
      await this.tdb.tx((trx) => trx.updateTable('quotation').set({ reservation_ids: done } as never).where('id', '=', id).execute());
    }
    return this.tdb.tx(async (trx) => {
      await trx.updateTable('quotation').set({ status: 'CONVERTED', converted_at: sql`now()`, desk_seen_at: sql`now()`, pricing: JSON.stringify(fresh), updated_at: sql`now()`, version: sql`version + 1` } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'quotation.convert', resourceType: 'quotation', resourceId: id, propertyId, after: { reservations: done.length, total: fresh.total } });
      const r = await this.load(trx, propertyId, id); const bookings = await trx.selectFrom('reservation').select(['id', 'confirmation_no']).where('id', 'in', done).execute();
      return { ...this.view(r.q, r.lines, await this.bd(trx, propertyId)), bookings: bookings.map((b) => ({ id: b.id, confirmationNo: b.confirmation_no })) };
    });
  }
}
