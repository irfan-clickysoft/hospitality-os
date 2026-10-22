import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { zonedToUtcMs } from '@hos/domain-types';
import { normaliseIdNumber, maskId, last4 } from '../src/front-desk/id-documents.js';
import { addUser, adminDb, as, assignRole, createTestApp, provision, testClock } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
let O: Record<string, string>, OM: Record<string, string>;
const OPEN = '2026-11-01';
let n = 0;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...headers, ...extra }, payload: body as object | undefined });
const ok = async (r: Promise<any>, status = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json(); };
const code = async (r: Promise<any>, status: number, c: string) => { const x = await r; expect(x.statusCode, x.body).toBe(status); expect(x.json().code).toBe(c); return x.json(); };

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'fd'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

async function sunset() {
  const pcode = `FD${++n}`;
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: pcode, name: `Desk ${pcode}` })).json().id as string;
  const rt: Record<string, string> = {};
  for (const [c, nm] of [['STD', 'Standard'], ['DLX', 'Deluxe']] as const) rt[c] = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: c, name: nm, maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt.STD, from: 101, to: 103 });
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt.DLX, from: 201, to: 202 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'Best Available (local)', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [
    { roomTypeId: rt.STD, amount: '12000', extraAdult: '3000', extraChild: '1500' }, { roomTypeId: rt.DLX, amount: '15000', extraAdult: '3500', extraChild: '1500' }] });
  const intl = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'INTL', name: 'International', residency: 'NON_RESIDENT', ...rules, derive: { parentPlanId: bar, type: 'PERCENT', value: 2500, roundTo: '100' } })).json().id as string;
  const rooms = (await call('GET', `/v1/properties/${pid}/rooms`, O)).json().items as Array<{ id: string; number: string }>;
  const room = Object.fromEntries(rooms.map((r) => [r.number, r.id])) as Record<string, string>;
  return { pid, rt, bar, intl, room };
}
type W = Awaited<ReturnType<typeof sunset>>;
const setBd = (w: W, d: string) => adminDb.updateTable('property').set({ business_date: d }).where('id', '=', w.pid).execute();
const url = (w: W, rid: string, lid: string, tail: string) => `/v1/properties/${w.pid}/reservations/${rid}/rooms/${lid}/${tail}`;
const cnic = (k = 1) => `3520212345${String(670 + k).padStart(3, '0')}`;
const occ = (o: Record<string, unknown> = {}) => ({ fullName: `Guest ${++n}`, idType: 'CNIC', idNumber: cnic(n % 300), nationality: 'PK', ...o });

/** Books via quote → reservation (arrival defaults to 5 Nov, 2 nights). */
async function book(w: W, o: { room?: string; plan?: string; arrival?: string; departure?: string; adults?: number; children?: number; nationality?: string } = {}) {
  const q = (await call('POST', `/v1/properties/${w.pid}/quotes`, O, { arrival: o.arrival ?? '2026-11-05', departure: o.departure ?? '2026-11-07', adults: o.adults ?? 2, children: o.children ?? 0, residency: o.nationality && o.nationality !== 'PK' ? 'NON_RESIDENT' : 'RESIDENT' })).json();
  const opt = q.options.find((x: any) => x.roomType.code === (o.room ?? 'STD') && x.plan.code === (o.plan ?? 'BAR'));
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Booker ${++n}`, phone: `0300${String(2000000 + n).slice(-7)}`, nationality: o.nationality ?? 'PK' }), 201);
  const r = await ok(call('POST', `/v1/properties/${w.pid}/reservations`, O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: opt.quoteToken }] }, { 'idempotency-key': `fd-${++n}-${Date.now()}` }), 201);
  return { id: r.id as string, line: r.lines[0].id as string, res: r };
}
const checkIn = (w: W, b: { id: string; line: string }, room: string | undefined, o: Record<string, unknown> = {}, h = O) =>
  call('POST', url(w, b.id, b.line, 'check-in'), h, { roomId: room ? w.room[room] : undefined, occupants: [occ({ isPrimary: true }), ...(o.extra as unknown[] ?? [])], ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'extra')) });
const issues = async (w: W) => (await call('GET', `/v1/properties/${w.pid}/inventory-check`, O)).json().issues as Array<{ kind: string }>;
const avail = async (w: W, code: string, d: string) => {
  const r = (await call('GET', `/v1/properties/${w.pid}/availability?from=${d}&to=${d.slice(0, 8)}${String(Number(d.slice(8)) + 1).padStart(2, '0')}`, O)).json();
  return r.roomTypes.find((x: any) => x.code === code).nights[0];
};

describe('identity documents', () => {
  it('normalises CNIC / NICOP / passport and masks for display', () => {
    expect(normaliseIdNumber('CNIC', '3520212345671')).toBe('35202-1234567-1');
    expect(normaliseIdNumber('CNIC', ' 35202 - 1234567 - 1 ')).toBe('35202-1234567-1');
    expect(() => normaliseIdNumber('CNIC', '3520212345')).toThrow(/13 digits/);
    expect(normaliseIdNumber('PASSPORT', 'ab 123456')).toBe('AB123456');
    expect(() => normaliseIdNumber('PASSPORT', '12')).toThrow();
    expect(maskId('CNIC', last4('35202-1234567-1'))).toBe('*****-*******-1');
    expect(maskId('PASSPORT', last4('AB123456'))).toBe('*****3456');
  });
});

describe('check-in', () => {
  it('registers the guests, puts them in the room, marks the stay in-house — and keeps inventory consistent', async () => {
    const w = await sunset(); const b = await book(w);
    await setBd(w, '2026-11-05');
    const r = await ok(checkIn(w, b, '101', { extra: [occ({ fullName: 'Second Guest', idNumber: cnic(77) })] }));
    expect(r.status).toBe('CHECKED_IN');
    expect(r.lines[0]).toMatchObject({ status: 'CHECKED_IN', assignedRoom: { number: '101' } });
    expect(r.checkIn).toMatchObject({ room: { number: '101' }, occupants: 2, lateArrival: false });
    const a = await adminDb.selectFrom('room_assignment').select('status').where('assignment_ref', '=', b.line).executeTakeFirstOrThrow();
    expect(a.status).toBe('IN_HOUSE');
    expect((await avail(w, 'STD', '2026-11-05')).reserved).toBe(1);
    expect(await issues(w)).toEqual([]);
    const actions = (await adminDb.selectFrom('audit_log').select('action').where('tenant_id', '=', T.tenantId).where('resource_id', '=', b.id).execute()).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['reservation.check_in', 'frontdesk.check_in']));
    const ev = (await adminDb.selectFrom('outbox_event').select('event_type').where('tenant_id', '=', T.tenantId).where('aggregate_id', '=', b.id).execute()).map((e) => e.event_type);
    expect(ev).toContain('GuestCheckedIn');
    await code(checkIn(w, b, '101'), 409, 'INVALID_STATE_TRANSITION');                          // cannot check in twice
  });

  it('stores document numbers encrypted; masked by default; full numbers need permission AND a fresh second factor, and are audited', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05');
    await ok(checkIn(w, b, '101', { occupants: [occ({ isPrimary: true, idNumber: '3520299999991' })] }));
    const raw = await adminDb.selectFrom('stay_guest').select(['id_number_sealed', 'id_last4']).where('reservation_room_id', '=', b.line).executeTakeFirstOrThrow();
    expect(raw.id_number_sealed.startsWith('v1:')).toBe(true); expect(raw.id_number_sealed).not.toContain('99999'); expect(raw.id_last4).toBe('9991');
    const masked = await ok(call('GET', url(w, b.id, b.line, 'guests'), O));
    expect(masked.items[0]).toMatchObject({ isPrimary: true, idType: 'CNIC', idNumber: '*****-*******-1' });
    await code(call('GET', url(w, b.id, b.line, 'guests') + '?reveal=true', O), 403, 'MFA_REQUIRED');
    const shown = await ok(call('GET', url(w, b.id, b.line, 'guests') + '?reveal=true', OM));
    expect(shown.items[0].idNumber).toBe('35202-9999999-1');
    expect(await adminDb.selectFrom('audit_log').select('id').where('tenant_id', '=', T.tenantId).where('action', '=', 'frontdesk.view_id').where('resource_id', '=', b.id).execute()).toHaveLength(1);
    const fd = await addUser(T.tenantId, `fd${++n}@fd.test`); await assignRole(T.tenantId, fd, 'front_desk_agent', 'PROPERTY', w.pid);
    await code(call('GET', url(w, b.id, b.line, 'guests') + '?reveal=true', as(T.tenantId, fd, { mfa: true })), 403, 'PERMISSION_DENIED');   // front desk sees masked numbers only
  });

  it('refuses early arrival, expired stays, missing room, bad documents, wrong residency and too many guests', async () => {
    const w = await sunset(); const b = await book(w);
    await code(checkIn(w, b, '101'), 422, 'TOO_EARLY');
    await setBd(w, '2026-11-05');
    await code(checkIn(w, b, undefined), 422, 'ROOM_REQUIRED');
    await code(checkIn(w, b, '101', { occupants: [occ({ isPrimary: true, idNumber: '123' })] }), 422, 'ID_INVALID');
    await code(checkIn(w, b, '101', { occupants: [occ({ nationality: 'GB' })] }), 422, 'RESIDENCY_MISMATCH');
    await code(checkIn(w, b, '101', { occupants: [occ(), occ(), occ()] }), 422, 'OCCUPANCY_EXCEEDED');
    await code(checkIn(w, b, '101', { occupants: [occ({ idNumber: cnic(5) }), occ({ idNumber: cnic(5) })] }), 422, 'ID_INVALID');   // same document twice
    await code(checkIn(w, b, '201'), 422, 'WRONG_ROOM_TYPE');
    expect((await avail(w, 'STD', '2026-11-05')).reserved).toBe(1);                                // nothing half-done after the failures
    await setBd(w, '2026-11-07');
    await code(checkIn(w, b, '101'), 422, 'STAY_ENDED');
  });

  it('foreign guests are registered with a passport; a passport that has expired is refused', async () => {
    const w = await sunset(); const b = await book(w, { plan: 'INTL', nationality: 'GB' }); await setBd(w, '2026-11-05');
    await code(checkIn(w, b, '101', { occupants: [occ({ nationality: 'GB' })] }), 422, 'PASSPORT_REQUIRED');
    await code(checkIn(w, b, '101', { occupants: [occ({ nationality: 'GB', idType: 'PASSPORT', idNumber: 'GB1234567', idExpiry: '2026-01-01' })] }), 422, 'ID_EXPIRED');
    const r = await ok(checkIn(w, b, '101', { occupants: [occ({ nationality: 'GB', idType: 'PASSPORT', idNumber: 'GB1234567', idExpiry: '2030-01-01' })] }));
    expect(r.status).toBe('CHECKED_IN');
  });

  it('will not put a guest into a dirty room without the override (permission + fresh second factor), nor into an occupied or blocked one', async () => {
    const w = await sunset();
    await ok(call('PUT', `/v1/properties/${w.pid}/housekeeping/rooms/${w.room['101']}/status`, O, { status: 'DIRTY' }));
    const b = await book(w); await setBd(w, '2026-11-05');
    await code(checkIn(w, b, '101'), 409, 'ROOM_NOT_READY');
    await code(checkIn(w, b, '101', { allowNotReady: true }, O), 403, 'MFA_REQUIRED');
    const fd = await addUser(T.tenantId, `fd${++n}@fd.test`); await assignRole(T.tenantId, fd, 'front_desk_agent', 'PROPERTY', w.pid);
    await code(checkIn(w, b, '101', { allowNotReady: true }, as(T.tenantId, fd, { mfa: true })), 403, 'PERMISSION_DENIED');
    await ok(checkIn(w, b, '101', { allowNotReady: true }, OM));
    // the previous guest is still in the room on the day the next one arrives
    const next = await book(w, { arrival: '2026-11-07', departure: '2026-11-08' });
    await ok(call('PUT', `/v1/properties/${w.pid}/reservations/${next.id}/rooms/${next.line}/assignment`, O, { roomId: w.room['101'] }));
    await setBd(w, '2026-11-07');
    await code(checkIn(w, next, '101'), 409, 'ROOM_OCCUPIED');
    // a block placed for the stay
    const c = await book(w, { arrival: '2026-11-07', departure: '2026-11-09' });
    await ok(call('POST', `/v1/properties/${w.pid}/room-blocks`, O, { roomId: w.room['102'], type: 'OUT_OF_ORDER', startDate: '2026-11-08', endDate: '2026-11-10', reason: 'AC repair' }), 201);
    await code(checkIn(w, c, '102'), 409, 'ROOM_BLOCKED');
  });

  it('a late arrival (a day after the booked date) still checks in and is flagged; same-day undo works, a later undo does not', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-06');
    const r = await ok(checkIn(w, b, '101'));
    expect(r.checkIn.lateArrival).toBe(true);
    const u = await ok(call('POST', url(w, b.id, b.line, 'undo-check-in'), O, { reason: 'Wrong guest' }));
    expect(u.lines[0]).toMatchObject({ status: 'CONFIRMED', assignedRoom: { number: '101' } });
    expect((await adminDb.selectFrom('stay_guest').select('voided_at').where('reservation_room_id', '=', b.line).execute()).every((x) => x.voided_at)).toBe(true);
    await ok(checkIn(w, b, '101'));
    await setBd(w, '2026-11-07');
    await code(call('POST', url(w, b.id, b.line, 'undo-check-in'), O, { reason: 'Too late' }), 422, 'TOO_LATE');
    expect(await issues(w)).toEqual([]);
  });

  it('reports early check-in (before the property check-in time)', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05');
    testClock.set(zonedToUtcMs('2026-11-05', '09:00', 'Asia/Karachi'));
    expect((await ok(checkIn(w, b, '101'))).checkIn.earlyCheckIn).toBe(true);
    const b2 = await book(w); testClock.set(zonedToUtcMs('2026-11-05', '15:30', 'Asia/Karachi'));
    expect((await ok(checkIn(w, b2, '102'))).checkIn.earlyCheckIn).toBe(false);
  });
});

describe('check-out', () => {
  it('checks out on the departure day: stay closes, room becomes dirty, assignment is kept as history', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05'); await ok(checkIn(w, b, '101'));
    await setBd(w, '2026-11-07');
    const r = await ok(call('POST', url(w, b.id, b.line, 'check-out'), OM, { balanceReason: 'test: settled elsewhere' }));
    expect(r.status).toBe('CHECKED_OUT'); expect(r.checkOut).toMatchObject({ earlyDeparture: false, overstayNights: 0, roomMarkedDirty: true });
    const room = await adminDb.selectFrom('room').select('hk_status').where('id', '=', w.room['101']).executeTakeFirstOrThrow();
    expect(room.hk_status).toBe('DIRTY');
    const a = await adminDb.selectFrom('room_assignment').select(['status', 'end_reason']).where('assignment_ref', '=', b.line).executeTakeFirstOrThrow();
    expect(a).toEqual({ status: 'ENDED', end_reason: 'CHECK_OUT' });
    await code(call('POST', url(w, b.id, b.line, 'check-out'), OM, { balanceReason: 'test: settled elsewhere' }), 409, 'INVALID_STATE_TRANSITION');
    const ev = (await adminDb.selectFrom('outbox_event').select('event_type').where('tenant_id', '=', T.tenantId).where('aggregate_id', 'in', [b.id, w.room['101']]).execute()).map((e) => e.event_type);
    expect(ev).toEqual(expect.arrayContaining(['GuestCheckedOut', 'RoomStatusChanged']));
    expect(await issues(w)).toEqual([]);
  });

  it('early departure needs a reason, cuts the stay and the bill to the nights actually stayed, and frees the room for sale', async () => {
    const w = await sunset(); const b = await book(w, { departure: '2026-11-08' }); await setBd(w, '2026-11-05'); await ok(checkIn(w, b, '101'));
    await setBd(w, '2026-11-06');
    await code(call('POST', url(w, b.id, b.line, 'check-out'), OM, { balanceReason: 'test: settled elsewhere' }), 422, 'REASON_REQUIRED');
    const r = await ok(call('POST', url(w, b.id, b.line, 'check-out'), OM, { reason: 'Family emergency', balanceReason: 'test: settled elsewhere' }));
    expect(r.checkOut).toMatchObject({ earlyDeparture: true, originalDeparture: '2026-11-08' });
    expect(r.lines[0]).toMatchObject({ departure: '2026-11-06', nights: 1, total: { amount: '12000.00' } });
    expect(r.lines[0].nightPrices).toHaveLength(1);
    expect((await avail(w, 'STD', '2026-11-06')).reserved).toBe(0);
    expect((await avail(w, 'STD', '2026-11-07')).reserved).toBe(0);
    const line = await adminDb.selectFrom('reservation_room').select('original_departure').where('id', '=', b.line).executeTakeFirstOrThrow();
    expect(line.original_departure).toBe('2026-11-08');
    expect(await issues(w)).toEqual([]);
  });

  it('leaving on the arrival day still bills one night; an overstay is flagged', async () => {
    const w = await sunset(); const b = await book(w, { departure: '2026-11-08' }); await setBd(w, '2026-11-05'); await ok(checkIn(w, b, '101'));
    const r = await ok(call('POST', url(w, b.id, b.line, 'check-out'), OM, { reason: 'Changed plans', balanceReason: 'test: settled elsewhere' }));
    expect(r.lines[0]).toMatchObject({ departure: '2026-11-06', nights: 1 });
    const c = await book(w, { departure: '2026-11-06' }); await ok(checkIn(w, c, '102'));
    await setBd(w, '2026-11-08');
    const s = await ok(call('POST', url(w, c.id, c.line, 'check-out'), OM, { balanceReason: 'test: settled elsewhere' }));
    expect(s.checkOut.overstayNights).toBe(2);
  });

  it('only staff with check-out permission can do it', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05'); await ok(checkIn(w, b, '101'));
    const hk = await addUser(T.tenantId, `hk${++n}@fd.test`); await assignRole(T.tenantId, hk, 'housekeeper', 'PROPERTY', w.pid);
    expect((await call('POST', url(w, b.id, b.line, 'check-out'), as(T.tenantId, hk), {})).statusCode).toBe(403);
    expect((await call('POST', url(w, b.id, b.line, 'check-in'), as(T.tenantId, hk), {})).statusCode).toBe(403);
  });
});

describe('room move', () => {
  it('moves an in-house guest within the room type; the old room goes dirty and the history is kept', async () => {
    const w = await sunset(); const b = await book(w, { departure: '2026-11-08' }); await setBd(w, '2026-11-05'); await ok(checkIn(w, b, '101'));
    await setBd(w, '2026-11-06');
    await code(call('POST', url(w, b.id, b.line, 'move'), O, { roomId: w.room['201'], reason: 'AC noisy' }), 422, 'WRONG_ROOM_TYPE');
    await ok(call('PUT', `/v1/properties/${w.pid}/housekeeping/rooms/${w.room['102']}/status`, O, { status: 'DIRTY' }));
    await code(call('POST', url(w, b.id, b.line, 'move'), O, { roomId: w.room['102'], reason: 'AC noisy' }), 409, 'ROOM_NOT_READY');
    const r = await ok(call('POST', url(w, b.id, b.line, 'move'), O, { roomId: w.room['103'], reason: 'AC noisy' }));
    expect(r.lines[0].assignedRoom.number).toBe('103');
    expect(r.lines[0].assignmentHistory.map((x: any) => x.roomNumber)).toEqual(['101', '103']);
    expect((await adminDb.selectFrom('room').select('hk_status').where('id', '=', w.room['101']).executeTakeFirstOrThrow()).hk_status).toBe('DIRTY');
    const rows = await adminDb.selectFrom('room_assignment').select(['status', 'end_reason']).where('assignment_ref', '=', b.line).orderBy('created_at').execute();
    expect(rows).toEqual([{ status: 'ENDED', end_reason: 'ROOM_MOVE' }, { status: 'IN_HOUSE', end_reason: null }]);
    expect(await issues(w)).toEqual([]);
    // a room that someone else has booked later in the stay cannot be taken
    const later = await book(w, { arrival: '2026-11-07', departure: '2026-11-08' });
    await ok(call('PUT', `/v1/properties/${w.pid}/reservations/${later.id}/rooms/${later.line}/assignment`, O, { roomId: w.room['101'] }));
    await ok(call('PUT', `/v1/properties/${w.pid}/housekeeping/rooms/${w.room['101']}/status`, O, { status: 'CLEAN' }));
    await code(call('POST', url(w, b.id, b.line, 'move'), O, { roomId: w.room['101'], reason: 'Back again' }), 409, 'ROOM_NOT_FREE');
  });
});

describe('walk-in', () => {
  const body = (w: W, o: Record<string, unknown> = {}) => ({ guest: { fullName: `Walker ${++n}`, phone: `0311${String(3000000 + n).slice(-7)}`, nationality: 'PK' }, roomTypeId: w.rt.STD, nights: 2, adults: 2,
    occupants: [occ({ isPrimary: true })], ...o });
  it('prices at the walk-in rate, books and checks in as one atomic step; a retry with the same key books nothing twice', async () => {
    const w = await sunset(); await setBd(w, '2026-11-05');
    const key = `walk-${++n}-${Date.now()}`; const b = body(w, { roomId: w.room['101'] });
    const r = await call('POST', `/v1/properties/${w.pid}/front-desk/walk-ins`, O, b, { 'idempotency-key': key });
    expect(r.statusCode, r.body).toBe(201);
    const x = r.json();
    expect(x).toMatchObject({ status: 'CHECKED_IN', source: 'WALK_IN', channel: 'WALKIN', guarantee: { atRisk: false } });
    expect(x.lines[0]).toMatchObject({ arrival: '2026-11-05', departure: '2026-11-07', nights: 2, assignedRoom: { number: '101' }, total: { amount: '24000.00' } });
    const again = await call('POST', `/v1/properties/${w.pid}/front-desk/walk-ins`, O, b, { 'idempotency-key': key });
    expect(again.statusCode).toBe(200); expect(again.json().id).toBe(x.id);
    expect((await adminDb.selectFrom('reservation').select('id').where('property_id', '=', w.pid).execute())).toHaveLength(1);
    expect((await avail(w, 'STD', '2026-11-05')).reserved).toBe(1);
    expect(await issues(w)).toEqual([]);
    expect((await call('POST', `/v1/properties/${w.pid}/front-desk/walk-ins`, O, b)).statusCode).toBe(400);   // key required
  });
  it('a foreign walk-in is priced on the international plan and needs a passport; failures leave nothing behind', async () => {
    const w = await sunset(); await setBd(w, '2026-11-05');
    const foreign = (o: Record<string, unknown> = {}) => body(w, { guest: { fullName: 'Tom Walker', phone: '+44 7700 900555', nationality: 'GB' }, nights: 1, occupants: [occ({ isPrimary: true, nationality: 'GB', idType: 'PASSPORT', idNumber: 'GB7654321' })], ...o });
    await code(call('POST', `/v1/properties/${w.pid}/front-desk/walk-ins`, O, foreign({ occupants: [occ({ nationality: 'GB' })] }), { 'idempotency-key': `w-${++n}-aaaa` }), 422, 'PASSPORT_REQUIRED');
    expect(await adminDb.selectFrom('guest').select('id').where('full_name', '=', 'Tom Walker').execute()).toHaveLength(0);          // rolled back with the booking
    const r = await ok(call('POST', `/v1/properties/${w.pid}/front-desk/walk-ins`, O, foreign(), { 'idempotency-key': `w-${++n}-bbbb` }), 201);
    expect(r.lines[0].ratePlan.code).toBe('INTL'); expect(r.lines[0].total.amount).toBe('15000.00');
    expect((await avail(w, 'STD', '2026-11-05')).reserved).toBe(1);
  });
  it('is refused when the room type is sold out, and for staff who cannot create bookings', async () => {
    const w = await sunset(); await setBd(w, '2026-11-05');
    for (const rm of ['201', '202']) await ok(call('POST', `/v1/properties/${w.pid}/front-desk/walk-ins`, O, body(w, { roomTypeId: w.rt.DLX, roomId: w.room[rm], nights: 1 }), { 'idempotency-key': `w-${++n}-cccc` }), 201);
    const r = await call('POST', `/v1/properties/${w.pid}/front-desk/walk-ins`, O, body(w, { roomTypeId: w.rt.DLX, nights: 1 }), { 'idempotency-key': `w-${++n}-dddd` });
    expect(r.statusCode).toBeGreaterThanOrEqual(409);
    const cash = await addUser(T.tenantId, `c${++n}@fd.test`); await assignRole(T.tenantId, cash, 'cashier', 'PROPERTY', w.pid);
    expect((await call('POST', `/v1/properties/${w.pid}/front-desk/walk-ins`, as(T.tenantId, cash), body(w), { 'idempotency-key': `w-${++n}-eeee` })).statusCode).toBe(403);
  });
});

describe('room rack', () => {
  it('shows every room with its stays, blocks, housekeeping state and today’s counts, plus unassigned bookings and per-type availability', async () => {
    const w = await sunset();
    const a = await book(w, { arrival: '2026-11-05', departure: '2026-11-08' });                    // will be in-house
    const b = await book(w, { arrival: '2026-11-06', departure: '2026-11-07' });                    // assigned, arriving later
    const c = await book(w, { room: 'DLX', arrival: '2026-11-05', departure: '2026-11-06' });       // unassigned
    await ok(call('PUT', `/v1/properties/${w.pid}/reservations/${b.id}/rooms/${b.line}/assignment`, O, { roomId: w.room['102'] }));
    await ok(call('POST', `/v1/properties/${w.pid}/room-blocks`, O, { roomId: w.room['103'], type: 'OUT_OF_ORDER', startDate: '2026-11-05', endDate: '2026-11-07', reason: 'Plumbing' }), 201);
    await setBd(w, '2026-11-05'); await ok(checkIn(w, a, '101'));
    const rack = await ok(call('GET', `/v1/properties/${w.pid}/rack?days=5`, O));
    expect(rack).toMatchObject({ businessDate: '2026-11-05', from: '2026-11-05', to: '2026-11-10' }); expect(rack.days).toHaveLength(5);
    expect(rack.rooms.map((r: any) => r.number)).toEqual(['201', '202', '101', '102', '103']);        // house order: by room-type order (then code), then room number
    const by = (num: string) => rack.rooms.find((r: any) => r.number === num); const r101 = by('101'), r102 = by('102'), r103 = by('103');
    expect(r101).toMatchObject({ occupancy: 'OCCUPIED', readyToSell: false }); expect(r101.stays[0]).toMatchObject({ status: 'CHECKED_IN', from: '2026-11-05', to: '2026-11-08', confirmationNo: a.res.confirmationNo });
    expect(r102).toMatchObject({ occupancy: 'VACANT', readyToSell: true }); expect(r102.stays[0]).toMatchObject({ status: 'CONFIRMED', from: '2026-11-06' });
    expect(r103).toMatchObject({ occupancy: 'OUT_OF_ORDER' }); expect(r103.blocks[0]).toMatchObject({ reason: 'Plumbing' });
    expect(rack.unassigned).toHaveLength(1); expect(rack.unassigned[0]).toMatchObject({ lineId: c.line, roomTypeId: w.rt.DLX });
    expect(rack.summary).toMatchObject({ arrivals: { pending: 1, checkedIn: 1 }, inHouse: 1, rooms: { total: 5, occupied: 1, outOfOrder: 1 } });
    expect(rack.roomTypes.find((t: any) => t.code === 'STD').availability).toHaveLength(5);
    // departed guests stay visible as history on the chart
    await setBd(w, '2026-11-08'); await ok(call('POST', url(w, a.id, a.line, 'check-out'), OM, { balanceReason: 'test: settled elsewhere' }));
    const after = await ok(call('GET', `/v1/properties/${w.pid}/rack?from=2026-11-05&days=5`, O));
    const a101 = after.rooms.find((r: any) => r.number === '101');
    expect(a101.stays.some((s: any) => s.status === 'DEPARTED')).toBe(true);
    expect(a101).toMatchObject({ occupancy: 'VACANT', hkStatus: 'DIRTY', readyToSell: false });
    expect(after.summary).toMatchObject({ inHouse: 0, departures: { checkedOut: 1 }, rooms: { vacantDirty: 1 } });
    expect((await call('GET', `/v1/properties/${w.pid}/rack?days=90`, O)).statusCode).toBe(400);
  });
  it('is limited to staff with access to that property', async () => {
    const w = await sunset(); const other = await sunset();
    const fd = await addUser(T.tenantId, `fd${++n}@fd.test`); await assignRole(T.tenantId, fd, 'front_desk_agent', 'PROPERTY', w.pid);
    expect((await call('GET', `/v1/properties/${w.pid}/rack`, as(T.tenantId, fd))).statusCode).toBe(200);
    expect((await call('GET', `/v1/properties/${other.pid}/rack`, as(T.tenantId, fd))).statusCode).toBe(403);
    const hk = await addUser(T.tenantId, `hk${++n}@fd.test`); await assignRole(T.tenantId, hk, 'housekeeper', 'PROPERTY', w.pid);
    expect((await call('GET', `/v1/properties/${w.pid}/rack`, as(T.tenantId, hk))).statusCode).toBe(403);
  });
});

describe('housekeeping status', () => {
  it('a supervisor can override a room’s state (audited); nobody else’s, and attendants cannot', async () => {
    const w = await sunset(); const other = await sunset();
    const hk = await addUser(T.tenantId, `hk${++n}@fd.test`); await assignRole(T.tenantId, hk, 'housekeeping_supervisor', 'PROPERTY', w.pid);
    const H = as(T.tenantId, hk);
    const att = await addUser(T.tenantId, `att${++n}@fd.test`); await assignRole(T.tenantId, att, 'housekeeper', 'PROPERTY', w.pid);
    expect((await call('PUT', `/v1/properties/${w.pid}/housekeeping/rooms/${w.room['101']}/status`, as(T.tenantId, att), { status: 'CLEAN' })).statusCode).toBe(403);   // attendants work through tasks, not by editing room state
    await ok(call('PUT', `/v1/properties/${w.pid}/housekeeping/rooms/${w.room['101']}/status`, H, { status: 'DIRTY' }));
    const r = await ok(call('PUT', `/v1/properties/${w.pid}/housekeeping/rooms/${w.room['101']}/status`, H, { status: 'INSPECTED' }));
    expect(r).toMatchObject({ number: '101', hkStatus: 'INSPECTED' });
    expect((await call('PUT', `/v1/properties/${other.pid}/housekeeping/rooms/${other.room['101']}/status`, H, { status: 'CLEAN' })).statusCode).toBe(403);
    expect((await call('PUT', `/v1/properties/${w.pid}/housekeeping/rooms/${other.room['101']}/status`, H, { status: 'CLEAN' })).statusCode).toBe(404);
    expect((await call('PUT', `/v1/properties/${w.pid}/housekeeping/rooms/${w.room['101']}/status`, H, { status: 'SPARKLING' })).statusCode).toBe(400);
    expect(await adminDb.selectFrom('audit_log').select('id').where('tenant_id', '=', T.tenantId).where('action', '=', 'housekeeping.status').where('resource_id', '=', w.room['101']).execute()).toHaveLength(2);
  });
});

describe('short stays', () => {
  const rule = { tiers: [{ upToHours: 3, percent: 30 }, { upToHours: 6, percent: 50 }, { upToHours: 12, percent: 75 }] };
  const setRule = async (w: W, r: unknown) => { const v = (await call('GET', `/v1/properties/${w.pid}`, O)).json().version; return call('PATCH', `/v1/properties/${w.pid}`, O, { shortStayRule: r, version: v }); };
  const at = (time: string, date = '2026-11-05') => testClock.set(zonedToUtcMs(date, time, 'Asia/Karachi'));
  const inAt = async (w: W, time: string) => { await setBd(w, '2026-11-05'); const b = await book(w); at(time); await ok(checkIn(w, b, '101')); return b; };
  const out = (w: W, b: { id: string; line: string }, body: Record<string, unknown> = {}, h = OM) => call('POST', url(w, b.id, b.line, 'check-out'), h, { reason: 'Leaving for a flight', balanceReason: 'test: settled elsewhere', ...body });
  const folioBal = async (w: W, b: { id: string }) => (await ok(call('GET', `/v1/properties/${w.pid}/reservations/${b.id}/folio`, O))).folio.balance.amount as string;

  it('a guest who leaves a few hours after checking in is charged the share of the night the property sets for that length of stay, and the other nights are released', async () => {
    const w = await sunset(); expect((await setRule(w, rule)).statusCode).toBe(200);
    const b = await inAt(w, '12:00'); at('14:00');
    const pre = await ok(call('GET', url(w, b.id, b.line, 'check-out-preview'), O));
    expect(pre).toMatchObject({ eligible: true, hoursStayed: 2, default: 'RULE', night: { amount: '12000.00' } });
    expect(pre.options).toMatchObject([{ mode: 'RULE', percent: 30, charge: { amount: '3600.00' } }, { mode: 'FULL_NIGHT', percent: 100, charge: { amount: '12000.00' } }]);
    const r = await ok(out(w, b));
    expect(r.checkOut).toMatchObject({ earlyDeparture: true, shortStay: { mode: 'RULE', percent: 30, hoursStayed: 2, charged: { amount: '3600.00' }, waived: { amount: '8400.00' } } });
    expect(await folioBal(w, b)).toBe('3600.00');
    const posts = (await ok(call('GET', `/v1/properties/${w.pid}/reservations/${b.id}/folio`, O))).postings.map((p: any) => p.description);
    expect(posts.some((d: string) => d.startsWith('Short stay'))).toBe(true);
    expect((await avail(w, 'STD', '2026-11-06')).available).toBeGreaterThan(0);                           // the night after is sellable again
    const ev = await adminDb.selectFrom('outbox_event').select('event_type').where('aggregate_id', '=', b.id).where('event_type', '=', 'ShortStayCharged').execute(); expect(ev).toHaveLength(1);
  });

  it('a longer stay moves up the tiers; past the last tier, or with no rule, it is the whole night', async () => {
    const w = await sunset(); await setRule(w, rule);
    const b1 = await inAt(w, '12:00'); at('17:00');                                                       // 5 hours → 50 %
    expect((await ok(out(w, b1))).checkOut.shortStay).toMatchObject({ percent: 50, charged: { amount: '6000.00' } });
    const b2 = await book(w); at('12:00'); await ok(checkIn(w, b2, '102')); at('14:00', '2026-11-05'); at('23:30');   // 11.5 hours → 75 %
    expect((await ok(out(w, b2))).checkOut.shortStay).toMatchObject({ percent: 75, charged: { amount: '9000.00' } });
    const w2 = await sunset(); const b3 = await inAt(w2, '12:00'); at('13:00');                           // no rule: the whole night, as before
    expect((await ok(call('GET', url(w2, b3.id, b3.line, 'check-out-preview'), O))).default).toBe('FULL_NIGHT');
    expect((await ok(out(w2, b3))).checkOut.shortStay).toMatchObject({ mode: 'FULL_NIGHT', percent: 100, charged: { amount: '12000.00' } });
  });

  it('the desk can charge the whole night anyway; a different amount or waiving it needs the override permission and a reason', async () => {
    const w = await sunset(); await setRule(w, rule);
    const b1 = await inAt(w, '12:00'); at('13:00');
    expect((await ok(out(w, b1, { shortStay: { mode: 'FULL_NIGHT' } }))).checkOut.shortStay).toMatchObject({ percent: 100, charged: { amount: '12000.00' } });
    const fd = await addUser(T.tenantId, `fd${++n}@sh.test`); await assignRole(T.tenantId, fd, 'front_desk_agent', 'PROPERTY', w.pid);
    const b2 = await book(w); at('12:00'); await ok(checkIn(w, b2, '102')); at('13:30');
    await code(out(w, b2, { shortStay: { mode: 'CUSTOM', amount: '0', reason: 'Guest was unwell, goodwill' }, balanceReason: undefined }, as(T.tenantId, fd)), 403, 'PERMISSION_DENIED');
    await code(out(w, b2, { shortStay: { mode: 'CUSTOM', amount: '5000' } }), 400, 'VALIDATION_FAILED');
    await code(out(w, b2, { shortStay: { mode: 'CUSTOM', amount: '99999', reason: 'Too much' } }), 422, 'VALIDATION_FAILED');
    const r = await ok(out(w, b2, { shortStay: { mode: 'CUSTOM', amount: '0', reason: 'Guest was unwell, goodwill' } }));
    expect(r.checkOut.shortStay).toMatchObject({ mode: 'CUSTOM', charged: { amount: '0.00' }, waived: { amount: '12000.00' } });
    expect(await folioBal(w, b2)).toBe('0.00');
  });

  it('only same-day departures are short stays; a guest who stayed the night is charged the nights stayed as before', async () => {
    const w = await sunset(); await setRule(w, rule);
    const b = await inAt(w, '12:00');
    await setBd(w, '2026-11-06'); at('09:00', '2026-11-06');
    expect((await ok(call('GET', url(w, b.id, b.line, 'check-out-preview'), O))).eligible).toBe(false);
    await code(out(w, b, { shortStay: { mode: 'RULE' } }), 422, 'SHORT_STAY_NOT_ELIGIBLE');
    const r = await ok(out(w, b)); expect(r.checkOut.shortStay).toBeNull(); expect(await folioBal(w, b)).toBe('12000.00');
  });

  it('the rule is saved with steps that go up, and refused when they do not', async () => {
    const w = await sunset();
    expect((await setRule(w, { tiers: [{ upToHours: 6, percent: 50 }, { upToHours: 3, percent: 30 }] })).statusCode).toBe(400);
    expect((await setRule(w, { tiers: [{ upToHours: 3, percent: 60 }, { upToHours: 6, percent: 50 }] })).statusCode).toBe(400);
    expect((await setRule(w, { tiers: [] })).statusCode).toBe(400);
    expect((await setRule(w, rule)).json().shortStayRule).toEqual(rule);
    expect((await setRule(w, null)).json().shortStayRule).toBeNull();
  });
});
