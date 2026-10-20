import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import type { Trx } from '../companies/companies.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { MediaService } from '../media/media.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const OPEN = ['FOUND', 'OWNER_CONTACTED'];
const KEEP_DAYS = 90;
const addDays = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const longDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
type Row = Awaited<ReturnType<LostFoundService['row']>>;

/** An item found in the hotel, from the moment it is picked up until it is handed back or, after the keeping period, disposed of — every step on record. */
@Injectable()
export class LostFoundService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MediaService) private readonly media: MediaService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  private async can(userId: string, permission: string, propertyId: string) { return (await this.authz.check(userId, { permission, scope: { propertyId } })).effect === 'ALLOW'; }
  private async prop(trx: Trx, id: string) {
    const p = await trx.selectFrom('property').select(['id', 'code', 'name', 'city', 'business_date', 'timezone']).where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return p;
  }
  async row(trx: Trx, propertyId: string, id: string, lock = false) {
    let q = trx.selectFrom('lost_found').selectAll().where('id', '=', id).where('property_id', '=', propertyId);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Item not found' });
    return r;
  }
  private async event(trx: Trx, id: string, action: string, userId: string, note?: string | null) {
    await trx.insertInto('lost_found_event').values({ tenant_id: currentTenant().tenantId, lost_found_id: id, action, note: note ?? null, actor_id: userId }).execute();
  }

  private async view(trx: Trx, r: Row, bd: string) {
    const ids = [r.found_by, r.closed_by].filter((x): x is string => !!x);
    const names = new Map<string, string>();
    if (ids.length) for (const u of await trx.selectFrom('staff_user').select(['id', 'full_name']).where('id', 'in', ids).execute()) names.set(u.id, u.full_name);
    const room = r.room_id ? await trx.selectFrom('room').select('number').where('id', '=', r.room_id).executeTakeFirst() : undefined;
    const guest = r.guest_id ? await trx.selectFrom('guest').select(['id', 'full_name', 'phone']).where('id', '=', r.guest_id).executeTakeFirst() : undefined;
    const res = r.reservation_id ? await trx.selectFrom('reservation').select('confirmation_no').where('id', '=', r.reservation_id).executeTakeFirst() : undefined;
    const photos = await trx.selectFrom('lost_found_media').select(['id', 'phase']).where('lost_found_id', '=', r.id).orderBy('created_at').execute();
    return {
      id: r.id, ref: r.ref, item: r.item, category: r.category, description: r.description, status: r.status, highValue: r.high_value, roomId: r.room_id, roomNumber: room?.number ?? null, location: r.location, storageLocation: r.storage_location,
      foundAt: r.found_at, foundBy: names.get(r.found_by) ?? null, foundById: r.found_by, guest: guest ? { id: guest.id, name: guest.full_name, phone: guest.phone } : null, reservationRef: res?.confirmation_no ?? null, reservationId: r.reservation_id,
      disposeAfter: r.dispose_after, canDisposeNow: !!r.dispose_after && r.dispose_after <= bd,
      closedAt: r.closed_at, closedBy: r.closed_by ? names.get(r.closed_by) ?? null : null, closedNote: r.closed_note, receiverName: r.receiver_name, receiverIdNote: r.receiver_id_note, handoverMethod: r.handover_method, courierRef: r.courier_ref, verifiedNote: r.verified_note,
      photos: photos.map((p) => ({ id: p.id, phase: p.phase })), version: r.version,
    };
  }

  // ───────────── logging an item ─────────────
  async create(propertyId: string, userId: string, i: z.infer<typeof S.Create>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      if (i.roomId && !(await trx.selectFrom('room').select('id').where('id', '=', i.roomId).where('property_id', '=', propertyId).executeTakeFirst())) throw fail(404, 'NOT_FOUND', 'Room not found');
      if (i.guestId && !(await trx.selectFrom('guest').select('id').where('id', '=', i.guestId).executeTakeFirst())) throw fail(404, 'NOT_FOUND', 'Guest not found');
      if (i.reservationId) {
        const r = await trx.selectFrom('reservation').select(['id', 'guest_id']).where('id', '=', i.reservationId).where('property_id', '=', propertyId).executeTakeFirst();
        if (!r) throw fail(404, 'NOT_FOUND', 'Booking not found');
        if (i.guestId && r.guest_id !== i.guestId) throw fail(422, 'VALIDATION_FAILED', 'That booking belongs to a different guest');
      }
      const foundAt = i.foundAt ? new Date(i.foundAt) : new Date(this.clock.now());
      if (foundAt.getTime() > this.clock.now() + 3_600_000) throw fail(422, 'VALIDATION_FAILED', 'The date found cannot be in the future');
      const seq = (await sql<{ v: string }>`INSERT INTO property_counter (tenant_id, property_id, name, value) VALUES (${currentTenant().tenantId}, ${propertyId}, 'lostfound', 1)
        ON CONFLICT (tenant_id, property_id, name) DO UPDATE SET value = property_counter.value + 1 RETURNING value::text AS v`.execute(trx)).rows[0]!.v;
      let guestId = i.guestId ?? null;
      if (!guestId && i.reservationId) guestId = (await trx.selectFrom('reservation').select('guest_id').where('id', '=', i.reservationId).executeTakeFirstOrThrow()).guest_id;
      const r = await trx.insertInto('lost_found').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, ref: `LF-${p.code}-${p.business_date.slice(2, 4)}-${seq.padStart(5, '0')}`, room_id: i.roomId ?? null, location: i.location ?? null,
        item: i.item, category: i.category, description: i.description ?? null, storage_location: i.storageLocation ?? null, high_value: i.highValue, guest_id: guestId, reservation_id: i.reservationId ?? null, found_by: userId, found_at: foundAt,
        dispose_after: addDays(p.business_date, KEEP_DAYS) } as never).returningAll().executeTakeFirstOrThrow();
      await this.event(trx, r.id, 'FOUND', userId, [i.description, i.location, i.roomId ? 'in a room' : null].filter(Boolean).join(' · ') || i.item);
      await this.audit.record(trx, { action: 'lost_found.add', resourceType: 'lost_found', resourceId: r.id, propertyId, after: { ref: r.ref, item: i.item, highValue: i.highValue } });
      return this.view(trx, r, p.business_date);
    });
  }

  /** Who may have lost it: guests who had this room on that day or in the three days before. */
  async suggest(propertyId: string, q: z.infer<typeof S.SuggestQuery>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const date = q.date ?? p.business_date;
      const rows = await sql<{ reservation_id: string; confirmation_no: string; guest_id: string; full_name: string; phone: string | null; arrival: string; departure: string; status: string }>`
        SELECT r.id AS reservation_id, r.confirmation_no, g.id AS guest_id, g.full_name, g.phone, rr.arrival::text, rr.departure::text, rr.status
        FROM room_assignment a JOIN reservation_room rr ON rr.tenant_id = a.tenant_id AND rr.id = a.assignment_ref
        JOIN reservation r ON r.tenant_id = rr.tenant_id AND r.id = rr.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id
        WHERE a.tenant_id = ${currentTenant().tenantId} AND a.room_id = ${q.roomId} AND rr.status IN ('CHECKED_IN','CHECKED_OUT')
          AND rr.arrival <= ${date}::date AND rr.departure >= (${date}::date - 3) ORDER BY rr.departure DESC LIMIT 5`.execute(trx);
      return { items: rows.rows.map((x) => ({ reservationId: x.reservation_id, confirmationNo: x.confirmation_no, guestId: x.guest_id, guestName: x.full_name, phone: x.phone, arrival: x.arrival, departure: x.departure, status: x.status })) };
    });
  }

  /** Find a guest of this property to link — by name or phone — without opening the whole guest book to housekeeping: only guests who stayed here, and only a name and the last stay. */
  async findGuest(propertyId: string, q: string) {
    const text = q.trim();
    if (text.length < 2) return { items: [] };
    return this.tdb.tx(async (trx) => {
      const tokens = text.split(/\s+/).map((t) => t.replace(/[%_]/g, '')).filter((t) => t.length >= 2).slice(0, 5);
      const digits = text.replace(/\D/g, '');
      const rows = await sql<{ guest_id: string; full_name: string; confirmation_no: string; reservation_id: string; arrival: string; departure: string }>`
        SELECT DISTINCT ON (g.id) g.id AS guest_id, g.full_name, r.confirmation_no, r.id AS reservation_id, rr.arrival::text, rr.departure::text
        FROM guest g JOIN reservation r ON r.tenant_id = g.tenant_id AND r.guest_id = g.id AND r.property_id = ${propertyId}
        JOIN reservation_room rr ON rr.tenant_id = r.tenant_id AND rr.reservation_id = r.id AND rr.status IN ('CHECKED_IN','CHECKED_OUT')
        WHERE g.tenant_id = ${currentTenant().tenantId}
          AND (${tokens.length ? sql`(${sql.join(tokens.map((t) => sql`g.full_name ILIKE ${'%' + t + '%'}`), sql` AND `)})` : sql`false`}
               OR (${digits.length >= 6} AND g.phone_norm LIKE ${'%' + digits.slice(-9)}))
        ORDER BY g.id, rr.departure DESC LIMIT 10`.execute(trx);
      return { items: rows.rows.map((x) => ({ guestId: x.guest_id, guestName: x.full_name, reservationId: x.reservation_id, confirmationNo: x.confirmation_no, arrival: x.arrival, departure: x.departure })) };
    });
  }

  // ───────────── reading ─────────────
  async list(propertyId: string, q: z.infer<typeof S.ListQuery>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      let qb = trx.selectFrom('lost_found as l').leftJoin('guest as g', 'g.id', 'l.guest_id').leftJoin('room as rm', 'rm.id', 'l.room_id').selectAll('l').select(['g.full_name as guest_name', 'rm.number as room_number']).where('l.property_id', '=', propertyId);
      if (q.status === 'OPEN') qb = qb.where('l.status', 'in', OPEN as never); else if (q.status !== 'ALL') qb = qb.where('l.status', '=', q.status);
      if (q.roomId) qb = qb.where('l.room_id', '=', q.roomId);
      if (q.q) { const t = `%${q.q.replace(/[%_]/g, '')}%`; qb = qb.where((eb) => eb.or([eb('l.item', 'ilike', t), eb('l.ref', 'ilike', t), eb('l.description', 'ilike', t), eb('g.full_name', 'ilike', t), eb('l.storage_location', 'ilike', t)])); }
      const rows = await qb.orderBy('l.found_at', 'desc').limit(q.limit).execute();
      const photo = rows.length ? await trx.selectFrom('lost_found_media').select(['lost_found_id', 'id']).where('lost_found_id', 'in', rows.map((r) => r.id)).where('phase', '=', 'FOUND').orderBy('created_at').execute() : [];
      const counts = await sql<{ status: string; n: number }>`SELECT status, count(*)::int AS n FROM lost_found WHERE tenant_id = ${currentTenant().tenantId} AND property_id = ${propertyId} GROUP BY status`.execute(trx);
      return {
        items: rows.map((r) => ({ id: r.id, ref: r.ref, item: r.item, category: r.category, status: r.status, highValue: r.high_value, roomNumber: r.room_number, location: r.location, storageLocation: r.storage_location, guestName: r.guest_name, foundAt: r.found_at,
          dueForDisposal: OPEN.includes(r.status) && !!r.dispose_after && r.dispose_after <= p.business_date, coverPhotoId: photo.find((x) => x.lost_found_id === r.id)?.id ?? null })),
        counts: Object.fromEntries(counts.rows.map((c) => [c.status, c.n])),
      };
    });
  }
  async get(propertyId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const r = await this.row(trx, propertyId, id);
      const ev = await trx.selectFrom('lost_found_event as e').leftJoin('staff_user as u', 'u.id', 'e.actor_id').select(['e.action', 'e.note', 'e.at', 'u.full_name']).where('e.lost_found_id', '=', id).orderBy('e.at').execute();
      return { ...(await this.view(trx, r, p.business_date)), events: ev.map((e) => ({ action: e.action, note: e.note, at: e.at, by: e.full_name })) };
    });
  }

  // ───────────── the workflow ─────────────
  async update(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Update>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const r = await this.row(trx, propertyId, id, true);
      if (r.version !== i.version) throw fail(412, 'VERSION_CONFLICT', 'Someone else changed this item. Reload and try again.');
      if (!OPEN.includes(r.status)) throw fail(409, 'NOT_OPEN', 'This item is already closed');
      const set: Record<string, unknown> = {};
      if (i.item !== undefined) set.item = i.item; if (i.category !== undefined) set.category = i.category; if (i.description !== undefined) set.description = i.description; if (i.location !== undefined) set.location = i.location;
      if (i.storageLocation !== undefined) set.storage_location = i.storageLocation; if (i.highValue !== undefined) set.high_value = i.highValue; if (i.disposeAfter !== undefined) set.dispose_after = i.disposeAfter;
      if (i.guestId !== undefined) {
        if (i.guestId && !(await trx.selectFrom('guest').select('id').where('id', '=', i.guestId).executeTakeFirst())) throw fail(404, 'NOT_FOUND', 'Guest not found');
        set.guest_id = i.guestId; if (i.reservationId === undefined) set.reservation_id = null;
      }
      if (i.reservationId !== undefined) {
        if (i.reservationId) {
          const rs = await trx.selectFrom('reservation').select(['guest_id']).where('id', '=', i.reservationId).where('property_id', '=', propertyId).executeTakeFirst();
          if (!rs) throw fail(404, 'NOT_FOUND', 'Booking not found');
          set.reservation_id = i.reservationId; if (i.guestId === undefined) set.guest_id = rs.guest_id;
        } else set.reservation_id = null;
      }
      const u = await trx.updateTable('lost_found').set({ ...set, version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      if (i.guestId !== undefined) await this.event(trx, id, i.guestId ? 'OWNER_LINKED' : 'OWNER_UNLINKED', userId);
      else await this.event(trx, id, 'EDITED', userId, Object.keys(set).join(', '));
      await this.audit.record(trx, { action: 'lost_found.update', resourceType: 'lost_found', resourceId: id, propertyId, after: set });
      return this.view(trx, u, p.business_date);
    });
  }
  async contact(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Contact>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const r = await this.row(trx, propertyId, id, true);
      if (!OPEN.includes(r.status)) throw fail(409, 'NOT_OPEN', 'This item is already closed');
      if (!r.guest_id) throw fail(422, 'NO_OWNER', 'Link the guest it may belong to first');
      const u = await trx.updateTable('lost_found').set({ status: 'OWNER_CONTACTED', version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.event(trx, id, 'CONTACTED', userId, [i.channel, i.note].filter(Boolean).join(': '));
      await this.audit.record(trx, { action: 'lost_found.contact', resourceType: 'lost_found', resourceId: id, propertyId });
      return this.view(trx, u, p.business_date);
    });
  }
  /** Handing it back. Needs the manager-level right; a high-value item must be released by someone other than the person who found it. */
  async handBack(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Return>) {
    if (!(await this.can(userId, 'housekeeping.assign', propertyId))) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Handing an item back needs the "housekeeping.assign" permission' });
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const r = await this.row(trx, propertyId, id, true);
      if (!OPEN.includes(r.status)) throw fail(409, 'NOT_OPEN', 'This item is already closed');
      if (r.high_value && r.found_by === userId) throw fail(403, 'SECOND_PERSON_REQUIRED', 'A high-value item must be handed back by someone other than the person who found it');
      const u = await trx.updateTable('lost_found').set({ status: 'RETURNED', closed_by: userId, closed_at: new Date(this.clock.now()), closed_note: i.verified, verified_note: i.verified, receiver_name: i.receiverName, receiver_id_note: i.receiverIdNote ?? null,
        handover_method: i.method, courier_ref: i.courierRef ?? null, version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.event(trx, id, 'RETURNED', userId, `${i.method === 'COURIER' ? `courier ${i.courierRef}` : i.method === 'REPRESENTATIVE' ? 'to a representative' : 'in person'} → ${i.receiverName}. ${i.verified}`);
      await this.audit.record(trx, { action: 'lost_found.return', resourceType: 'lost_found', resourceId: id, propertyId, after: { receiver: i.receiverName, method: i.method, highValue: r.high_value } });
      return this.view(trx, u, p.business_date);
    });
  }
  async dispose(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Dispose>) {
    if (!(await this.can(userId, 'housekeeping.assign', propertyId))) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Disposing of an item needs the "housekeeping.assign" permission' });
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const r = await this.row(trx, propertyId, id, true);
      if (!OPEN.includes(r.status)) throw fail(409, 'NOT_OPEN', 'This item is already closed');
      if (r.dispose_after && r.dispose_after > p.business_date && !i.early) throw fail(409, 'KEEPING_PERIOD', `Items are kept until ${longDate.format(new Date(`${r.dispose_after}T00:00:00Z`))}. Confirm to dispose of it early.`);
      if (r.high_value && r.found_by === userId) throw fail(403, 'SECOND_PERSON_REQUIRED', 'A high-value item must be disposed of by someone other than the person who found it');
      const u = await trx.updateTable('lost_found').set({ status: 'DISPOSED', closed_by: userId, closed_at: new Date(this.clock.now()), closed_note: i.reason, version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.event(trx, id, 'DISPOSED', userId, `${i.early ? '(early) ' : ''}${i.reason}`);
      await this.audit.record(trx, { action: 'lost_found.dispose', resourceType: 'lost_found', resourceId: id, propertyId, note: i.reason });
      return this.view(trx, u, p.business_date);
    });
  }
  async reopen(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Reopen>) {
    if (!(await this.can(userId, 'housekeeping.assign', propertyId))) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'This needs the "housekeeping.assign" permission' });
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const r = await this.row(trx, propertyId, id, true);
      if (OPEN.includes(r.status)) throw fail(409, 'WRONG_STATE', 'This item is still open');
      const u = await trx.updateTable('lost_found').set({ status: 'FOUND', closed_by: null, closed_at: null, closed_note: null, receiver_name: null, receiver_id_note: null, handover_method: null, courier_ref: null, verified_note: null, version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.event(trx, id, 'REOPENED', userId, i.reason);
      await this.audit.record(trx, { action: 'lost_found.reopen', resourceType: 'lost_found', resourceId: id, propertyId, note: i.reason });
      return this.view(trx, u, p.business_date);
    });
  }
  async addNote(propertyId: string, id: string, userId: string, i: z.infer<typeof S.AddNote>) {
    return this.tdb.tx(async (trx) => { await this.row(trx, propertyId, id); await this.event(trx, id, 'NOTE', userId, i.note); return { id }; });
  }

  // ───────────── photos ─────────────
  async addPhoto(propertyId: string, id: string, userId: string, data: Buffer, phase: 'FOUND' | 'HANDOVER') {
    const file = await this.media.savePrivateImage(data, 8 * 1024 * 1024);
    try {
      return await this.tdb.tx(async (trx) => {
        await this.row(trx, propertyId, id);
        const n = await trx.selectFrom('lost_found_media').select(({ fn }) => fn.countAll<string>().as('n')).where('lost_found_id', '=', id).executeTakeFirstOrThrow();
        if (Number(n.n) >= 6) throw fail(409, 'PHOTO_LIMIT', 'An item can have up to 6 pictures');
        const m = await trx.insertInto('lost_found_media').values({ tenant_id: currentTenant().tenantId, lost_found_id: id, phase, file_name: file, uploaded_by: userId }).returning('id').executeTakeFirstOrThrow();
        await this.event(trx, id, phase === 'HANDOVER' ? 'HANDOVER_PHOTO' : 'PHOTO', userId);
        return { id: m.id, phase };
      });
    } catch (e) { await this.media.removePrivate(file); throw e; }
  }
  async photoFile(propertyId: string, id: string, photoId: string) {
    const f = await this.tdb.tx(async (trx) => { await this.row(trx, propertyId, id); return trx.selectFrom('lost_found_media').select('file_name').where('id', '=', photoId).where('lost_found_id', '=', id).executeTakeFirst(); });
    if (!f) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Picture not found' });
    return this.media.readPrivate(f.file_name);
  }
  async removePhoto(propertyId: string, id: string, userId: string, photoId: string) {
    const name = await this.tdb.tx(async (trx) => {
      await this.row(trx, propertyId, id);
      const m = await trx.deleteFrom('lost_found_media').where('id', '=', photoId).where('lost_found_id', '=', id).returning('file_name').executeTakeFirst();
      if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Picture not found' });
      await this.event(trx, id, 'PHOTO_REMOVED', userId);
      return m.file_name;
    });
    await this.media.removePrivate(name);
  }

  /** The message to the guest it may belong to. It names the item and a reference but never describes it beyond that: the guest is asked to describe it before it is handed over. */
  async message(propertyId: string, id: string, userId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const r = await this.row(trx, propertyId, id);
      if (!r.guest_id) throw fail(422, 'NO_OWNER', 'Link the guest it may belong to first');
      const [g, actor, room] = await Promise.all([
        trx.selectFrom('guest').select(['full_name', 'phone']).where('id', '=', r.guest_id).executeTakeFirstOrThrow(),
        trx.selectFrom('staff_user').select('full_name').where('id', '=', userId).executeTakeFirst(),
        r.room_id ? trx.selectFrom('room').select('number').where('id', '=', r.room_id).executeTakeFirst() : undefined,
      ]);
      const place = p.city ? `${p.name}, ${p.city}` : p.name;
      const text = [`Dear ${g.full_name},`, '', `Greetings from ${place}.`, '',
        `During our routine check we found an item that may belong to you: ${r.item}${room ? ` (found in Room ${room.number})` : ''}.`, '', `Reference: ${r.ref}`, '',
        'Please reply to confirm, and tell us a little about the item so we can be sure it is yours. We can keep it safely for you to collect, or send it by courier (courier charges are paid by the receiver).', '',
        'Warm regards,', actor?.full_name ?? '', place].join('\n');
      return { text, phone: g.phone };
    });
  }
}
void ConflictException;
