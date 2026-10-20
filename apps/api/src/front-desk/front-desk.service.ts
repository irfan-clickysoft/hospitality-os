import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import type { DB } from '@hos/db';
import { addDays, hoursBeforeArrival, nightsOf } from '@hos/domain-types';
import { ComplianceService } from '../compliance/compliance.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { SecretBox } from '../common/secret-box.js';
import { TenantDb } from '../db/tenant-db.js';
import { residencyOf } from '../guests/schemas.js';
import { FolioService, fmt } from '../folio/folio.service.js';
import { HousekeepingService } from '../housekeeping/housekeeping.service.js';
import { IdempotencyService, hashRequest } from '../idempotency/idempotency.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { RatesService } from '../rates/rates.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { nextStatus } from '../reservations/state-machine.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { idHash, last4, maskId, normaliseIdNumber, type IdType } from './id-documents.js';
import type * as S from './schemas.js';

type Trx = Transaction<DB>;
type Occupant = z.infer<typeof S.Occupant>;
const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);

@Injectable()
export class FrontDeskService {
  private readonly box = SecretBox.fromEnv();
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(ReservationsService) private readonly res: ReservationsService,
    @Inject(RatesService) private readonly rates: RatesService,
    @Inject(FolioService) private readonly folios: FolioService,
    @Inject(HousekeepingService) private readonly hk: HousekeepingService,
    @Inject(InventoryService) private readonly inv: InventoryService,
    @Inject(IdempotencyService) private readonly idem: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  private aad(lineId: string) { return `${currentTenant().tenantId}:${lineId}`; }
  private async needOverride(userId: string, propertyId: string) {
    await this.res.requirePermission(userId, 'frontdesk.override_room', propertyId);
    await this.res.requireFreshMfa();
  }

  /** Validates the registration card and returns the canonical occupants. Foreign guests must be registered with a passport. */
  private checkOccupants(occupants: Occupant[], line: { adults: number; children: number }, residency: 'RESIDENT' | 'NON_RESIDENT', bd: string): Array<Occupant & { canonical: string | null; primary: boolean }> {
    const primaries = occupants.filter((o) => o.isPrimary).length;
    if (primaries > 1) throw fail(422, 'ID_INVALID', 'Only one guest can be the primary guest');
    const list = occupants.map((o, k) => {
      let canonical: string | null = null;
      if (o.idType && o.idNumber) {
        try { canonical = normaliseIdNumber(o.idType, o.idNumber); } catch (e) { throw fail(422, 'ID_INVALID', `${o.fullName}: ${(e as { response?: { message?: string } }).response?.message ?? 'the ID number is not valid'}`); }
      }
      return { ...o, canonical, primary: primaries === 0 ? k === 0 : o.isPrimary };
    });
    const adults = list.filter((o) => o.ageGroup === 'ADULT').length;
    if (adults < 1) throw fail(422, 'ID_INVALID', 'At least one adult must be registered');
    if (adults > line.adults || list.length > line.adults + line.children) throw fail(422, 'OCCUPANCY_EXCEEDED', `This room is booked for ${line.adults} adult(s) and ${line.children} child(ren). Change the booking first to add more guests.`);
    const seen = new Set<string>();
    for (const o of list) { if (!o.canonical) continue; const k = `${o.idType}:${o.canonical}`; if (seen.has(k)) throw fail(422, 'ID_INVALID', 'The same identity document is entered twice'); seen.add(k); }
    const main = list.find((o) => o.primary)!;
    if (main.ageGroup !== 'ADULT') throw fail(422, 'ID_INVALID', 'The primary guest must be an adult');
    if (!main.canonical) throw fail(422, 'ID_REQUIRED', 'The main guest\'s ID is needed. Other family members may share it.');
    if (residency === 'NON_RESIDENT' && main.idType !== 'PASSPORT') throw fail(422, 'PASSPORT_REQUIRED', 'Foreign guests are registered with their passport');
    if (residency === 'RESIDENT' && main.nationality && main.nationality !== 'PK') throw fail(422, 'RESIDENCY_MISMATCH', 'This booking is on the local (resident) rate but the primary guest is a foreign national. Re-book on the international rate.');
    for (const o of list) if (o.idExpiry && o.idType === 'PASSPORT' && o.idExpiry < bd) throw fail(422, 'ID_EXPIRED', `${o.fullName}'s passport has expired`);
    return list;
  }

  private async liveAssignment(trx: Trx, lineId: string) {
    return trx.selectFrom('room_assignment as a').innerJoin('room as r', 'r.id', 'a.room_id').select(['a.id as assignmentId', 'a.room_id', 'a.status', 'a.stay_range', 'r.number', 'r.hk_status'])
      .where('a.assignment_ref', '=', lineId).where('a.status', 'in', ['ASSIGNED', 'IN_HOUSE']).executeTakeFirst();
  }
  /** The room must be usable right now: active, not blocked for the rest of the stay, not still occupied, and clean. */
  private async checkRoomReady(trx: Trx, propertyId: string, roomId: string, lineId: string, bd: string, departure: string, allowNotReady: boolean, userId: string) {
    const room = await trx.selectFrom('room').select(['id', 'number', 'status', 'hk_status']).where('id', '=', roomId).where('property_id', '=', propertyId).executeTakeFirst();
    if (!room) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room not found' });
    if (room.status !== 'ACTIVE') throw fail(422, 'ROOM_INACTIVE', 'This room is retired');
    const blocked = await trx.selectFrom('room_block').select('id').where('room_id', '=', roomId).where('cancelled_at', 'is', null).where('start_date', '<', departure).where('end_date', '>', bd).executeTakeFirst();
    if (blocked) throw fail(409, 'ROOM_BLOCKED', `Room ${room.number} is out of order / out of service during this stay`);
    const occupied = await trx.selectFrom('room_assignment').select('id').where('room_id', '=', roomId).where('status', '=', 'IN_HOUSE').where('assignment_ref', '<>', lineId).executeTakeFirst();
    if (occupied) throw fail(409, 'ROOM_OCCUPIED', `Room ${room.number} still has a guest in it. Check that guest out first.`);
    if (room.hk_status === 'DIRTY' || room.hk_status === 'CLEANING') {
      if (!allowNotReady) throw fail(409, 'ROOM_NOT_READY', `Room ${room.number} has not been cleaned yet`, { roomId, hkStatus: room.hk_status });
      await this.needOverride(userId, propertyId);
    }
    return room;
  }

  // ───────────── check-in ─────────────
  async checkIn(propertyId: string, id: string, lineId: string, userId: string, i: z.infer<typeof S.CheckIn>) {
    return this.tdb.tx(async (trx) => {
      const flags = await this.checkInIn(trx, propertyId, id, lineId, userId, i);
      return { ...(await this.res.detail(trx, propertyId, id)), checkIn: flags };
    });
  }

  async checkInIn(trx: Trx, propertyId: string, id: string, lineId: string, userId: string, i: { roomId?: string; occupants: Occupant[]; allowNotReady: boolean; complianceApproval?: { reason: string } }) {
    const p = await this.res.prop(trx, propertyId);
    const { res, lines } = await this.res.load(trx, propertyId, id, true);
    const line = lines.find((l) => l.id === lineId);
    if (!line) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room line not found on this reservation' });
    nextStatus(line.status, 'CHECK_IN');                                                  // 409 INVALID_STATE_TRANSITION unless CONFIRMED
    const bd = p.business_date;
    if (bd < line.arrival) throw fail(422, 'TOO_EARLY', `This booking arrives on ${line.arrival}. Change the arrival date first.`);
    if (bd >= line.departure) throw fail(422, 'STAY_ENDED', `This booking's departure date (${line.departure}) has passed. Extend the stay first.`);
    const guest = await this.guestOf(trx, res.guest_id);
    if (guest.do_not_rent) throw fail(422, 'GUEST_BLOCKED', 'This guest is flagged "do not rent". Ask a manager.');
    const occupants = this.checkOccupants(i.occupants, line, res.residency, p.business_date);

    // compliance rules for the people actually arriving: blocked, held for approval, a document the main guest must show, tasks to do
    const mainOcc = occupants.find((o) => o.primary)!;
    const cctx = { propertyId, stage: 'CHECK_IN' as const, nationality: mainOcc.nationality ?? guest.nationality ?? null, residency: res.residency as 'RESIDENT' | 'NON_RESIDENT', guests: occupants.length, nights: nightsOf(line.arrival, line.departure).length, businessDate: bd };
    const enforced = await this.compliance.enforce(trx, cctx, userId, id, i.complianceApproval);
    this.compliance.assertDocuments(enforced.matches, mainOcc.idType!);

    const current = await this.liveAssignment(trx, lineId);
    const roomId = i.roomId ?? current?.room_id;
    if (!roomId) throw fail(422, 'ROOM_REQUIRED', 'Choose a room for this guest');
    if (current && roomId !== current.room_id) await this.res.endAssignment(trx, lineId, 'REASSIGNED');
    if (!current || roomId !== current.room_id) await this.res.assignIn(trx, propertyId, line, roomId, 'CHECK_IN');
    const room = await this.checkRoomReady(trx, propertyId, roomId, lineId, bd, line.departure, i.allowNotReady, userId);

    const tenantId = currentTenant().tenantId;
    for (const o of occupants) {
      await trx.insertInto('stay_guest').values({ tenant_id: tenantId, property_id: propertyId, reservation_room_id: lineId, full_name: o.fullName, is_primary: o.primary, age_group: o.ageGroup,
        id_type: o.idType ?? null, id_number_sealed: o.canonical ? this.box.seal(o.canonical, this.aad(lineId)) : null, id_last4: o.canonical ? last4(o.canonical) : null, id_hash: o.canonical ? idHash(o.idType!, o.canonical) : null, nationality: o.nationality ?? null, id_expiry: o.idExpiry ?? null, created_by: userId } as never).execute();
    }
    const main = occupants.find((o) => o.primary)!;
    if (!guest.nationality && main.nationality) await trx.updateTable('guest').set({ nationality: main.nationality, version: sql`version + 1` as never }).where('id', '=', guest.id).execute();

    await this.res.transition(trx, propertyId, id, 'CHECK_IN', { reason: 'Checked in', lineIds: [lineId], userId });
    const at = new Date(this.clock.now());
    await trx.updateTable('reservation_room').set({ checked_in_at: at, checked_in_business_date: bd }).where('id', '=', lineId).execute();
    await this.folios.ensureGuestFolio(trx, propertyId, id);
    await trx.updateTable('reservation').set({ at_risk: false }).where('id', '=', id).where('at_risk', '=', true).execute();          // a guest who has arrived is no longer a no-show risk
    await trx.updateTable('room_assignment').set({ status: 'IN_HOUSE' }).where('assignment_ref', '=', lineId).where('status', '=', 'ASSIGNED').execute();

    const early = bd === line.arrival && hoursBeforeArrival(line.arrival, p.check_in_time, p.timezone, this.clock.now()) > 0;
    const lateArrival = bd > line.arrival;
    await this.res.history(trx, propertyId, id, { lineId, action: 'CHECK_IN_DETAILS', details: { room: room.number, occupants: occupants.length, early, lateArrival } });
    await this.audit.record(trx, { action: 'frontdesk.check_in', resourceType: 'reservation', resourceId: id, propertyId, after: { room: room.number, occupants: occupants.length, early, lateArrival, notReadyOverride: room.hk_status === 'DIRTY' } });
    const complianceHits = await this.compliance.record(trx, cctx, userId, id, enforced);
    return { room: { id: room.id, number: room.number }, earlyCheckIn: early, lateArrival, occupants: occupants.length, compliance: complianceHits };
  }

  private async guestOf(trx: Trx, guestId: string) {
    return trx.selectFrom('guest').select(['id', 'nationality', 'do_not_rent', 'residency']).where('id', '=', guestId).executeTakeFirstOrThrow();
  }

  async undoCheckIn(propertyId: string, id: string, lineId: string, userId: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.res.prop(trx, propertyId);
      const { lines } = await this.res.load(trx, propertyId, id, true);
      const line = lines.find((l) => l.id === lineId);
      if (!line) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room line not found on this reservation' });
      nextStatus(line.status, 'UNDO_CHECK_IN');
      if (line.checked_in_business_date !== p.business_date) throw fail(422, 'TOO_LATE', 'A check-in can only be undone on the day it happened');
      await this.res.transition(trx, propertyId, id, 'UNDO_CHECK_IN', { reason, lineIds: [lineId], userId });
      await trx.updateTable('room_assignment').set({ status: 'ASSIGNED' }).where('assignment_ref', '=', lineId).where('status', '=', 'IN_HOUSE').execute();
      await trx.updateTable('stay_guest').set({ voided_at: new Date(this.clock.now()) }).where('reservation_room_id', '=', lineId).where('voided_at', 'is', null).execute();
      await trx.updateTable('reservation_room').set({ checked_in_at: null, checked_in_business_date: null }).where('id', '=', lineId).execute();
      return this.res.detail(trx, propertyId, id);
    });
  }

  // ───────────── check-out ─────────────
  async checkOut(propertyId: string, id: string, lineId: string, userId: string, i: z.infer<typeof S.CheckOut>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.res.prop(trx, propertyId);
      const bd = p.business_date;
      const { lines } = await this.res.load(trx, propertyId, id, true);
      const line = lines.find((l) => l.id === lineId);
      if (!line) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room line not found on this reservation' });
      nextStatus(line.status, 'CHECK_OUT');
      let newDeparture = line.departure, overstayNights = 0;
      if (bd < line.departure) {
        if (!i.reason) throw fail(422, 'REASON_REQUIRED', `This guest is booked until ${line.departure}. Give a reason for the early departure.`);
        newDeparture = bd > line.arrival ? bd : addDays(line.arrival, 1);              // a stay is never shorter than one night
      } else if (bd > line.departure) overstayNights = nightsOf(line.departure, bd).length;
      const assignment = await this.liveAssignment(trx, lineId);

      await this.res.transition(trx, propertyId, id, 'CHECK_OUT', { reason: i.reason ?? 'Checked out', lineIds: [lineId], userId });   // releases the whole booked range, so unused nights become sellable again
      const early = newDeparture < line.departure;
      if (early) {
        await trx.deleteFrom('stay_night').where('reservation_room_id', '=', lineId).where('business_date', '>=', newDeparture).execute();
        const sums = await sql<{ gross: string; disc: string; total: string }>`SELECT coalesce(sum(room_minor + extras_minor),0)::text AS gross, coalesce(sum(discount_minor),0)::text AS disc, coalesce(sum(total_minor),0)::text AS total FROM stay_night WHERE reservation_room_id = ${lineId}`.execute(trx);
        const s = sums.rows[0]!;
        await trx.updateTable('reservation_room').set({ departure: newDeparture, original_departure: line.departure, subtotal_minor: s.gross, discount_minor: s.disc, total_minor: s.total }).where('id', '=', lineId).execute();
      }
      await trx.updateTable('reservation_room').set({ checked_out_at: new Date(this.clock.now()), checked_out_business_date: bd }).where('id', '=', lineId).execute();
      // bring the folio up to date, then the money must agree before the guest leaves
      await this.folios.postRoomNights(trx, propertyId, { id: lineId, reservation_id: id }, addDays(newDeparture, -1), userId);
      const after = await this.res.load(trx, propertyId, id);
      const lastRoom = !after.lines.some((l) => l.id !== lineId && (l.status === 'CHECKED_IN'));
      const folio = await this.folios.ensureGuestFolio(trx, propertyId, id);
      let balance = BigInt((await this.folios.folioRow(trx, propertyId, folio.id)).balance_minor);
      let settledWithBalance = false;
      if (lastRoom && balance !== 0n) {
        if (!i.balanceReason) throw fail(409, 'BALANCE_DUE', balance > 0n ? `The guest still owes ${fmt(balance, folio.currency).amount}. Take payment before check-out.` : `The folio is overpaid by ${fmt(-balance, folio.currency).amount}. Refund it before check-out.`,
          { balance: fmt(balance, folio.currency) });
        await this.res.requirePermission(userId, 'folio.checkout_with_balance', propertyId);
        await this.res.requireFreshMfa();
        settledWithBalance = true;
        await this.audit.record(trx, { action: 'frontdesk.checkout_with_balance', resourceType: 'reservation', resourceId: id, propertyId, after: { balance: balance.toString() }, reasonCode: 'CHECKOUT_WITH_BALANCE', note: i.balanceReason });
        await this.outbox.publish(trx, { aggregateType: 'folio', aggregateId: folio.id, eventType: 'CheckedOutWithBalance', propertyId, payload: { folioId: folio.id, reservationId: id, balanceMinor: balance.toString(), currency: folio.currency, reason: i.balanceReason } });
      }
      let folioClosed = false;
      if (lastRoom && balance === 0n && !after.lines.some((l) => l.id !== lineId && (l.status === 'CONFIRMED' || l.status === 'OPTION'))) { await this.folios.closeIn(trx, propertyId, folio.id, userId); folioClosed = true; }
      balance = BigInt((await this.folios.folioRow(trx, propertyId, folio.id)).balance_minor);
      if (assignment) {
        await trx.updateTable('room_assignment').set({ end_reason: 'CHECK_OUT' }).where('id', '=', assignment.assignmentId).execute();
        await this.hk.onRoomVacated(trx, propertyId, assignment.room_id, lineId, 'CHECK_OUT', userId);
      }
      await this.res.history(trx, propertyId, id, { lineId, action: 'CHECK_OUT_DETAILS', reason: i.reason, details: { room: assignment?.number ?? null, earlyDeparture: early, originalDeparture: early ? line.departure : null, overstayNights } });
      await this.audit.record(trx, { action: 'frontdesk.check_out', resourceType: 'reservation', resourceId: id, propertyId, after: { room: assignment?.number ?? null, earlyDeparture: early, overstayNights }, note: i.reason });
      return { ...(await this.res.detail(trx, propertyId, id)), checkOut: { earlyDeparture: early, originalDeparture: early ? line.departure : null, overstayNights, roomMarkedDirty: !!assignment, folio: { id: folio.id, balance: fmt(balance, folio.currency), closed: folioClosed, checkedOutWithBalance: settledWithBalance } } };
    });
  }

  // ───────────── in-house room move ─────────────
  async moveRoom(propertyId: string, id: string, lineId: string, userId: string, i: z.infer<typeof S.MoveRoom>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.res.prop(trx, propertyId);
      const bd = p.business_date;
      const { lines } = await this.res.load(trx, propertyId, id, true);
      const line = lines.find((l) => l.id === lineId);
      if (!line) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room line not found on this reservation' });
      if (line.status !== 'CHECKED_IN') throw new ConflictException({ code: 'NOT_IN_HOUSE', message: 'Only an in-house guest can be moved. Use room assignment for future bookings.' });
      const cur = await this.liveAssignment(trx, lineId);
      if (!cur) throw new ConflictException({ code: 'NOT_IN_HOUSE', message: 'This guest has no room' });
      if (cur.room_id === i.roomId) throw fail(422, 'SAME_ROOM', 'The guest is already in that room');
      const target = await this.checkRoomReady(trx, propertyId, i.roomId, lineId, bd, line.departure, i.allowNotReady, userId);
      const full = await trx.selectFrom('room').select(['room_type_id']).where('id', '=', i.roomId).executeTakeFirstOrThrow();
      if (full.room_type_id !== line.room_type_id) throw fail(422, 'WRONG_ROOM_TYPE', 'Moves are within the booked room type. For an upgrade, change the room type on the booking first.');
      // close the old room's occupancy (keep the history), open the new one for the rest of the stay
      await trx.updateTable('room_assignment').set({ status: 'ENDED', ended_at: new Date(this.clock.now()), end_reason: 'ROOM_MOVE',
        ...(bd > line.arrival ? { stay_range: sql`daterange(${line.arrival}::date, ${bd}::date)` as never } : {}) }).where('id', '=', cur.assignmentId).execute();
      try {
        await sql`INSERT INTO room_assignment (tenant_id, property_id, room_id, assignment_ref, stay_range, status)
          VALUES (${currentTenant().tenantId}, ${propertyId}, ${i.roomId}, ${lineId}, daterange(${bd}::date, ${line.departure}::date), 'IN_HOUSE')`.execute(trx);
      } catch (e) {
        if ((e as { code?: string }).code === '23P01') throw fail(409, 'ROOM_NOT_FREE', `Room ${target.number} is booked by someone else during this stay`);
        throw e;
      }
      await this.hk.onRoomVacated(trx, propertyId, cur.room_id, lineId, 'ROOM_MOVE', userId);
      await this.res.history(trx, propertyId, id, { lineId, action: 'ROOM_MOVED', reason: i.reason, details: { from: cur.number, to: target.number } });
      await this.audit.record(trx, { action: 'frontdesk.room_move', resourceType: 'reservation', resourceId: id, propertyId, before: { room: cur.number }, after: { room: target.number }, note: i.reason });
      await this.outbox.publish(trx, { aggregateType: 'reservation', aggregateId: id, eventType: 'RoomChanged', propertyId, payload: { reservationId: id, lineId, roomId: i.roomId, roomNumber: target.number, previousRoomNumber: cur.number, inHouse: true } });
      return this.res.detail(trx, propertyId, id);
    });
  }

  // ───────────── walk-in: price → book → check in, in one transaction ─────────────
  async walkIn(propertyId: string, userId: string, key: string, i: z.infer<typeof S.WalkIn>) {
    await this.res.requirePermission(userId, 'reservation.create', propertyId);
    const hash = hashRequest('POST', `/v1/properties/${propertyId}/front-desk/walk-ins`, i);
    return this.tdb.tx(async (trx) => {
      const r = await this.idem.run(trx, key, hash, async () => ({ statusCode: 201, body: await this.walkInIn(trx, propertyId, userId, i) }));
      return { replayed: r.replayed, body: r.body as Record<string, unknown> };
    });
  }
  private async walkInIn(trx: Trx, propertyId: string, userId: string, i: z.infer<typeof S.WalkIn>) {
    const p = await this.res.prop(trx, propertyId);
    const arrival = p.business_date, departure = addDays(arrival, i.nights);
    let residency: 'RESIDENT' | 'NON_RESIDENT';
    if (i.guestId) { const g = await trx.selectFrom('guest').select(['residency']).where('id', '=', i.guestId).executeTakeFirst(); if (!g) throw fail(422, 'REFERENCE_INVALID', 'Guest not found'); residency = g.residency; }
    else residency = residencyOf(i.guest!.nationality);
    let planId = i.ratePlanId;
    if (!planId) {                                                                         // the walk-in rack rate: the cheapest-sorted public plan that matches the guest's residency
      const plans = await trx.selectFrom('rate_plan').select(['id', 'residency', 'audience', 'channels']).where('property_id', '=', propertyId).where('status', '=', 'ACTIVE').orderBy('sort_order').orderBy('code').execute();
      planId = plans.find((x) => x.audience === 'PUBLIC' && (x.residency === 'ANY' || x.residency === residency) && x.channels.includes('WALKIN'))?.id;
      if (!planId) throw fail(422, 'NO_RATE_PLAN', 'No public rate plan is set up for walk-ins');
    }
    const token = await this.rates.issueQuoteToken(trx, propertyId, planId, { roomTypeId: i.roomTypeId, arrival, departure, adults: i.adults, children: i.children, extraBeds: i.extraBeds, channel: 'WALKIN', residency, companyId: i.companyId ?? null });
    let roomId = i.roomId;
    if (!roomId) {                                                                         // first clean, vacant room of the type that is free for the whole stay
      const free = await sql<{ id: string }>`SELECT r.id FROM room r
        WHERE r.tenant_id = ${currentTenant().tenantId} AND r.property_id = ${propertyId} AND r.room_type_id = ${i.roomTypeId} AND r.status = 'ACTIVE' AND r.hk_status <> 'DIRTY'
          AND NOT EXISTS (SELECT 1 FROM room_assignment a WHERE a.room_id = r.id AND (a.status = 'IN_HOUSE' OR (a.status = 'ASSIGNED' AND a.stay_range && daterange(${arrival}::date, ${departure}::date))))
          AND NOT EXISTS (SELECT 1 FROM room_block b WHERE b.room_id = r.id AND b.cancelled_at IS NULL AND b.start_date < ${departure}::date AND b.end_date > ${arrival}::date)
        ORDER BY lpad(regexp_replace(r.number, '\\D', '', 'g'), 8, '0'), r.number LIMIT 1`.execute(trx);
      roomId = free.rows[0]?.id;
      if (!roomId) throw fail(409, 'NO_ROOM_READY', 'No clean, free room of this type is available right now. Check housekeeping, or choose another type.');
    }
    const created = await this.res.createIn(trx, propertyId, userId, { guestId: i.guestId, guest: i.guest, lines: [{ quoteToken: token }], source: 'WALK_IN', complianceApproval: i.complianceApproval, notesInternal: i.notesInternal, specialRequests: i.specialRequests, companyId: i.companyId ?? undefined } as never);
    const flags = await this.checkInIn(trx, propertyId, created.id, created.lines[0]!.id, userId, { roomId, occupants: i.occupants, allowNotReady: i.allowNotReady, complianceApproval: i.complianceApproval });
    return { ...(await this.res.detail(trx, propertyId, created.id)), checkIn: flags };
  }

  // ───────────── registration card ─────────────
  async occupants(propertyId: string, id: string, lineId: string, userId: string, reveal: boolean) {
    if (reveal) { await this.res.requirePermission(userId, 'frontdesk.view_id', propertyId); await this.res.requireFreshMfa(); }
    return this.tdb.tx(async (trx) => {
      await this.res.prop(trx, propertyId);
      const { lines } = await this.res.load(trx, propertyId, id);
      if (!lines.find((l) => l.id === lineId)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room line not found on this reservation' });
      const rows = await trx.selectFrom('stay_guest').selectAll().where('reservation_room_id', '=', lineId).where('voided_at', 'is', null).orderBy('is_primary', 'desc').orderBy('created_at').execute();
      if (reveal) await this.audit.record(trx, { action: 'frontdesk.view_id', resourceType: 'reservation', resourceId: id, propertyId, note: `${rows.length} document(s) revealed` });
      return { items: rows.map((r) => ({ id: r.id, fullName: r.full_name, isPrimary: r.is_primary, ageGroup: r.age_group, idType: r.id_type, idNumber: !r.id_type || !r.id_number_sealed ? null : reveal ? this.box.open(r.id_number_sealed, this.aad(lineId)) : maskId(r.id_type as IdType, r.id_last4!),
        nationality: r.nationality, idExpiry: r.id_expiry })) };
    });
  }

  /** Everything the printed registration card shows. The full document numbers need the same permission and fresh second factor as seeing them on screen; the print is recorded either way by that rule. */
  async registrationCard(propertyId: string, id: string, lineId: string, userId: string, reveal: boolean) {
    const occ = await this.occupants(propertyId, id, lineId, userId, reveal);
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['name', 'business_date', 'legal_entity_id']).where('id', '=', propertyId).executeTakeFirstOrThrow();
      const le = await trx.selectFrom('legal_entity').select('name').where('id', '=', p.legal_entity_id).executeTakeFirstOrThrow();
      const l = await sql<{ confirmation_no: string; arrival: string; departure: string; adults: number; children: number; type: string; room: string | null }>`
        SELECT r.confirmation_no, l.arrival::text AS arrival, l.departure::text AS departure, l.adults, l.children, rt.name AS type, rm.number AS room
        FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN room_type rt ON rt.id = l.room_type_id
        LEFT JOIN room_assignment a ON a.assignment_ref = l.id AND a.status IN ('ASSIGNED','IN_HOUSE','ENDED') LEFT JOIN room rm ON rm.id = a.room_id
        WHERE l.tenant_id = ${currentTenant().tenantId} AND l.property_id = ${propertyId} AND l.id = ${lineId} AND r.id = ${id} ORDER BY a.created_at DESC NULLS LAST LIMIT 1`.execute(trx);
      const row = l.rows[0];
      if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room line not found on this reservation' });
      return { company: le.name, property: p.name, confirmationNo: row.confirmation_no, room: row.room, roomType: row.type, arrival: row.arrival, departure: row.departure, adults: row.adults, children: row.children, printedOn: p.business_date, idRevealed: reveal,
        guests: occ.items.map((g) => ({ fullName: g.fullName, isPrimary: g.isPrimary, ageGroup: g.ageGroup, idType: g.idType, idNumber: g.idNumber, nationality: g.nationality, idExpiry: g.idExpiry })) };
    });
  }

  // ───────────── room rack (tape chart) ─────────────
  async rack(propertyId: string, q: z.infer<typeof S.RackQuery>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.res.prop(trx, propertyId);
      const bd = p.business_date;
      const from = q.from ?? bd, to = addDays(from, q.days);
      const days = nightsOf(from, to, 62);
      const tenantId = currentTenant().tenantId;
      const [rooms, types, floors, stays, blocks, unassigned, avail, counts] = await Promise.all([
        trx.selectFrom('room').select(['id', 'number', 'room_type_id', 'floor_id', 'hk_status']).where('property_id', '=', propertyId).where('status', '=', 'ACTIVE').execute(),
        trx.selectFrom('room_type').select(['id', 'code', 'name', 'sort_order']).where('property_id', '=', propertyId).where('status', '=', 'ACTIVE').orderBy('sort_order').orderBy('code').execute(),
        trx.selectFrom('floor').select(['id', 'name']).where('property_id', '=', propertyId).execute(),
        sql<{ assignment_id: string; room_id: string; a_status: string; end_reason: string | null; lower: string; upper: string; line_id: string; line_status: string; arrival: string; departure: string; reservation_id: string; confirmation_no: string; at_risk: boolean; source: string; guest_name: string; vip: boolean; adults: number; children: number }>`
          SELECT a.id AS assignment_id, a.room_id, a.status AS a_status, a.end_reason, lower(a.stay_range)::text AS lower, upper(a.stay_range)::text AS upper, l.id AS line_id, l.status AS line_status,
                 l.arrival::text AS arrival, l.departure::text AS departure, r.id AS reservation_id, r.confirmation_no, r.at_risk, r.source, g.full_name AS guest_name, g.vip, l.adults, l.children
          FROM room_assignment a JOIN reservation_room l ON l.id = a.assignment_ref JOIN reservation r ON r.id = l.reservation_id JOIN guest g ON g.id = r.guest_id
          WHERE a.tenant_id = ${tenantId} AND a.property_id = ${propertyId} AND a.stay_range && daterange(${from}::date, ${to}::date)
            AND (a.status IN ('ASSIGNED','IN_HOUSE') OR (a.status = 'ENDED' AND a.end_reason IN ('CHECK_OUT','ROOM_MOVE')))
          ORDER BY a.stay_range`.execute(trx),
        trx.selectFrom('room_block').select(['id', 'room_id', 'block_type', 'start_date', 'end_date', 'reason']).where('property_id', '=', propertyId).where('cancelled_at', 'is', null).where('start_date', '<', to).where('end_date', '>', from).execute(),
        sql<{ line_id: string; reservation_id: string; confirmation_no: string; room_type_id: string; arrival: string; departure: string; line_status: string; guest_name: string; at_risk: boolean }>`
          SELECT l.id AS line_id, r.id AS reservation_id, r.confirmation_no, l.room_type_id, l.arrival::text AS arrival, l.departure::text AS departure, l.status AS line_status, g.full_name AS guest_name, r.at_risk
          FROM reservation_room l JOIN reservation r ON r.id = l.reservation_id JOIN guest g ON g.id = r.guest_id
          WHERE l.tenant_id = ${tenantId} AND l.property_id = ${propertyId} AND l.status IN ('OPTION','CONFIRMED') AND daterange(l.arrival, l.departure) && daterange(${from}::date, ${to}::date)
            AND NOT EXISTS (SELECT 1 FROM room_assignment a WHERE a.assignment_ref = l.id AND a.status IN ('ASSIGNED','IN_HOUSE'))
          ORDER BY l.arrival, r.confirmation_no`.execute(trx),
        this.inv.getAvailability(trx, propertyId, from, to),
        sql<{ k: string; n: number }>`
          SELECT k, count(*)::int AS n FROM (
            SELECT CASE WHEN l.status = 'CONFIRMED' AND l.arrival = ${bd}::date THEN 'arrivalsPending'
                        WHEN l.status = 'CHECKED_IN' AND l.arrival = ${bd}::date THEN 'arrivalsDone'
                        WHEN l.status = 'CHECKED_IN' AND l.departure = ${bd}::date THEN 'departuresPending'
                        WHEN l.status = 'CHECKED_OUT' AND l.checked_out_business_date = ${bd}::date THEN 'departuresDone' END AS k
            FROM reservation_room l WHERE l.tenant_id = ${tenantId} AND l.property_id = ${propertyId}
            UNION ALL SELECT 'inHouse' FROM reservation_room l WHERE l.tenant_id = ${tenantId} AND l.property_id = ${propertyId} AND l.status = 'CHECKED_IN'
            UNION ALL SELECT 'overdueDepartures' FROM reservation_room l WHERE l.tenant_id = ${tenantId} AND l.property_id = ${propertyId} AND l.status = 'CHECKED_IN' AND l.departure < ${bd}::date
            UNION ALL SELECT 'noShowCandidates' FROM reservation_room l WHERE l.tenant_id = ${tenantId} AND l.property_id = ${propertyId} AND l.status = 'CONFIRMED' AND l.arrival < ${bd}::date
            UNION ALL SELECT 'atRisk' FROM reservation_room l JOIN reservation r ON r.id = l.reservation_id WHERE l.tenant_id = ${tenantId} AND l.property_id = ${propertyId} AND l.status = 'CONFIRMED' AND r.at_risk
          ) t WHERE k IS NOT NULL GROUP BY k`.execute(trx),
      ]);
      const n = Object.fromEntries(counts.rows.map((c) => [c.k, c.n])) as Record<string, number>;
      const typeOrder = new Map(types.map((t, k) => [t.id, k]));
      const numKey = (s: string) => Number(s.replace(/\D/g, '') || 0);
      const roomRows = rooms.sort((a, b) => (typeOrder.get(a.room_type_id) ?? 99) - (typeOrder.get(b.room_type_id) ?? 99) || numKey(a.number) - numKey(b.number) || a.number.localeCompare(b.number)).map((r) => {
        const myStays = stays.rows.filter((s) => s.room_id === r.id);
        const myBlocks = blocks.filter((b) => b.room_id === r.id);
        const inHouse = myStays.find((s) => s.a_status === 'IN_HOUSE');
        const blockToday = myBlocks.find((b) => b.start_date <= bd && b.end_date > bd);
        const occupancy = inHouse ? 'OCCUPIED' : blockToday ? blockToday.block_type : 'VACANT';
        return {
          id: r.id, number: r.number, roomTypeId: r.room_type_id, floor: floors.find((f) => f.id === r.floor_id)?.name ?? null, hkStatus: r.hk_status, occupancy,
          readyToSell: occupancy === 'VACANT' && r.hk_status !== 'DIRTY',
          arrivingToday: myStays.some((s) => s.a_status === 'ASSIGNED' && s.lower <= bd && s.upper > bd), dueOutToday: !!inHouse && inHouse.departure <= bd,
          stays: myStays.map((s) => ({ assignmentId: s.assignment_id, reservationId: s.reservation_id, lineId: s.line_id, confirmationNo: s.confirmation_no, guestName: s.guest_name, vip: s.vip,
            status: s.a_status === 'ENDED' ? 'DEPARTED' : s.line_status, from: s.lower, to: s.upper, arrival: s.arrival, departure: s.departure, adults: s.adults, children: s.children, atRisk: s.at_risk, source: s.source })),
          blocks: myBlocks.map((b) => ({ id: b.id, type: b.block_type, from: b.start_date, to: b.end_date, reason: b.reason })),
        };
      });
      const occupiedNow = roomRows.filter((r) => r.occupancy === 'OCCUPIED').length;
      return {
        propertyId, businessDate: bd, from, to, days,
        roomTypes: types.map((t) => ({ id: t.id, code: t.code, name: t.name, availability: (avail.find((a) => a.roomTypeId === t.id)?.nights ?? []).map((x) => ({ date: x.date, sellable: x.sellable, reserved: x.reserved, held: x.held, available: x.available })) })),
        rooms: roomRows,
        unassigned: unassigned.rows.map((u) => ({ lineId: u.line_id, reservationId: u.reservation_id, confirmationNo: u.confirmation_no, roomTypeId: u.room_type_id, arrival: u.arrival, departure: u.departure, status: u.line_status, guestName: u.guest_name, atRisk: u.at_risk })),
        summary: {
          arrivals: { pending: n.arrivalsPending ?? 0, checkedIn: n.arrivalsDone ?? 0 }, departures: { pending: n.departuresPending ?? 0, checkedOut: n.departuresDone ?? 0 },
          inHouse: n.inHouse ?? 0, overdueDepartures: n.overdueDepartures ?? 0, noShowCandidates: n.noShowCandidates ?? 0, atRisk: n.atRisk ?? 0,
          rooms: { total: roomRows.length, occupied: occupiedNow, vacantClean: roomRows.filter((r) => r.occupancy === 'VACANT' && r.hkStatus !== 'DIRTY').length, vacantDirty: roomRows.filter((r) => r.occupancy === 'VACANT' && r.hkStatus === 'DIRTY').length,
            outOfOrder: roomRows.filter((r) => r.occupancy === 'OUT_OF_ORDER').length, outOfService: roomRows.filter((r) => r.occupancy === 'OUT_OF_SERVICE').length },
        },
      };
    });
  }
}
