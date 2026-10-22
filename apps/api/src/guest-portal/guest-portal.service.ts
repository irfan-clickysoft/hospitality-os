import { randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { fmt } from '../companies/companies.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { mediaUrl } from '../media/media.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant, runWithTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

const UUID = /^[0-9a-f]{32}$/;
const TOKEN = /^[0-9a-f]{32}-[0-9a-f]{32}$/;
const toUuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
const MAX_REQUESTS = 20, MAX_PER_HOUR = 6;
const OPEN = ['CONFIRMED', 'OPTION', 'CHECKED_IN'];

@Injectable()
export class GuestPortalService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(OutboxService) private readonly outbox: OutboxService) {}

  /** The private link's secret for staff to put in the message. Made on first use for bookings that pre-date the page. */
  async tokenFor(propertyId: string, reservationId: string) {
    const tenantId = currentTenant().tenantId;
    return this.tdb.tx(async (trx) => {
      const r = await trx.selectFrom('reservation').select(['id', 'guest_token']).where('id', '=', reservationId).where('property_id', '=', propertyId).executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Booking not found' });
      if (r.guest_token) return { token: r.guest_token };
      const token = `${tenantId.replace(/-/g, '')}-${randomBytes(16).toString('hex')}`;
      await trx.updateTable('reservation').set({ guest_token: token }).where('id', '=', reservationId).execute();
      return { token };
    });
  }

  /** Runs `fn` as the hotel the link belongs to. The tenant comes from the token itself and is then enforced by row-level security like any other request. */
  async withToken<T>(token: string, fn: (reservationId: string) => Promise<T>): Promise<T> {
    if (!TOKEN.test(token)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'This link is not valid' });
    const tenantId = toUuid(token.slice(0, 32));
    if (!UUID.test(token.slice(0, 32))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'This link is not valid' });
    return runWithTenant({ tenantId }, async () => {
      const found = await this.tdb.tx((trx) => trx.selectFrom('reservation').select('id').where('guest_token', '=', token).executeTakeFirst());
      if (!found) throw new NotFoundException({ code: 'NOT_FOUND', message: 'This link is not valid' });
      return fn(found.id);
    });
  }

  async page(reservationId: string) {
    const tenantId = currentTenant().tenantId;
    return this.tdb.tx(async (trx) => {
      const r = await trx.selectFrom('reservation').selectAll().where('id', '=', reservationId).executeTakeFirstOrThrow();
      const [p, g, lines, reqs] = await Promise.all([
        trx.selectFrom('property').select(['name', 'city', 'maps_url', 'check_in_time', 'check_out_time', 'terms_text']).where('id', '=', r.property_id).executeTakeFirstOrThrow(),
        trx.selectFrom('guest').select('full_name').where('id', '=', r.guest_id).executeTakeFirstOrThrow(),
        trx.selectFrom('reservation_room').selectAll().where('reservation_id', '=', reservationId).orderBy('line_no').execute(),
        trx.selectFrom('guest_request').selectAll().where('reservation_id', '=', reservationId).orderBy('created_at').execute(),
      ]);
      const typeIds = [...new Set(lines.map((l) => l.room_type_id))];
      const [types, media, ams, assigns] = await Promise.all([
        typeIds.length ? trx.selectFrom('room_type').selectAll().where('id', 'in', typeIds).execute() : [],
        typeIds.length ? trx.selectFrom('room_type_media').selectAll().where('room_type_id', 'in', typeIds).orderBy('sort_order').orderBy('created_at').execute() : [],
        typeIds.length ? trx.selectFrom('room_type_amenity as x').innerJoin('amenity as a', 'a.id', 'x.amenity_id').select(['x.room_type_id', 'a.name_en', 'a.name_ur', 'a.category']).where('x.room_type_id', 'in', typeIds).execute() : [],
        trx.selectFrom('room_assignment as a').innerJoin('room as rm', 'rm.id', 'a.room_id').leftJoin('floor as f', 'f.id', 'rm.floor_id').select(['a.assignment_ref', 'rm.number', 'f.name as floor']).where('a.assignment_ref', 'in', lines.map((l) => l.id)).where('a.status', 'in', ['ASSIGNED', 'IN_HOUSE']).execute(),
      ]);
      const live = lines.filter((l) => !['CANCELLED', 'NO_SHOW'].includes(l.status));
      const shown = live.length ? live : lines;
      return {
        property: { name: p.name, city: p.city, mapsUrl: p.maps_url, checkInTime: String(p.check_in_time).slice(0, 5), checkOutTime: String(p.check_out_time).slice(0, 5), terms: p.terms_text },
        booking: { confirmationNo: r.confirmation_no, status: r.status, guestName: g.full_name, arrival: shown.map((l) => l.arrival).sort()[0] ?? null, departure: shown.map((l) => l.departure).sort().slice(-1)[0] ?? null,
          canRequest: OPEN.includes(r.status), specialRequests: r.special_requests },
        rooms: shown.map((l) => {
          const t = types.find((x) => x.id === l.room_type_id)!; const a = assigns.find((x) => x.assignment_ref === l.id);
          return {
            roomType: { name: t.name, description: t.description, bedConfig: t.bed_config, sizeSqm: t.size_sqm, maxOccupancy: t.max_occupancy },
            adults: l.adults, children: l.children, arrival: l.arrival, departure: l.departure, status: l.status, policy: l.policy,
            roomNumber: a?.number ?? null, floor: a?.floor ?? null,
            amenities: ams.filter((x) => x.room_type_id === t.id).map((x) => ({ en: x.name_en, ur: x.name_ur, category: x.category })),
            media: media.filter((m) => m.room_type_id === t.id).map((m) => ({ kind: m.kind, url: mediaUrl(tenantId, m.file_name, ''), caption: m.caption })),
          };
        }),
        slips: (await trx.selectFrom('payment_slip').select(['id', 'status', 'claimed_amount_minor', 'reference', 'reject_reason', 'submitted_at']).where('reservation_id', '=', reservationId).where('source', '=', 'GUEST').orderBy('submitted_at').execute())
          .map((x) => ({ id: x.id, status: x.status, claimed: x.claimed_amount_minor === null ? null : fmt(x.claimed_amount_minor, r.currency), reference: x.reference, rejectReason: x.reject_reason, submittedAt: x.submitted_at })),
        requests: reqs.map((q) => ({ id: q.id, kind: q.kind, neededOn: q.needed_on, neededTime: q.needed_time, flightNo: q.flight_no, passengers: q.passengers, note: q.note, status: q.status, staffNote: q.staff_note, createdAt: q.created_at })),
      };
    });
  }

  async request(reservationId: string, i: z.infer<typeof S.GuestRequest>) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.selectFrom('reservation').select(['id', 'property_id', 'status', 'confirmation_no']).where('id', '=', reservationId).forUpdate().executeTakeFirstOrThrow();
      if (!OPEN.includes(r.status)) throw new ConflictException({ code: 'BOOKING_CLOSED', message: 'This booking is no longer open for requests. Please call the hotel.' });
      const mine = await trx.selectFrom('guest_request').select(['created_at']).where('reservation_id', '=', reservationId).execute();
      if (mine.length >= MAX_REQUESTS || mine.filter((q) => Date.now() - new Date(q.created_at as never).getTime() < 3_600_000).length >= MAX_PER_HOUR) {
        throw new ConflictException({ code: 'TOO_MANY_REQUESTS', message: 'You have sent several requests already. Please call the hotel for anything urgent.' });
      }
      const row = await trx.insertInto('guest_request').values({
        tenant_id: currentTenant().tenantId, property_id: r.property_id, reservation_id: reservationId, kind: i.kind, needed_on: i.neededOn ?? null, needed_time: i.neededTime ?? null,
        flight_no: i.flightNo ?? null, passengers: i.passengers ?? null, note: i.note || null,
      }).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'guest_request.create', resourceType: 'reservation', resourceId: reservationId, propertyId: r.property_id, after: { requestId: row.id, kind: i.kind } });
      await this.outbox.publish(trx, { aggregateType: 'reservation', aggregateId: reservationId, eventType: 'GuestRequestCreated', propertyId: r.property_id, payload: { requestId: row.id, kind: i.kind, confirmationNo: r.confirmation_no } });
      return { id: row.id };
    });
  }

  // ───────── staff ─────────
  async list(propertyId: string, q: z.infer<typeof S.ListRequests>) {
    return this.tdb.tx(async (trx) => {
      let b = trx.selectFrom('guest_request as q').innerJoin('reservation as r', 'r.id', 'q.reservation_id').innerJoin('guest as g', 'g.id', 'r.guest_id')
        .select(['q.id', 'q.reservation_id', 'q.kind', 'q.needed_on', 'q.needed_time', 'q.flight_no', 'q.passengers', 'q.note', 'q.status', 'q.staff_note', 'q.created_at', 'r.confirmation_no', 'g.full_name'])
        .where('q.property_id', '=', propertyId);
      if (q.status === 'OPEN') b = b.where('q.status', 'in', ['NEW', 'ACKNOWLEDGED']);
      if (q.reservationId) b = b.where('q.reservation_id', '=', q.reservationId);
      const rows = await b.orderBy('q.created_at', 'desc').limit(200).execute();
      return { items: rows.map((x) => ({ id: x.id, reservationId: x.reservation_id, confirmationNo: x.confirmation_no, guestName: x.full_name, kind: x.kind, neededOn: x.needed_on, neededTime: x.needed_time, flightNo: x.flight_no, passengers: x.passengers, note: x.note, status: x.status, staffNote: x.staff_note, createdAt: x.created_at })) };
    });
  }

  async handle(propertyId: string, id: string, i: z.infer<typeof S.HandleRequest>) {
    return this.tdb.tx(async (trx) => {
      const cur = await trx.selectFrom('guest_request').selectAll().where('id', '=', id).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Request not found' });
      await trx.updateTable('guest_request').set({ status: i.status, staff_note: i.staffNote ?? cur.staff_note, handled_by: currentTenant().actorId!, handled_at: new Date() as never }).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'guest_request.handle', resourceType: 'reservation', resourceId: cur.reservation_id, propertyId, before: { status: cur.status }, after: { requestId: id, status: i.status } });
      return { id, status: i.status };
    });
  }
}
