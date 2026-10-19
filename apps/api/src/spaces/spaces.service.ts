import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money, addDays, zonedToUtcMs } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { fmt, type Trx } from '../companies/companies.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { FolioService } from '../folio/folio.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const HALF_DAY_MAX_MIN = 240, FULL_DAY_MAX_MIN = 720, MIN_MIN = 30;
type SpaceRow = { id: string; name: string; name_ur: string | null; capacity: number | null; buffer_minutes: number; hourly_minor: string | null; half_day_minor: string | null; full_day_minor: string | null; active: boolean; version: number };
type BookingRow = Awaited<ReturnType<SpacesService['row']>>;

/** The conference room (and any other space sold by the hour or the day): prices, a calendar that cannot be double-booked, and the charge — onto a staying guest's bill, or onto a bill of its own. */
@Injectable()
export class SpacesService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(FolioService) private readonly folios: FolioService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  // ───────────── spaces ─────────────
  private view(s: SpaceRow, cur: string) {
    const p = (v: string | null) => (v === null ? null : fmt(v, cur));
    return { id: s.id, name: s.name, nameUr: s.name_ur, capacity: s.capacity, bufferMinutes: s.buffer_minutes, hourly: p(s.hourly_minor), halfDay: p(s.half_day_minor), fullDay: p(s.full_day_minor), active: s.active, version: s.version };
  }
  private minor = (v: string | null | undefined, cur: string) => (v === null || v === undefined ? null : Money.parse(v, cur).minor.toString());
  async list(propertyId: string, all: boolean) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      let q = trx.selectFrom('space').selectAll().where('property_id', '=', propertyId).orderBy('name');
      if (!all) q = q.where('active', '=', true);
      return { items: (await q.execute()).map((s) => this.view(s as never, p.currency)) };
    });
  }
  async create(propertyId: string, userId: string, i: z.infer<typeof S.CreateSpace>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      try {
        const s = await trx.insertInto('space').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, name: i.name, name_ur: i.nameUr ?? null, capacity: i.capacity ?? null, buffer_minutes: i.bufferMinutes,
          hourly_minor: this.minor(i.hourly, p.currency), half_day_minor: this.minor(i.halfDay, p.currency), full_day_minor: this.minor(i.fullDay, p.currency) } as never).returningAll().executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'space.create', resourceType: 'space', resourceId: s.id, propertyId, after: { name: i.name } });
        return this.view(s as never, p.currency);
      } catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE', `"${i.name}" already exists`); throw e; }
    });
  }
  async update(propertyId: string, id: string, userId: string, i: z.infer<typeof S.UpdateSpace>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const cur = await trx.selectFrom('space').selectAll().where('id', '=', id).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Space not found' });
      if (cur.version !== i.version) throw fail(412, 'VERSION_CONFLICT', 'Someone else changed this space. Reload and try again.');
      const m: Record<string, unknown> = {};
      if (i.name !== undefined) m.name = i.name; if (i.nameUr !== undefined) m.name_ur = i.nameUr; if (i.capacity !== undefined) m.capacity = i.capacity; if (i.bufferMinutes !== undefined) m.buffer_minutes = i.bufferMinutes; if (i.active !== undefined) m.active = i.active;
      if (i.hourly !== undefined) m.hourly_minor = this.minor(i.hourly, p.currency); if (i.halfDay !== undefined) m.half_day_minor = this.minor(i.halfDay, p.currency); if (i.fullDay !== undefined) m.full_day_minor = this.minor(i.fullDay, p.currency);
      try {
        const u = await trx.updateTable('space').set({ ...m, version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'space.update', resourceType: 'space', resourceId: id, propertyId, before: { hourly: cur.hourly_minor, halfDay: cur.half_day_minor, fullDay: cur.full_day_minor, active: cur.active }, after: { hourly: u.hourly_minor, halfDay: u.half_day_minor, fullDay: u.full_day_minor, active: u.active } });
        return this.view(u as never, p.currency);
      } catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE', 'Another space has that name'); throw e; }
    });
  }

  // ───────────── bookings ─────────────
  async row(trx: Trx, propertyId: string, id: string, lock = false) {
    let q = trx.selectFrom('space_booking').selectAll().where('id', '=', id).where('property_id', '=', propertyId);
    if (lock) q = q.forUpdate();
    const b = await q.executeTakeFirst();
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Booking not found' });
    return b;
  }
  private local(at: Date | string, tz: string) {
    const d = new Date(at); const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', ...o }).format(d);
    return { date: f({ year: 'numeric', month: '2-digit', day: '2-digit' }), time: f({ hour: '2-digit', minute: '2-digit' }) };
  }
  private async bookingView(trx: Trx, b: BookingRow, tz: string) {
    const s = this.local(b.starts_at, tz), e = this.local(b.ends_at, tz);
    const [space, res, folio] = await Promise.all([
      trx.selectFrom('space').select(['name', 'name_ur']).where('id', '=', b.space_id).executeTakeFirst(),
      b.reservation_id ? sql<{ confirmation_no: string; guest: string }>`SELECT r.confirmation_no, g.full_name AS guest FROM reservation r JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id WHERE r.tenant_id = ${currentTenant().tenantId} AND r.id = ${b.reservation_id}`.execute(trx).then((x) => x.rows[0]) : undefined,
      b.folio_id ? trx.selectFrom('folio').select(['folio_no', 'balance_minor', 'status']).where('id', '=', b.folio_id).executeTakeFirst() : undefined,
    ]);
    const invoices = b.folio_id ? await trx.selectFrom('invoice').select(['id', 'number', 'doc_type', 'credits_invoice_id']).where('folio_id', '=', b.folio_id).orderBy('issued_at').orderBy('number').execute() : [];
    const company = b.company_id ? await trx.selectFrom('company').select('name').where('id', '=', b.company_id).executeTakeFirst() : undefined;
    return { id: b.id, number: b.number, spaceId: b.space_id, space: space?.name ?? '', spaceUr: space?.name_ur ?? null, eventName: b.event_name, hostName: b.host_name, hostPhone: b.host_phone, attendees: b.attendees, note: b.note,
      date: s.date, startTime: s.time, endTime: e.time, startsAt: b.starts_at, endsAt: b.ends_at, pricing: b.pricing, hours: b.hours, amount: fmt(b.amount_minor, b.currency), status: b.status, billTo: b.bill_to,
      stay: res ? { reservationId: b.reservation_id, confirmationNo: res.confirmation_no, guest: res.guest } : null,
      bill: folio ? { folioId: b.folio_id, folioNo: folio.folio_no, balance: fmt(folio.balance_minor, b.currency), status: folio.status } : null, company: company ? { id: b.company_id, name: company.name } : null,
      invoices: invoices.map((x) => ({ id: x.id, number: x.number, docType: x.doc_type })), completedAt: b.completed_at, cancelReason: b.cancel_reason, version: b.version };
  }

  /** Works out the length and the price (before tax) of a hire, or says why it cannot be. */
  private priced(space: { hourly_minor: string | null; half_day_minor: string | null; full_day_minor: string | null }, p: { business_date: string; timezone: string }, i: { date: string; startTime: string; endTime: string; pricing: 'HOURLY' | 'HALF_DAY' | 'FULL_DAY' }) {
    if (i.date < p.business_date) throw fail(422, 'DATE_IN_PAST', 'That date has already passed');
    const startMs = zonedToUtcMs(i.date, i.startTime, p.timezone), endMs = zonedToUtcMs(i.date, i.endTime, p.timezone);
    const minutes = Math.round((endMs - startMs) / 60_000);
    if (minutes <= 0) throw fail(422, 'TIME_RANGE_INVALID', 'The hire must end after it starts (same day)');
    if (minutes < MIN_MIN) throw fail(422, 'TOO_SHORT', `The shortest hire is ${MIN_MIN} minutes`);
    const hours = Math.ceil(minutes / 60);
    let amount: bigint;
    if (i.pricing === 'HOURLY') {
      if (space.hourly_minor === null) throw fail(422, 'PRICING_NOT_OFFERED', 'This space is not sold by the hour');
      amount = BigInt(space.hourly_minor) * BigInt(hours);
    } else if (i.pricing === 'HALF_DAY') {
      if (space.half_day_minor === null) throw fail(422, 'PRICING_NOT_OFFERED', 'This space has no half-day price');
      if (minutes > HALF_DAY_MAX_MIN) throw fail(422, 'TOO_LONG_FOR_HALF_DAY', 'A half day is up to 4 hours. Use the full-day price.');
      amount = BigInt(space.half_day_minor);
    } else {
      if (space.full_day_minor === null) throw fail(422, 'PRICING_NOT_OFFERED', 'This space has no full-day price');
      if (minutes > FULL_DAY_MAX_MIN) throw fail(422, 'TOO_LONG_FOR_FULL_DAY', 'A full day is up to 12 hours.');
      amount = BigInt(space.full_day_minor);
    }
    return { startMs, endMs, minutes, hours, amount };
  }

  async book(propertyId: string, userId: string, i: z.infer<typeof S.CreateBooking>) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['id', 'code', 'currency', 'business_date', 'timezone']).where('id', '=', propertyId).executeTakeFirstOrThrow();
      const space = await trx.selectFrom('space').selectAll().where('id', '=', i.spaceId).where('property_id', '=', propertyId).executeTakeFirst();
      if (!space) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Space not found' });
      if (!space.active) throw fail(422, 'SPACE_INACTIVE', `"${space.name}" is not being hired out`);
      const q = this.priced(space, p, i);
      const { startMs, endMs, hours, amount } = q;
      let folioId: string | null = null;
      if (i.billTo === 'STAY') {
        const live = await sql`SELECT 1 FROM reservation_room WHERE tenant_id = ${currentTenant().tenantId} AND property_id = ${propertyId} AND reservation_id = ${i.reservationId!} AND status IN ('CHECKED_IN','CONFIRMED','OPTION') LIMIT 1`.execute(trx);
        if (live.rows.length === 0) throw fail(422, 'STAY_NOT_ACTIVE', 'That stay is not in the house or coming. Use a separate bill instead.');
      } else {
        if (i.companyId) { const c = await trx.selectFrom('company').select('status').where('id', '=', i.companyId).executeTakeFirst(); if (!c) throw fail(422, 'COMPANY_NOT_FOUND', 'Company not found'); if (c.status === 'ARCHIVED') throw fail(409, 'COMPANY_ARCHIVED', 'That company is archived'); }
        const fseq = (await sql<{ v: string }>`INSERT INTO property_counter (tenant_id, property_id, name, value) VALUES (${currentTenant().tenantId}, ${propertyId}, 'folio', 1)
          ON CONFLICT (tenant_id, property_id, name) DO UPDATE SET value = property_counter.value + 1 RETURNING value::text AS v`.execute(trx)).rows[0]!.v;
        folioId = (await trx.insertInto('folio').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, folio_no: `${p.code}-F${fseq.padStart(6, '0')}`, folio_type: 'HOUSE', company_id: i.companyId ?? null, currency: p.currency } as never).returning('id').executeTakeFirstOrThrow()).id;
      }
      const seq = (await sql<{ v: string }>`INSERT INTO property_counter (tenant_id, property_id, name, value) VALUES (${currentTenant().tenantId}, ${propertyId}, 'space', 1)
        ON CONFLICT (tenant_id, property_id, name) DO UPDATE SET value = property_counter.value + 1 RETURNING value::text AS v`.execute(trx)).rows[0]!.v;
      let b;
      try {
        b = await trx.insertInto('space_booking').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, space_id: space.id, number: `${p.code}-CF${seq.padStart(5, '0')}`, event_name: i.eventName, host_name: i.hostName, host_phone: i.hostPhone ?? null,
          attendees: i.attendees ?? null, starts_at: new Date(startMs), ends_at: new Date(endMs), blocked_until: new Date(endMs + space.buffer_minutes * 60_000), pricing: i.pricing, hours, amount_minor: amount.toString(), currency: p.currency,
          bill_to: i.billTo, reservation_id: i.reservationId ?? null, company_id: i.billTo === 'SEPARATE' ? (i.companyId ?? null) : null, folio_id: folioId, note: i.note ?? null, created_by: userId } as never).returningAll().executeTakeFirstOrThrow();
      } catch (e) {
        if ((e as { code?: string }).code === '23P01') throw fail(409, 'SPACE_TAKEN', `"${space.name}" is already booked at that time${space.buffer_minutes ? ` (${space.buffer_minutes} minutes are kept free between hires)` : ''}`);
        throw e;
      }
      await this.audit.record(trx, { action: 'space.book', resourceType: 'space_booking', resourceId: b.id, propertyId, after: { number: b.number, space: space.name, date: i.date, from: i.startTime, to: i.endTime, amount: amount.toString(), billTo: i.billTo } });
      await this.outbox.publish(trx, { aggregateType: 'space_booking', aggregateId: b.id, eventType: 'SpaceBooked', propertyId, businessDate: p.business_date, payload: { bookingId: b.id, number: b.number, spaceId: space.id } });
      return this.bookingView(trx, b, p.timezone);
    });
  }

  /** Changes a hire that has not happened yet (time, price type, details). The price is worked out again; the slot is checked again. */
  async reschedule(propertyId: string, id: string, userId: string, i: z.infer<typeof S.UpdateBooking>) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['id', 'business_date', 'timezone']).where('id', '=', propertyId).executeTakeFirstOrThrow();
      const b = await this.row(trx, propertyId, id, true);
      if (b.status !== 'BOOKED') throw fail(409, 'WRONG_STATE', `A hire that is ${b.status.toLowerCase()} cannot be changed`);
      if (b.version !== i.version) throw fail(412, 'VERSION_CONFLICT', 'Someone else changed this hire. Reload and try again.');
      const space = await trx.selectFrom('space').selectAll().where('id', '=', b.space_id).executeTakeFirstOrThrow();
      const cur = { date: this.local(b.starts_at, p.timezone).date, startTime: this.local(b.starts_at, p.timezone).time, endTime: this.local(b.ends_at, p.timezone).time };
      const next = { date: i.date ?? cur.date, startTime: i.startTime ?? cur.startTime, endTime: i.endTime ?? cur.endTime, pricing: i.pricing ?? b.pricing };
      const set: Record<string, unknown> = {};
      if (next.date !== cur.date || next.startTime !== cur.startTime || next.endTime !== cur.endTime || next.pricing !== b.pricing) {
        const q = this.priced(space, p, next);
        Object.assign(set, { starts_at: new Date(q.startMs), ends_at: new Date(q.endMs), blocked_until: new Date(q.endMs + space.buffer_minutes * 60_000), pricing: next.pricing, hours: q.hours, amount_minor: q.amount.toString() });
      }
      if (i.eventName !== undefined) set.event_name = i.eventName; if (i.hostName !== undefined) set.host_name = i.hostName; if (i.hostPhone !== undefined) set.host_phone = i.hostPhone; if (i.attendees !== undefined) set.attendees = i.attendees; if (i.note !== undefined) set.note = i.note;
      try {
        const u = await trx.updateTable('space_booking').set({ ...set, version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'space.reschedule', resourceType: 'space_booking', resourceId: id, propertyId, before: { ...cur, amount: b.amount_minor, pricing: b.pricing }, after: { ...next, amount: u.amount_minor } });
        await this.outbox.publish(trx, { aggregateType: 'space_booking', aggregateId: id, eventType: 'SpaceHireChanged', propertyId, businessDate: p.business_date, payload: { bookingId: id, number: b.number } });
        return this.bookingView(trx, u, p.timezone);
      } catch (e) {
        if ((e as { code?: string }).code === '23P01') throw fail(409, 'SPACE_TAKEN', `"${space.name}" is already booked at that time${space.buffer_minutes ? ` (${space.buffer_minutes} minutes are kept free between hires)` : ''}`);
        throw e;
      }
    });
  }

  /** The hire has happened: the charge goes on the bill (the stay's, or the hire's own), taxed like any other charge. Once only, even on a retry. */
  async complete(propertyId: string, id: string, userId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['id', 'currency', 'business_date', 'timezone']).where('id', '=', propertyId).executeTakeFirstOrThrow();
      const b = await this.row(trx, propertyId, id, true);
      if (b.status !== 'BOOKED') throw fail(409, 'WRONG_STATE', `A hire that is ${b.status.toLowerCase()} cannot be completed`);
      if (this.clock.now() < b.starts_at.getTime()) throw fail(409, 'NOT_STARTED', 'This hire has not started yet');
      const space = await trx.selectFrom('space').select('name').where('id', '=', b.space_id).executeTakeFirstOrThrow();
      const folio = b.bill_to === 'STAY' ? await this.folios.ensureGuestFolio(trx, propertyId, b.reservation_id!) : await this.folios.folioRow(trx, propertyId, b.folio_id!);
      const f = await this.folios.folioRow(trx, propertyId, folio.id, true);
      if (f.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', b.bill_to === 'STAY' ? 'This guest’s bill is closed' : 'This hire’s bill is closed');
      const amount = BigInt(b.amount_minor);
      const postingId = amount === 0n ? null : await this.folios.post(trx, { folioId: f.id, propertyId, currency: b.currency, type: 'CHARGE', txnCode: 'HALL', amount, businessDate: p.business_date, sourceType: 'SPACE_BOOKING', sourceRef: b.id,
        description: `${b.number} · ${space.name} · ${b.event_name}`, idempotencyKey: `space:${b.id}`, userId });
      const u = await trx.updateTable('space_booking').set({ status: 'COMPLETED', completed_at: new Date(this.clock.now()), completed_by: userId, folio_id: f.id, posting_id: postingId, version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'space.complete', resourceType: 'space_booking', resourceId: id, propertyId, after: { number: b.number, amount: b.amount_minor, folioId: f.id } });
      await this.outbox.publish(trx, { aggregateType: 'space_booking', aggregateId: id, eventType: 'SpaceHireCompleted', propertyId, businessDate: p.business_date, payload: { bookingId: id, number: b.number, folioId: f.id, amountMinor: b.amount_minor, currency: b.currency } });
      return this.bookingView(trx, u, p.timezone);
    });
  }

  async cancel(propertyId: string, id: string, userId: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['id', 'business_date', 'timezone']).where('id', '=', propertyId).executeTakeFirstOrThrow();
      const b = await this.row(trx, propertyId, id, true);
      if (b.status === 'COMPLETED') throw fail(409, 'ALREADY_COMPLETED', 'This hire is already on the bill. Reverse the charge on the bill instead.');
      if (b.status === 'CANCELLED') throw fail(409, 'WRONG_STATE', 'This hire is already cancelled');
      if (b.folio_id) {
        const f = await this.folios.folioRow(trx, propertyId, b.folio_id, true);
        const posted = await trx.selectFrom('folio_posting').select('id').where('folio_id', '=', f.id).limit(1).executeTakeFirst();
        if (posted) throw fail(409, 'BILL_HAS_PAYMENTS', 'Money has been taken on this hire’s bill. Refund it first, then cancel.');
        await trx.updateTable('folio').set({ status: 'VOID', closed_at: new Date(this.clock.now()) } as never).where('id', '=', f.id).execute();
      }
      const u = await trx.updateTable('space_booking').set({ status: 'CANCELLED', cancel_reason: reason, cancelled_by: userId, version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'space.cancel', resourceType: 'space_booking', resourceId: id, propertyId, before: { status: b.status }, after: { status: 'CANCELLED' }, note: reason });
      await this.outbox.publish(trx, { aggregateType: 'space_booking', aggregateId: id, eventType: 'SpaceHireCancelled', propertyId, businessDate: p.business_date, payload: { bookingId: id, number: b.number } });
      return this.bookingView(trx, u, p.timezone);
    });
  }

  async calendar(propertyId: string, q: z.infer<typeof S.CalendarQuery>) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['business_date', 'timezone']).where('id', '=', propertyId).executeTakeFirstOrThrow();
      const from = q.from ?? p.business_date, to = q.to ?? addDays(from, 13);
      if (to < from || (Date.parse(to) - Date.parse(from)) / 86_400_000 > 92) throw fail(422, 'RANGE_INVALID', 'Choose up to about three months');
      let qb = trx.selectFrom('space_booking').selectAll().where('property_id', '=', propertyId).where('starts_at', '>=', new Date(zonedToUtcMs(from, '00:00', p.timezone))).where('starts_at', '<', new Date(zonedToUtcMs(addDays(to, 1), '00:00', p.timezone))).orderBy('starts_at');
      if (q.spaceId) qb = qb.where('space_id', '=', q.spaceId);
      if (q.status !== 'ALL') qb = qb.where('status', '=', q.status);
      const items = []; for (const b of await qb.execute()) items.push(await this.bookingView(trx, b, p.timezone));
      return { from, to, items };
    });
  }

  /** The tax invoices and credit notes on a hire's own bill. */
  async invoices(propertyId: string, bookingId: string) {
    return this.tdb.tx(async (trx) => {
      const b = await this.row(trx, propertyId, bookingId);
      if (!b.folio_id) return { items: [] };
      const rows = await trx.selectFrom('invoice').select(['id', 'doc_type', 'number', 'issue_date', 'total_minor', 'currency', 'credits_invoice_id']).where('folio_id', '=', b.folio_id).orderBy('issued_at').orderBy('number').execute();
      return { items: rows.map((r) => ({ id: r.id, docType: r.doc_type, number: r.number, issueDate: r.issue_date, total: fmt(r.total_minor, r.currency), creditsInvoiceId: r.credits_invoice_id })) };
    });
  }

  /** Stays a hire can be charged to: guests in the house and bookings arriving within the week. */
  async stays(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const rows = await sql<{ reservation_id: string; confirmation_no: string; guest: string; room: string | null; status: string }>`
        SELECT r.id AS reservation_id, r.confirmation_no, g.full_name AS guest, min(rm.number) AS room, CASE WHEN bool_or(l.status = 'CHECKED_IN') THEN 'IN_HOUSE' ELSE 'ARRIVING' END AS status
        FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id
        LEFT JOIN room_assignment a ON a.assignment_ref = l.id AND a.status = 'IN_HOUSE' LEFT JOIN room rm ON rm.id = a.room_id
        WHERE l.tenant_id = ${currentTenant().tenantId} AND l.property_id = ${propertyId} AND (l.status = 'CHECKED_IN' OR (l.status = 'CONFIRMED' AND l.arrival <= (${p.business_date}::date + 7)))
        GROUP BY r.id, r.confirmation_no, g.full_name ORDER BY g.full_name`.execute(trx);
      return { items: rows.rows.map((r) => ({ reservationId: r.reservation_id, confirmationNo: r.confirmation_no, guest: r.guest, room: r.room, status: r.status })) };
    });
  }
}
