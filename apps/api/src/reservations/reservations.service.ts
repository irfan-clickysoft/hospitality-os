import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import type { DB, ResStatus } from '@hos/db';
import { perNightDiscounts } from '../rates/night-discount.js';
import { Money, addDays, hoursBeforeArrival, nightsOf } from '@hos/domain-types';
import { cancellationFee, depositFor, noShowFee, type DepositRule } from '@hos/rates';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { TenantDb } from '../db/tenant-db.js';
import { ComplianceService } from '../compliance/compliance.service.js';
import { FolioService } from '../folio/folio.service.js';
import { GuestsService } from '../guests/guests.service.js';
import { residencyOf } from '../guests/schemas.js';
import { IdempotencyService, hashRequest } from '../idempotency/idempotency.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { QuoteSigner } from '../rates/quote-signer.js';
import { RatesService } from '../rates/rates.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';
import { allowedActions, deriveStatus, holdsInventory, isActive, nextStatus, type ResAction } from './state-machine.js';

type Trx = Transaction<DB>;
const fmt = (m: bigint | string | number, cur: string) => ({ amount: Money.ofMinor(BigInt(m), cur).toDecimalString(), currency: cur });
const stale = () => new HttpException({ code: 'VERSION_CONFLICT', message: 'This reservation was changed by someone else. Reload and try again.' }, 412);
const FRESH_MFA_MS = 15 * 60_000;

/** Milliseconds the zone is ahead of UTC at an instant. */
function zoneOffsetMs(tz: string, at: number) {
  const x = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map((q) => [q.type, q.value]));
  return Date.UTC(+x.year!, +x.month! - 1, +x.day!, +x.hour!, +x.minute!, +x.second!) - Math.floor(at / 1000) * 1000;
}
/** The instant a date ends in the property's own clock (midnight at the start of the next day). */
function endOfDateIn(tz: string, date: string) {
  const guess = Date.parse(`${addDays(date, 1)}T00:00:00Z`);
  return guess - zoneOffsetMs(tz, guess - zoneOffsetMs(tz, guess));
}
/** When a held room is let go: half-hour steps, whole days, or the end of a chosen date. A hold may not run past the arrival day — the room is needed then. */
export function holdExpiry(h: { minutes?: number; days?: number; untilDate?: string }, now: number, tz: string, businessDate: string, firstArrival: string): Date {
  const at = h.untilDate !== undefined ? endOfDateIn(tz, h.untilDate) : now + (h.days !== undefined ? h.days * 86_400_000 : h.minutes! * 60_000);
  if (at <= now) throw new UnprocessableEntityException({ code: 'HOLD_INVALID', message: 'The hold must end in the future' });
  if (at > endOfDateIn(tz, firstArrival > businessDate ? addDays(firstArrival, -1) : firstArrival) && firstArrival > businessDate) throw new UnprocessableEntityException({ code: 'HOLD_PAST_ARRIVAL', message: 'A room cannot be held past the day before arrival' });
  return new Date(at);
}

@Injectable()
export class ReservationsService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(InventoryService) private readonly inv: InventoryService,
    @Inject(RatesService) private readonly rates: RatesService,
    @Inject(QuoteSigner) private readonly signer: QuoteSigner,
    @Inject(GuestsService) private readonly guests: GuestsService,
    @Inject(FolioService) private readonly folios: FolioService,
    @Inject(IdempotencyService) private readonly idem: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  // ───────────── helpers ─────────────
  async prop(trx: Trx, id: string) {
    const p = await trx.selectFrom('property').select(['id', 'code', 'currency', 'business_date', 'timezone', 'check_in_time', 'status', 'registration_strict', 'nicop_alone_ok']).where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return p;
  }
  async load(trx: Trx, propertyId: string, id: string, lock = false) {
    let q = trx.selectFrom('reservation').selectAll().where('id', '=', id).where('property_id', '=', propertyId);
    if (lock) q = q.forUpdate();
    const res = await q.executeTakeFirst();
    if (!res) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Reservation not found' });
    let lq = trx.selectFrom('reservation_room').selectAll().where('reservation_id', '=', id).orderBy('line_no');
    if (lock) lq = lq.forUpdate();
    return { res, lines: await lq.execute() };
  }
  async requireFreshMfa(): Promise<void> {
    const m = currentTenant().mfaVerifiedAt;
    if (!m || this.clock.now() - m.getTime() > FRESH_MFA_MS) throw new ForbiddenException({ code: 'MFA_REQUIRED', message: 'Verify your second factor (step-up) to perform this action' });
  }
  async requirePermission(userId: string, permission: string, propertyId: string) {
    if ((await this.authz.check(userId, { permission, scope: { propertyId } })).effect !== 'ALLOW') throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: `This action needs the "${permission}" permission` });
  }
  async history(trx: Trx, propertyId: string, reservationId: string, e: { lineId?: string | null; action: string; from?: string | null; to?: string | null; reason?: string | null; details?: unknown }) {
    await trx.insertInto('reservation_history').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, reservation_id: reservationId, reservation_room_id: e.lineId ?? null, action: e.action,
      from_status: e.from ?? null, to_status: e.to ?? null, actor_id: currentTenant().actorId ?? null, reason: e.reason ?? null, details: e.details === undefined ? null : JSON.stringify(e.details) }).execute();
  }
  async syncHeader(trx: Trx, reservationId: string) {
    const lines = await trx.selectFrom('reservation_room').select(['status', 'deposit_due_minor']).where('reservation_id', '=', reservationId).execute();
    const status = deriveStatus(lines.map((l) => l.status));
    await trx.updateTable('reservation').set({ status, version: sql`version + 1` as never, ...(status !== 'OPTION' ? { option_expires_at: null } : {}) }).where('id', '=', reservationId).execute();
    return status;
  }
  async endAssignment(trx: Trx, lineId: string, reason: string) {
    await trx.updateTable('room_assignment').set({ status: 'ENDED', ended_at: sql`now()` as never, end_reason: reason }).where('assignment_ref', '=', lineId).where('status', 'in', ['ASSIGNED', 'IN_HOUSE']).execute();
  }
  private invArgs(propertyId: string, l: { room_type_id: string; arrival: string; departure: string }) { return { propertyId, roomTypeId: l.room_type_id, arrival: l.arrival, departure: l.departure }; }
  private async takeInventory(trx: Trx, propertyId: string, l: { room_type_id: string; arrival: string; departure: string }, as: 'held' | 'reserved') {
    await (as === 'held' ? this.inv.hold(trx, this.invArgs(propertyId, l)) : this.inv.reserve(trx, this.invArgs(propertyId, l)));
  }
  private async giveBackInventory(trx: Trx, propertyId: string, l: { room_type_id: string; arrival: string; departure: string }, as: 'held' | 'reserved') {
    await (as === 'held' ? this.inv.releaseHold(trx, this.invArgs(propertyId, l)) : this.inv.release(trx, this.invArgs(propertyId, l)));
  }
  private async inventoryEvents(trx: Trx, propertyId: string, roomTypeIds: string[], reason: string) {
    for (const rt of new Set(roomTypeIds)) await this.outbox.publish(trx, { aggregateType: 'room_type', aggregateId: rt, eventType: 'InventoryChanged', propertyId, payload: { reason } });
  }

  // ───────────── create ─────────────
  async create(propertyId: string, userId: string, key: string, i: z.infer<typeof S.CreateReservation>) {
    const hash = hashRequest('POST', `/v1/properties/${propertyId}/reservations`, i);
    return this.tdb.tx(async (trx) => {
      const r = await this.idem.run(trx, key, hash, async () => ({ statusCode: 201, body: await this.createIn(trx, propertyId, userId, i) }));
      return { ...r.body, replayed: r.replayed };
    });
  }

  async createIn(trx: Trx, propertyId: string, userId: string, i: z.infer<typeof S.CreateReservation>) {
    const p = await this.prop(trx, propertyId);
    if (p.status !== 'LIVE') throw new UnprocessableEntityException({ code: 'PROPERTY_NOT_LIVE', message: 'This property is not live yet' });
    const now = this.clock.now();

    // 1. verify every signed quote and re-price it with today's rates — the client can never choose a price
    const verified: Array<{ claims: ReturnType<QuoteSigner['verify']>; quote: Awaited<ReturnType<RatesService['priceOne']>>['quote']; discountMinor: bigint; nightCuts: bigint[] | null }> = [];
    for (const l of i.lines) {
      const claims = this.signer.verify(l.quoteToken, now);
      if (claims.propertyId !== propertyId) throw new UnprocessableEntityException({ code: 'QUOTE_INVALID', message: 'This quote belongs to another property' });
      if (claims.discountPct > 0 && !claims.discountApproved) throw new ForbiddenException({ code: 'APPROVAL_REQUIRED', message: 'This discount needs approval before it can be booked' });
      const { quote } = await this.rates.priceOne(trx, propertyId, claims.planId, { roomTypeId: claims.roomTypeId, arrival: claims.arrival, departure: claims.departure, adults: claims.adults,
        children: claims.children, extraBeds: claims.extraBeds, channel: claims.channel, residency: claims.residency as 'RESIDENT' | 'NON_RESIDENT', companyId: claims.companyId });
      if (!quote.sellable) throw new HttpException({ code: 'NOT_SELLABLE', message: 'This rate is no longer available for these dates', reasons: quote.reasons }, 409);
      const nightCuts = claims.nightBp && claims.nightBp.length === quote.nights.length ? perNightDiscounts(quote.nights.map((n) => n.totalMinor), claims.nightBp) : null;
      const fixedCut = claims.discountAmountMinor ? (BigInt(claims.discountAmountMinor) > quote.subtotalMinor ? quote.subtotalMinor : BigInt(claims.discountAmountMinor)) : 0n;
      const discountMinor = fixedCut > 0n ? fixedCut : nightCuts ? nightCuts.reduce((a, b) => a + b, 0n) : (quote.subtotalMinor * BigInt(Math.round(claims.discountPct * 100))) / 10000n;
      if (quote.subtotalMinor - discountMinor !== BigInt(claims.subtotalMinor)) {
        throw new HttpException({ code: 'PRICE_CHANGED', message: 'The price changed since this quote was made. Search again.', newTotal: fmt(quote.subtotalMinor - discountMinor, p.currency) }, 409);
      }
      verified.push({ claims, quote, discountMinor, nightCuts });
    }
    const first = verified[0]!.claims;
    if (verified.some((v) => v.claims.channel !== first.channel || v.claims.residency !== first.residency || (v.claims.companyId ?? null) !== (first.companyId ?? null))) {
      throw new UnprocessableEntityException({ code: 'MIXED_QUOTES', message: 'All rooms in one reservation must come from the same channel, residency and company' });
    }

    // 2. the guest (existing or created in this transaction) — local/foreign rate must match the guest
    let guest = i.guestId ? await trx.selectFrom('guest').selectAll().where('id', '=', i.guestId).executeTakeFirst() : null;
    if (i.guestId && !guest) throw new UnprocessableEntityException({ code: 'REFERENCE_INVALID', message: 'Guest not found' });
    if (!guest && i.guest) { const g = await this.guests.createIn(trx, i.guest); guest = await trx.selectFrom('guest').selectAll().where('id', '=', g.id).executeTakeFirstOrThrow(); }
    if (guest!.do_not_rent) throw new UnprocessableEntityException({ code: 'GUEST_BLOCKED', message: 'This guest is flagged "do not rent". Ask a manager.' });
    if (guest!.residency !== first.residency) {
      throw new UnprocessableEntityException({ code: 'RESIDENCY_MISMATCH', message: `This guest is ${guest!.residency === 'RESIDENT' ? 'a resident (local)' : 'a non-resident (foreign)'} guest but the quote is for ${first.residency === 'RESIDENT' ? 'residents' : 'non-residents'}. Search again with the right residency.` });
    }

    // 2b. compliance rules for this guest and stay: blocked, held for approval, or just noted
    const cctx = { propertyId, stage: 'BOOKING' as const, nationality: guest!.nationality ?? null, residency: first.residency as 'RESIDENT' | 'NON_RESIDENT', guests: Math.max(...verified.map((v) => v.claims.adults + v.claims.children)), nights: Math.max(...verified.map((v) => nightsOf(v.claims.arrival, v.claims.departure).length)), businessDate: p.business_date };
    const enforced = await this.compliance.enforce(trx, cctx, userId, null, i.complianceApproval);

    // 3. take the inventory atomically (rolls back everything if any night is full)
    const hold = !!i.hold;
    for (const v of verified) await this.takeInventory(trx, propertyId, { room_type_id: v.claims.roomTypeId, arrival: v.claims.arrival, departure: v.claims.departure }, hold ? 'held' : 'reserved');

    // 4. guarantee / deposit rules from the policy snapshot
    const depositTotal = verified.reduce((a, v) => a + v.quote.depositDueMinor, 0n);
    const deadlineHours = verified.map((v) => v.quote.policy.depositRule?.dueWithinHours).find((h) => h !== undefined);
    const needsGuarantee = !hold && depositTotal > 0n && first.channel !== 'WALKIN' && !first.companyId;
    const guaranteeType = first.companyId ? 'COMPANY' : 'NONE';
    const optionExpiresAt = hold ? holdExpiry(i.hold!, now, p.timezone, p.business_date, verified.map((v) => v.claims.arrival).sort()[0]!) : null;

    // 5. numbers, header, lines, price snapshot
    const seq = (await sql<{ v: string }>`INSERT INTO property_counter (tenant_id, property_id, name, value) VALUES (${currentTenant().tenantId}, ${propertyId}, 'confirmation', 1)
      ON CONFLICT (tenant_id, property_id, name) DO UPDATE SET value = property_counter.value + 1 RETURNING value::text AS v`.execute(trx)).rows[0]!.v;
    const confirmationNo = `${p.code}-${p.business_date.slice(2, 4)}${seq.padStart(5, '0')}`;
    const status: ResStatus = hold ? 'OPTION' : 'CONFIRMED';
    const res = await trx.insertInto('reservation').values({
      tenant_id: currentTenant().tenantId, property_id: propertyId, confirmation_no: confirmationNo, guest_id: guest!.id, status, source: i.source, channel: first.channel, market_segment: i.marketSegment ?? null,
      external_ref: i.externalRef ?? null, company_id: first.companyId ?? null, residency: first.residency as 'RESIDENT' | 'NON_RESIDENT', currency: p.currency, option_expires_at: optionExpiresAt,
      guarantee_type: guaranteeType, at_risk: needsGuarantee, guarantee_deadline: needsGuarantee && deadlineHours ? new Date(now + deadlineHours * 3_600_000) : null,
      deposit_required_minor: needsGuarantee || first.companyId ? depositTotal.toString() : '0', notes_internal: i.notesInternal ?? null, notes_guest: i.notesGuest ?? null,
      special_requests: i.specialRequests ?? null, created_by: userId,
    } as never).returningAll().executeTakeFirstOrThrow();

    let lineNo = 0;
    for (const v of verified) {
      const q = v.quote, c = v.claims;
      const lineId = (await trx.insertInto('reservation_room').values({
        tenant_id: currentTenant().tenantId, property_id: propertyId, reservation_id: res.id, line_no: ++lineNo, room_type_id: c.roomTypeId, rate_plan_id: c.planId, arrival: c.arrival, departure: c.departure,
        adults: c.adults, children: c.children, extra_beds: c.extraBeds, status, subtotal_minor: q.subtotalMinor.toString(), discount_pct: String(v.nightCuts && q.subtotalMinor > 0n ? Number((v.discountMinor * 10000n) / q.subtotalMinor) / 100 : c.discountPct), discount_minor: v.discountMinor.toString(),
        total_minor: (q.subtotalMinor - v.discountMinor).toString(), deposit_due_minor: q.depositDueMinor.toString(),
        policy: JSON.stringify(q.policy),                                             // snapshot: later policy edits never change this booking
      } as never).returning('id').executeTakeFirstOrThrow()).id;
      await this.insertNights(trx, propertyId, lineId, q.nights.map((n) => ({ date: n.date, source: n.source, room: n.roomMinor, extras: n.totalMinor - n.roomMinor })), v.discountMinor, v.nightCuts);
      await this.history(trx, propertyId, res.id, { lineId, action: 'CREATE', from: null, to: status, details: { roomTypeId: c.roomTypeId, arrival: c.arrival, departure: c.departure, total: fmt(q.subtotalMinor - v.discountMinor, p.currency).amount } });
    }
    await this.audit.record(trx, { action: 'reservation.create', resourceType: 'reservation', resourceId: res.id, propertyId, after: { confirmationNo, status, source: i.source, lines: verified.length, guestId: guest!.id } });
    await this.outbox.publish(trx, { aggregateType: 'reservation', aggregateId: res.id, eventType: 'ReservationCreated', propertyId, businessDate: p.business_date, payload: {
      reservationId: res.id, confirmationNo, status, channel: first.channel, source: i.source, guestId: guest!.id, atRisk: needsGuarantee, depositRequiredMinor: res.deposit_required_minor, guaranteeDeadline: res.guarantee_deadline, currency: p.currency } });
    if (status === 'CONFIRMED') await this.outbox.publish(trx, { aggregateType: 'reservation', aggregateId: res.id, eventType: 'ReservationConfirmed', propertyId, payload: { reservationId: res.id, confirmationNo } });
    await this.inventoryEvents(trx, propertyId, verified.map((v) => v.claims.roomTypeId), 'reservation_created');
    const compliance = await this.compliance.record(trx, cctx, userId, res.id, enforced);
    return { ...(await this.detail(trx, propertyId, res.id)), compliance };
  }

  private async insertNights(trx: Trx, propertyId: string, lineId: string, nights: Array<{ date: string; source: string; room: bigint; extras: bigint }>, discount: bigint, cuts: bigint[] | null = null) {
    const gross = nights.map((n) => n.room + n.extras);
    const shares = cuts ?? (discount > 0n ? Money.ofMinor(discount, 'PKR').allocate(gross).map((m) => m.minor) : gross.map(() => 0n));        // exact split: shares always sum to the discount
    await trx.deleteFrom('stay_night').where('reservation_room_id', '=', lineId).execute();
    await trx.insertInto('stay_night').values(nights.map((n, k) => ({ tenant_id: currentTenant().tenantId, property_id: propertyId, reservation_room_id: lineId, business_date: n.date, source: n.source,
      room_minor: n.room.toString(), extras_minor: n.extras.toString(), discount_minor: shares[k]!.toString(), total_minor: (gross[k]! - shares[k]!).toString() }))).execute();
  }

  // ───────────── read ─────────────
  async detail(trx: Trx, propertyId: string, id: string) {
    const { res, lines } = await this.load(trx, propertyId, id);
    const cur = res.currency;
    const [guest, nights, assigns, hist, plan, types] = await Promise.all([
      trx.selectFrom('guest').select(['id', 'full_name', 'phone', 'email', 'nationality', 'vip']).where('id', '=', res.guest_id).executeTakeFirstOrThrow(),
      trx.selectFrom('stay_night').selectAll().where('reservation_room_id', 'in', lines.map((l) => l.id)).orderBy('business_date').execute(),
      trx.selectFrom('room_assignment as a').innerJoin('room as r', 'r.id', 'a.room_id').select(['a.assignment_ref', 'a.room_id', 'r.number', 'a.status', 'a.ended_at', 'a.end_reason']).where('a.assignment_ref', 'in', lines.map((l) => l.id)).orderBy('a.created_at').execute(),
      trx.selectFrom('reservation_history').selectAll().where('reservation_id', '=', id).orderBy('occurred_at').orderBy('id').execute(),
      trx.selectFrom('rate_plan').select(['id', 'code', 'name']).where('id', 'in', lines.map((l) => l.rate_plan_id)).execute(),
      trx.selectFrom('room_type').select(['id', 'code', 'name']).where('id', 'in', lines.map((l) => l.room_type_id)).execute(),
    ]);
    const total = lines.filter((l) => isActive(l.status) || l.status === 'CHECKED_OUT').reduce((a, l) => a + BigInt(l.total_minor), 0n);
    return {
      id: res.id, confirmationNo: res.confirmation_no, status: res.status, source: res.source, channel: res.channel, marketSegment: res.market_segment, externalRef: res.external_ref, companyId: res.company_id,
      residency: res.residency, guest: { id: guest.id, fullName: guest.full_name, phone: guest.phone, email: guest.email, nationality: guest.nationality, vip: guest.vip },
      guarantee: { type: res.guarantee_type, atRisk: res.at_risk, deadline: res.guarantee_deadline, depositRequired: fmt(res.deposit_required_minor, cur), depositPaid: fmt(res.deposit_paid_minor, cur), reconfirmedAt: res.reconfirmed_at },
      optionExpiresAt: res.option_expires_at, penalty: { amount: fmt(res.penalty_minor, cur), reason: res.penalty_reason, waived: res.penalty_waived },
      notes: { internal: res.notes_internal, guest: res.notes_guest, specialRequests: res.special_requests }, totalExTax: fmt(total, cur), version: res.version, createdAt: res.created_at, cancelledAt: res.cancelled_at, cancelReason: res.cancel_reason,
      lines: lines.map((l) => {
        const a = assigns.filter((x) => x.assignment_ref === l.id);
        const live = a.find((x) => x.status === 'ASSIGNED' || x.status === 'IN_HOUSE');
        return { id: l.id, lineNo: l.line_no, status: l.status, roomType: types.find((t) => t.id === l.room_type_id), ratePlan: plan.find((p) => p.id === l.rate_plan_id), arrival: l.arrival, departure: l.departure,
          nights: nightsOf(l.arrival, l.departure).length, adults: l.adults, children: l.children, extraBeds: l.extra_beds, subtotal: fmt(l.subtotal_minor, cur), discount: { pct: Number(l.discount_pct), amount: fmt(l.discount_minor, cur) },
          total: fmt(l.total_minor, cur), depositDue: fmt(l.deposit_due_minor, cur), policy: l.policy, version: l.version, assignedRoom: live ? { id: live.room_id, number: live.number } : null,
          assignmentHistory: a.map((x) => ({ roomNumber: x.number, status: x.status, endedAt: x.ended_at, endReason: x.end_reason })), allowedActions: allowedActions(l.status),
          nightPrices: nights.filter((n) => n.reservation_room_id === l.id).map((n) => ({ date: n.business_date, source: n.source, total: fmt(n.total_minor, cur).amount })) };
      }),
      history: hist.map((h) => ({ at: h.occurred_at, action: h.action, from: h.from_status, to: h.to_status, reason: h.reason, actorId: h.actor_id, lineId: h.reservation_room_id, details: h.details })),
    };
  }
  async get(propertyId: string, id: string) { return this.tdb.tx(async (trx) => { await this.prop(trx, propertyId); return this.detail(trx, propertyId, id); }); }

  async list(propertyId: string, q: z.infer<typeof S.ListQuery>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const date = q.date ?? p.business_date;
      let qb = trx.selectFrom('reservation_room as rr').innerJoin('reservation as r', 'r.id', 'rr.reservation_id').innerJoin('guest as g', 'g.id', 'r.guest_id')
        .select(['rr.id as line_id', 'r.id', 'r.confirmation_no', 'r.status as res_status', 'rr.status', 'r.source', 'r.at_risk', 'r.guarantee_type', 'r.deposit_required_minor', 'r.deposit_paid_minor', 'r.currency',
          'rr.arrival', 'rr.departure', 'rr.adults', 'rr.children', 'rr.room_type_id', 'rr.total_minor', 'g.full_name', 'g.phone', 'g.vip', 'r.external_ref'])
        .where('rr.property_id', '=', propertyId);
      if (q.view === 'arrivals') qb = qb.where('rr.arrival', '=', date).where('rr.status', 'in', ['OPTION', 'CONFIRMED', 'CHECKED_IN']);
      else if (q.view === 'departures') qb = qb.where('rr.departure', '=', date).where('rr.status', 'in', ['CHECKED_IN', 'CHECKED_OUT']);
      else if (q.view === 'in-house') qb = qb.where('rr.status', '=', 'CHECKED_IN');
      if (q.status) qb = qb.where('rr.status', '=', q.status);
      if (q.arrivalFrom) qb = qb.where('rr.arrival', '>=', q.arrivalFrom);
      if (q.arrivalTo) qb = qb.where('rr.arrival', '<=', q.arrivalTo);
      if (q.source) qb = qb.where('r.source', '=', q.source);
      if (q.atRisk) qb = qb.where('r.at_risk', '=', q.atRisk === 'true');
      if (q.q) {
        const t = q.q.trim(); const digits = t.replace(/\D/g, '');
        qb = qb.where((eb) => eb.or([eb('r.confirmation_no', 'ilike', `${t.replace(/[%_]/g, '')}%`), eb('g.full_name', 'ilike', `%${t.replace(/[%_]/g, '')}%`), eb('r.external_ref', '=', t),
          ...(digits.length >= 6 ? [eb('g.phone_norm', 'like', `%${digits.slice(-9)}`)] : [])]));
      }
      if (q.cursor) {
        const [a, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
        if (!a || !id || !/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'Invalid cursor' });
        qb = qb.where((eb) => eb.or([eb('rr.arrival', '>', a), eb.and([eb('rr.arrival', '=', a), eb('rr.id', '>', id)])]));
      }
      const rows = await qb.orderBy('rr.arrival').orderBy('rr.id').limit(q.limit + 1).execute();
      const page = rows.slice(0, q.limit);
      const types = await trx.selectFrom('room_type').select(['id', 'code', 'name']).where('property_id', '=', propertyId).execute();
      const assigns = page.length ? await trx.selectFrom('room_assignment as a').innerJoin('room as r', 'r.id', 'a.room_id').select(['a.assignment_ref', 'r.number']).where('a.assignment_ref', 'in', page.map((r) => r.line_id)).where('a.status', 'in', ['ASSIGNED', 'IN_HOUSE']).execute() : [];
      const last = page[page.length - 1];
      return {
        date, items: page.map((r) => ({ reservationId: r.id, lineId: r.line_id, confirmationNo: r.confirmation_no, status: r.status, reservationStatus: r.res_status, guest: { fullName: r.full_name, phone: r.phone, vip: r.vip },
          roomType: types.find((t) => t.id === r.room_type_id), arrival: r.arrival, departure: r.departure, nights: nightsOf(r.arrival, r.departure).length, adults: r.adults, children: r.children,
          assignedRoom: assigns.find((a) => a.assignment_ref === r.line_id)?.number ?? null, source: r.source, atRisk: r.at_risk, externalRef: r.external_ref, total: fmt(r.total_minor, r.currency),
          deposit: { required: fmt(r.deposit_required_minor, r.currency), paid: fmt(r.deposit_paid_minor, r.currency) } })),
        nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.arrival}|${last.line_id}`).toString('base64url') : null,
      };
    });
  }

  async update(propertyId: string, id: string, i: z.infer<typeof S.UpdateReservation>) {
    return this.tdb.tx(async (trx) => {
      const { res } = await this.load(trx, propertyId, id, true);
      const m: Record<string, unknown> = { version: sql`version + 1` };
      if (i.notesInternal !== undefined) m.notes_internal = i.notesInternal; if (i.notesGuest !== undefined) m.notes_guest = i.notesGuest;
      if (i.specialRequests !== undefined) m.special_requests = i.specialRequests; if (i.externalRef !== undefined) m.external_ref = i.externalRef; if (i.marketSegment !== undefined) m.market_segment = i.marketSegment;
      const after = await trx.updateTable('reservation').set(m as never).where('id', '=', id).where('version', '=', i.version).returning('id').executeTakeFirst();
      if (!after) throw stale();
      await this.history(trx, propertyId, id, { action: 'UPDATE_DETAILS', details: { fields: Object.keys(i).filter((k) => k !== 'version') } });
      await this.audit.record(trx, { action: 'reservation.update', resourceType: 'reservation', resourceId: id, propertyId, before: { notesInternal: res.notes_internal, externalRef: res.external_ref }, after: i });
      return this.detail(trx, propertyId, id);
    });
  }

  // ───────────── lifecycle ─────────────
  /** Applies a state-machine action to the given lines (all active lines by default), moving inventory accordingly. */
  async transition(trx: Trx, propertyId: string, id: string, action: ResAction, o: { reason: string; lineIds?: string[]; waive?: boolean; userId: string }) {
    const p = await this.prop(trx, propertyId);
    const { res, lines } = await this.load(trx, propertyId, id, true);
    const targets = o.lineIds ? lines.filter((l) => o.lineIds!.includes(l.id)) : lines.filter((l) => (action === 'REINSTATE' ? l.status === 'CANCELLED' || l.status === 'NO_SHOW' : isActive(l.status)));
    if (o.lineIds && targets.length !== o.lineIds.length) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room line not found on this reservation' });
    if (!targets.length) throw new ConflictException({ code: 'NOTHING_TO_DO', message: 'No room on this reservation can take that action' });
    const now = this.clock.now();
    let penalty = 0n; const feeDetails: unknown[] = [];
    await this.inv.lockNights(trx, propertyId, targets.map((l) => l.room_type_id), targets.reduce((a, l) => (l.arrival < a ? l.arrival : a), targets[0]!.arrival), targets.reduce((a, l) => (l.departure > a ? l.departure : a), targets[0]!.departure));
    for (const l of targets) {
      const to = nextStatus(l.status, action);                                    // throws INVALID_STATE_TRANSITION
      const was = holdsInventory(l.status), will = holdsInventory(to);
      if (action === 'NO_SHOW' && p.business_date < l.arrival) throw new UnprocessableEntityException({ code: 'TOO_EARLY', message: `A no-show can only be recorded from the arrival date (${l.arrival})` });
      if (action === 'CANCEL' || action === 'NO_SHOW') {
        const nights = (await trx.selectFrom('stay_night').select(['total_minor']).where('reservation_room_id', '=', l.id).orderBy('business_date').execute()).map((n) => ({ totalMinor: BigInt(n.total_minor) }));
        const snap = { nights: nights as never, subtotalMinor: BigInt(l.total_minor), policy: l.policy as never };
        const hrs = hoursBeforeArrival(l.arrival, p.check_in_time, p.timezone, now);
        const fee = l.status === 'OPTION' ? 0n : action === 'CANCEL' ? cancellationFee(snap, hrs) : noShowFee(snap);        // an unconfirmed option never carries a fee
        penalty += fee; feeDetails.push({ lineId: l.id, hoursBeforeArrival: Math.round(hrs * 10) / 10, fee: fee.toString() });
      }
      if (was) await this.giveBackInventory(trx, propertyId, l, was);
      if (will) await this.takeInventory(trx, propertyId, l, will);               // REINSTATE / CONFIRM: may throw AvailabilityError
      if (!will) await this.endAssignment(trx, l.id, action);
      await trx.updateTable('reservation_room').set({ status: to, version: sql`version + 1` as never }).where('id', '=', l.id).execute();
      await this.history(trx, propertyId, id, { lineId: l.id, action, from: l.status, to, reason: o.reason });
    }
    const status = await this.syncHeader(trx, id);
    const set: Record<string, unknown> = {};
    if (action === 'CANCEL' || action === 'EXPIRE' || action === 'NO_SHOW') {
      set.cancelled_at = sql`now()`; set.cancel_reason = o.reason;
      if (penalty > 0n) { set.penalty_minor = (BigInt(res.penalty_minor) + penalty).toString(); set.penalty_reason = action === 'NO_SHOW' ? 'NO_SHOW' : 'LATE_CANCELLATION'; set.penalty_waived = !!o.waive; }
    }
    if (action === 'REINSTATE') {
      const remaining = await trx.selectFrom('reservation_room').select('status').where('reservation_id', '=', id).where('status', 'in', ['CANCELLED', 'NO_SHOW']).execute();
      if (!remaining.length) { set.penalty_minor = '0'; set.penalty_reason = null; set.penalty_waived = false; set.cancelled_at = null; set.cancel_reason = null; }
    }
    if (Object.keys(set).length) await trx.updateTable('reservation').set(set as never).where('id', '=', id).execute();
    if ((action === 'CANCEL' || action === 'NO_SHOW') && penalty > 0n && !o.waive) {
      await this.folios.postPenalty(trx, propertyId, id, action === 'NO_SHOW' ? 'NOSHOW_FEE' : 'CANCEL_FEE', penalty, BigInt(res.penalty_minor) + penalty, o.userId);   // the fee becomes a charge on the guest folio (a deposit already held offsets it)
    }
    if (action === 'REINSTATE' && set.penalty_minor === '0') await this.folios.reversePenalties(trx, propertyId, id, o.userId, o.reason);
    const eventType = { CONFIRM: 'ReservationConfirmed', EXPIRE: 'OptionExpired', CANCEL: 'ReservationCancelled', NO_SHOW: 'ReservationNoShow', REINSTATE: 'ReservationReinstated', CHECK_IN: 'GuestCheckedIn', CHECK_OUT: 'GuestCheckedOut', UNDO_CHECK_IN: 'CheckInUndone', REOPEN: 'StayReopened' }[action];
    await this.outbox.publish(trx, { aggregateType: 'reservation', aggregateId: id, eventType, propertyId, businessDate: p.business_date, payload: { reservationId: id, confirmationNo: res.confirmation_no, reason: o.reason,
      penaltyMinor: penalty.toString(), penaltyWaived: !!o.waive, depositPaidMinor: res.deposit_paid_minor, currency: res.currency, lines: targets.map((l) => l.id) } });
    await this.inventoryEvents(trx, propertyId, targets.map((l) => l.room_type_id), `reservation_${action.toLowerCase()}`);
    await this.audit.record(trx, { action: `reservation.${action.toLowerCase()}`, resourceType: 'reservation', resourceId: id, propertyId, before: { status: res.status }, after: { status, penalty: penalty.toString(), waived: !!o.waive, fees: feeDetails },
      reasonCode: o.waive ? 'FEE_WAIVED' : undefined, note: o.reason });
    return { status, penalty: fmt(penalty, res.currency), waived: !!o.waive };
  }

  async confirm(propertyId: string, id: string, userId: string) {
    return this.tdb.tx(async (trx) => { await this.transition(trx, propertyId, id, 'CONFIRM', { reason: 'Option confirmed', userId }); return this.detail(trx, propertyId, id); });
  }
  async cancel(propertyId: string, id: string, userId: string, i: z.infer<typeof S.CancelReservation>) {
    if (i.waiveFee) { await this.requirePermission(userId, 'reservation.waive_fee', propertyId); await this.requireFreshMfa(); }
    return this.tdb.tx(async (trx) => { const r = await this.transition(trx, propertyId, id, 'CANCEL', { reason: i.reason, lineIds: i.lineIds, waive: i.waiveFee, userId }); return { ...r, reservation: await this.detail(trx, propertyId, id) }; });
  }
  async noShow(propertyId: string, id: string, userId: string, i: z.infer<typeof S.NoShow>) {
    if (i.waiveFee) { await this.requirePermission(userId, 'reservation.waive_fee', propertyId); await this.requireFreshMfa(); }
    return this.tdb.tx(async (trx) => { const r = await this.transition(trx, propertyId, id, 'NO_SHOW', { reason: i.reason, waive: i.waiveFee, userId }); return { ...r, reservation: await this.detail(trx, propertyId, id) }; });
  }
  async reinstate(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Reinstate>) {
    return this.tdb.tx(async (trx) => { await this.transition(trx, propertyId, id, 'REINSTATE', { reason: i.reason, userId }); return this.detail(trx, propertyId, id); });
  }
  async reconfirm(propertyId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const { res } = await this.load(trx, propertyId, id, true);
      if (res.status !== 'CONFIRMED' && res.status !== 'OPTION') throw new ConflictException({ code: 'INVALID_STATE_TRANSITION', message: 'Only a live booking can be reconfirmed' });
      await trx.updateTable('reservation').set({ reconfirmed_at: new Date(this.clock.now()), version: sql`version + 1` as never }).where('id', '=', id).execute();
      await this.history(trx, propertyId, id, { action: 'RECONFIRMED', reason: 'Guest confirmed arrival' });
      await this.audit.record(trx, { action: 'reservation.reconfirm', resourceType: 'reservation', resourceId: id, propertyId });
      return this.detail(trx, propertyId, id);
    });
  }

  /** Releases options whose hold has run out. Run on a schedule per tenant (and by night audit). */
  async expireOptions(propertyId?: string): Promise<{ expired: number }> {
    const now = new Date(this.clock.now());
    const due = await this.tdb.tx((trx) => {
      let q = trx.selectFrom('reservation').select(['id', 'property_id']).where('status', '=', 'OPTION').where('option_expires_at', '<=', now).orderBy('option_expires_at').limit(200);
      if (propertyId) q = q.where('property_id', '=', propertyId);
      return q.execute();
    });
    let n = 0;
    for (const r of due) {
      await this.tdb.tx(async (trx) => {
        const cur = await trx.selectFrom('reservation').select('status').where('id', '=', r.id).forUpdate().executeTakeFirst();
        if (cur?.status !== 'OPTION') return;                                       // confirmed in the meantime
        await this.transition(trx, r.property_id, r.id, 'EXPIRE', { reason: 'Option expired', userId: currentTenant().actorId ?? '' });
        n++;
      });
    }
    return { expired: n };
  }

  // ───────────── modify (extend / shorten / move dates / upgrade / occupancy) ─────────────
  async modify(propertyId: string, id: string, lineId: string, userId: string, i: z.infer<typeof S.ModifyLine>) {
    if (i.keepRate) { await this.requirePermission(userId, 'reservation.override_rate', propertyId); await this.requireFreshMfa(); }
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const { res, lines } = await this.load(trx, propertyId, id, true);
      const line = lines.find((l) => l.id === lineId);
      if (!line) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room line not found on this reservation' });
      if (line.status !== 'OPTION' && line.status !== 'CONFIRMED') throw new ConflictException({ code: 'NOT_MODIFIABLE', message: `A ${line.status.toLowerCase().replace('_', ' ')} room cannot be changed here` });
      if (line.version !== i.version) throw stale();
      const next = { arrival: i.arrival ?? line.arrival, departure: i.departure ?? line.departure, roomTypeId: i.roomTypeId ?? line.room_type_id, adults: i.adults ?? line.adults, children: i.children ?? line.children, extraBeds: i.extraBeds ?? line.extra_beds };
      if (next.arrival === line.arrival && next.departure === line.departure && next.roomTypeId === line.room_type_id && next.adults === line.adults && next.children === line.children && next.extraBeds === line.extra_beds) {
        throw new UnprocessableEntityException({ code: 'NO_CHANGE', message: 'Nothing to change' });
      }
      if (next.arrival !== line.arrival && next.arrival < p.business_date) throw new UnprocessableEntityException({ code: 'DATE_IN_PAST', message: `Arrival cannot move before the business date (${p.business_date})` });
      nightsOf(next.arrival, next.departure);

      const from = next.arrival < line.arrival ? next.arrival : line.arrival, to = next.departure > line.departure ? next.departure : line.departure;
      await this.inv.lockNights(trx, propertyId, [line.room_type_id, next.roomTypeId], from, to);

      const { quote } = await this.rates.priceOne(trx, propertyId, line.rate_plan_id, { roomTypeId: next.roomTypeId, arrival: next.arrival, departure: next.departure, adults: next.adults, children: next.children, extraBeds: next.extraBeds,
        channel: res.channel, residency: res.residency, companyId: res.company_id });
      if (!quote.sellable) throw new HttpException({ code: 'NOT_SELLABLE', message: 'The new dates or room cannot be sold on this rate', reasons: quote.reasons }, 409);

      // kept nights keep their original price unless the room type / occupancy changed (or the rate is explicitly kept)
      const oldNights = new Map((await trx.selectFrom('stay_night').selectAll().where('reservation_room_id', '=', lineId).execute()).map((n) => [n.business_date, n]));
      const samePricing = next.roomTypeId === line.room_type_id && next.adults === line.adults && next.children === line.children && next.extraBeds === line.extra_beds;
      const nights = quote.nights.map((n) => {
        const old = oldNights.get(n.date);
        return (samePricing || i.keepRate) && old ? { date: n.date, source: `KEPT:${old.source}`, room: BigInt(old.room_minor), extras: BigInt(old.extras_minor) } : { date: n.date, source: n.source, room: n.roomMinor, extras: n.totalMinor - n.roomMinor };
      });
      const subtotal = nights.reduce((a, n) => a + n.room + n.extras, 0n);
      const discount = (subtotal * BigInt(Math.round(Number(line.discount_pct) * 100))) / 10000n;

      const col = holdsInventory(line.status)!;
      await this.giveBackInventory(trx, propertyId, line, col);
      await this.takeInventory(trx, propertyId, { room_type_id: next.roomTypeId, arrival: next.arrival, departure: next.departure }, col);

      // physical room: keep it if it is still valid for the new dates and type, otherwise free it for re-assignment
      const live = await trx.selectFrom('room_assignment').selectAll().where('assignment_ref', '=', lineId).where('status', 'in', ['ASSIGNED', 'IN_HOUSE']).executeTakeFirst();
      let assignmentNote: string | null = null;
      if (live) {
        if (next.roomTypeId !== line.room_type_id) { await this.endAssignment(trx, lineId, 'ROOM_TYPE_CHANGED'); assignmentNote = 'Room type changed: assign a room again'; }
        else if (next.arrival !== line.arrival || next.departure !== line.departure) {
          await this.endAssignment(trx, lineId, 'DATES_CHANGED');
          await this.assignIn(trx, propertyId, { ...line, arrival: next.arrival, departure: next.departure }, live.room_id, 'DATES_CHANGED').catch((e) => {
            if (e instanceof HttpException && (e.getResponse() as { code?: string }).code === 'ROOM_NOT_FREE') throw new HttpException({ code: 'ROOM_NOT_FREE_FOR_NEW_DATES', message: 'The assigned room is not free for the new dates. Unassign it or pick another room first.' }, 409);
            throw e;
          });
        }
      }

      const depositRule = (line.policy as { depositRule?: DepositRule | null }).depositRule ?? null;
      const gross = nights.map((n) => ({ date: n.date, totalMinor: n.room + n.extras, roomMinor: n.room, source: n.source }));
      const depositDue = depositFor(depositRule, gross as never, subtotal - discount);
      const before = { arrival: line.arrival, departure: line.departure, roomTypeId: line.room_type_id, total: fmt(line.total_minor, res.currency).amount };
      await trx.updateTable('reservation_room').set({ arrival: next.arrival, departure: next.departure, room_type_id: next.roomTypeId, adults: next.adults, children: next.children, extra_beds: next.extraBeds,
        subtotal_minor: subtotal.toString(), discount_minor: discount.toString(), total_minor: (subtotal - discount).toString(), deposit_due_minor: depositDue.toString(), version: sql`version + 1` as never } as never)
        .where('id', '=', lineId).execute();
      await this.insertNights(trx, propertyId, lineId, nights, discount);
      const total = await trx.selectFrom('reservation_room').select(sql<string>`coalesce(sum(deposit_due_minor),0)`.as('d')).where('reservation_id', '=', id).where('status', 'in', ['OPTION', 'CONFIRMED']).executeTakeFirstOrThrow();
      if (res.at_risk || res.guarantee_type === 'COMPANY') await trx.updateTable('reservation').set({ deposit_required_minor: total.d }).where('id', '=', id).execute();
      await trx.updateTable('reservation').set({ version: sql`version + 1` as never }).where('id', '=', id).execute();
      const after = { arrival: next.arrival, departure: next.departure, roomTypeId: next.roomTypeId, total: fmt(subtotal - discount, res.currency).amount };
      await this.history(trx, propertyId, id, { lineId, action: 'MODIFY', from: line.status, to: line.status, reason: i.reason, details: { before, after, keepRate: i.keepRate } });
      await this.audit.record(trx, { action: 'reservation.modify', resourceType: 'reservation', resourceId: id, propertyId, before, after, reasonCode: i.keepRate ? 'RATE_KEPT' : undefined, note: i.reason });
      await this.outbox.publish(trx, { aggregateType: 'reservation', aggregateId: id, eventType: 'ReservationModified', propertyId, payload: { reservationId: id, lineId, before, after } });
      await this.inventoryEvents(trx, propertyId, [line.room_type_id, next.roomTypeId], 'reservation_modified');
      const difference = BigInt(subtotal - discount) - BigInt(line.total_minor);
      return { reservation: await this.detail(trx, propertyId, id), change: { previousTotal: fmt(line.total_minor, res.currency), newTotal: fmt(subtotal - discount, res.currency), difference: fmt(difference, res.currency), note: assignmentNote } };
    });
  }

  // ───────────── room assignment ─────────────
  async assignIn(trx: Trx, propertyId: string, line: { id: string; room_type_id: string; arrival: string; departure: string }, roomId: string, reason: string) {
    const room = await trx.selectFrom('room').select(['id', 'room_type_id', 'status', 'number']).where('id', '=', roomId).where('property_id', '=', propertyId).executeTakeFirst();
    if (!room) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room not found' });
    if (room.status !== 'ACTIVE') throw new UnprocessableEntityException({ code: 'ROOM_INACTIVE', message: 'This room is retired' });
    if (room.room_type_id !== line.room_type_id) throw new UnprocessableEntityException({ code: 'WRONG_ROOM_TYPE', message: 'This room is not of the booked room type. Change the room type first (upgrade / downgrade).' });
    const blocked = await trx.selectFrom('room_block').select('id').where('room_id', '=', roomId).where('cancelled_at', 'is', null).where('start_date', '<', line.departure).where('end_date', '>', line.arrival).executeTakeFirst();
    if (blocked) throw new HttpException({ code: 'ROOM_BLOCKED', message: `Room ${room.number} is out of order / out of service during these dates` }, 409);
    try {
      await sql`INSERT INTO room_assignment (tenant_id, property_id, room_id, assignment_ref, stay_range, status)
        VALUES (${currentTenant().tenantId}, ${propertyId}, ${roomId}, ${line.id}, daterange(${line.arrival}::date, ${line.departure}::date), 'ASSIGNED')`.execute(trx);
    } catch (e) {
      if ((e as { code?: string }).code === '23P01') throw new HttpException({ code: 'ROOM_NOT_FREE', message: `Room ${room.number} is already taken for part of these dates` }, 409);
      throw e;
    }
    return room;
  }

  async assignRoom(propertyId: string, id: string, lineId: string, roomId: string) {
    return this.tdb.tx(async (trx) => {
      const { lines } = await this.load(trx, propertyId, id, true);
      const line = lines.find((l) => l.id === lineId);
      if (!line) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room line not found on this reservation' });
      if (line.status !== 'CONFIRMED' && line.status !== 'OPTION') throw new ConflictException({ code: 'NOT_MODIFIABLE', message: 'A room can only be assigned to a live, not yet arrived booking here' });
      const prev = await trx.selectFrom('room_assignment as a').innerJoin('room as r', 'r.id', 'a.room_id').select(['r.number']).where('a.assignment_ref', '=', lineId).where('a.status', '=', 'ASSIGNED').executeTakeFirst();
      await this.endAssignment(trx, lineId, 'REASSIGNED');
      const room = await this.assignIn(trx, propertyId, line, roomId, 'ASSIGN');
      await this.history(trx, propertyId, id, { lineId, action: prev ? 'ROOM_MOVED' : 'ROOM_ASSIGNED', details: { from: prev?.number ?? null, to: room.number } });
      await this.audit.record(trx, { action: prev ? 'reservation.room_move' : 'reservation.room_assign', resourceType: 'reservation', resourceId: id, propertyId, before: { room: prev?.number ?? null }, after: { room: room.number } });
      await this.outbox.publish(trx, { aggregateType: 'reservation', aggregateId: id, eventType: prev ? 'RoomChanged' : 'RoomAssigned', propertyId, payload: { reservationId: id, lineId, roomId, roomNumber: room.number } });
      return this.detail(trx, propertyId, id);
    });
  }
  async unassignRoom(propertyId: string, id: string, lineId: string) {
    return this.tdb.tx(async (trx) => {
      const { lines } = await this.load(trx, propertyId, id, true);
      if (!lines.find((l) => l.id === lineId)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room line not found on this reservation' });
      await this.endAssignment(trx, lineId, 'UNASSIGNED');
      await this.history(trx, propertyId, id, { lineId, action: 'ROOM_UNASSIGNED' });
      await this.audit.record(trx, { action: 'reservation.room_unassign', resourceType: 'reservation', resourceId: id, propertyId });
      return this.detail(trx, propertyId, id);
    });
  }
  /** Physical rooms of the type that are free (no overlapping assignment, no block) for the whole stay. */
  async availableRooms(propertyId: string, roomTypeId: string, arrival: string, departure: string) {
    nightsOf(arrival, departure);
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const rows = await sql<{ id: string; number: string; floor_id: string | null }>`
        SELECT r.id, r.number, r.floor_id FROM room r
        WHERE r.tenant_id = ${currentTenant().tenantId} AND r.property_id = ${propertyId} AND r.room_type_id = ${roomTypeId} AND r.status = 'ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM room_assignment a WHERE a.room_id = r.id AND a.status IN ('ASSIGNED','IN_HOUSE') AND a.stay_range && daterange(${arrival}::date, ${departure}::date))
          AND NOT EXISTS (SELECT 1 FROM room_block b WHERE b.room_id = r.id AND b.cancelled_at IS NULL AND b.start_date < ${departure}::date AND b.end_date > ${arrival}::date)
        ORDER BY lpad(regexp_replace(r.number, '\\D', '', 'g'), 8, '0'), r.number`.execute(trx);
      return rows.rows.map((r) => ({ id: r.id, number: r.number, floorId: r.floor_id }));
    });
  }
}

export { addDays };
