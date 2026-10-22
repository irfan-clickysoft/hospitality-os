import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
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
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 5)]);

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'lf'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

async function sunset() {
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `LF${++n}`, name: `Lost ${n}` })).json().id as string;
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'STD', name: 'Standard', maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id as string;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, from: 101, to: 103 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const plan = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'BAR', residency: 'RESIDENT' })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${plan}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '12000', extraAdult: '3000', extraChild: '1500' }] });
  const rooms = (await call('GET', `/v1/properties/${pid}/rooms`, O)).json().items as Array<{ id: string; number: string }>;
  return { pid, room: Object.fromEntries(rooms.map((r) => [r.number, r.id])) as Record<string, string> };
}
type W = Awaited<ReturnType<typeof sunset>>;
const lf = (w: W, tail = '') => `/v1/properties/${w.pid}/lost-found${tail}`;
const setBd = (w: W, d: string) => adminDb.updateTable('property').set({ business_date: d }).where('id', '=', w.pid).execute();
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@lf.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id) }; };
/** A guest who stayed in room 101 on the 5th and 6th. */
async function stay(w: W, name: string) {
  const q = (await call('POST', `/v1/properties/${w.pid}/quotes`, O, { arrival: '2026-11-05', departure: '2026-11-07', adults: 2 })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: name, phone: `0300${String(7000000 + ++n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', `/v1/properties/${w.pid}/reservations`, O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, { 'idempotency-key': `lf-${++n}-${Date.now()}` }), 201);
  await setBd(w, '2026-11-05');
  await ok(call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/rooms/${r.lines[0].id}/check-in`, O, { roomId: w.room['101'], occupants: [{ fullName: name, isPrimary: true, idType: 'CNIC', idNumber: '3520212345671' }] }));
  await setBd(w, '2026-11-07');
  await ok(call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/rooms/${r.lines[0].id}/check-out`, OM, { balanceReason: 'test: settled elsewhere' }));
  return { guestId: g.id as string, reservationId: r.id as string, confirmationNo: r.confirmationNo as string };
}
const upload = (w: W, id: string, h: Record<string, string>, data = PNG, phase = 'FOUND') => {
  const b = '----lfboundary';
  const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="item.png"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]);
  return app.inject({ method: 'POST', url: lf(w, `/${id}/photos?phase=${phase}`), headers: { ...h, 'content-type': `multipart/form-data; boundary=${b}` }, payload });
};

describe('lost & found workflow', () => {
  it('logged with a picture, linked to the guest who had the room, the guest is told, and the item is handed back with a record of who took it and how we were sure', async () => {
    const w = await sunset(); const s = await stay(w, 'Ali Raza'); const att = await staff(w, 'housekeeper'); const sup = await staff(w, 'housekeeping_supervisor');
    // who might own it: the guest who had room 101 that day
    const sug = (await ok(call('GET', lf(w, `/suggest-owner?roomId=${w.room['101']}&date=2026-11-07`), att.h))).items;
    expect(sug[0]).toMatchObject({ guestName: 'Ali Raza', confirmationNo: s.confirmationNo });
    testClock.set(Date.parse('2026-11-07T12:00:00Z'));
    const item = await ok(call('POST', lf(w), att.h, { item: 'Black leather wallet', category: 'DOCUMENT', description: 'Cards inside', roomId: w.room['101'], location: 'Under the bed', storageLocation: 'Front desk safe', foundAt: '2026-11-07T08:30:00.000Z', highValue: false, guestId: s.guestId, reservationId: s.reservationId }), 201);
    expect(item).toMatchObject({ ref: expect.stringMatching(/^LF-LF\d+-26-00001$/), status: 'FOUND', roomNumber: '101', storageLocation: 'Front desk safe', guest: { name: 'Ali Raza' }, reservationRef: s.confirmationNo });
    expect(item.disposeAfter).toBe('2027-02-05');                                                   // kept 90 days
    expect((await upload(w, item.id, att.h)).statusCode).toBe(201);
    expect((await upload(w, item.id, att.h, Buffer.from('not a picture, just text padding padding padding'))).statusCode).toBe(400);
    const photo = (await ok(call('GET', lf(w, `/${item.id}`), sup.h))).photos[0];
    const img = await call('GET', lf(w, `/${item.id}/photos/${photo.id}`), sup.h);
    expect(img.statusCode).toBe(200); expect(img.rawPayload.equals(PNG)).toBe(true);
    expect((await call('GET', lf(w, `/${item.id}/photos/${photo.id}`), {})).statusCode).toBe(401);
    // tell the guest
    const m = await ok(call('POST', lf(w, `/${item.id}/message`), sup.h));
    expect(m.text).toContain('Dear Ali Raza,'); expect(m.text).toContain('Black leather wallet'); expect(m.text).toContain('(found in Room 101)'); expect(m.text).toContain(`Reference: ${item.ref}`); expect(m.text).not.toContain('Cards inside'); expect(m.phone).toMatch(/^0300/);
    expect((await ok(call('POST', lf(w, `/${item.id}/contact`), sup.h, { channel: 'WHATSAPP', note: 'sent message' }))).status).toBe('OWNER_CONTACTED');
    // hand back: an attendant cannot; the supervisor must say who and how they were sure
    await code(call('POST', lf(w, `/${item.id}/return`), att.h, { receiverName: 'Ali Raza', receiverIdNote: 'CNIC ending 5671', verified: 'Described the cards' }), 403, 'PERMISSION_DENIED');
    expect((await call('POST', lf(w, `/${item.id}/return`), sup.h, { receiverName: 'Ali Raza', verified: 'Described the cards' })).statusCode).toBe(400);              // in person needs the ID shown
    const done = await ok(call('POST', lf(w, `/${item.id}/return`), sup.h, { receiverName: 'Ali Raza', receiverIdNote: 'CNIC ending 5671', verified: 'Described the cards and the photo inside' }));
    expect(done).toMatchObject({ status: 'RETURNED', receiverName: 'Ali Raza', handoverMethod: 'HAND_OVER', closedBy: expect.any(String) });
    await code(call('POST', lf(w, `/${item.id}/return`), sup.h, { receiverName: 'x y', receiverIdNote: 'z', verified: 'again please' }), 409, 'NOT_OPEN');
    const full = await ok(call('GET', lf(w, `/${item.id}`), sup.h));
    expect(full.events.map((e: any) => e.action)).toEqual(['FOUND', 'PHOTO', 'CONTACTED', 'RETURNED']);
    expect((await ok(call('GET', lf(w, ''), sup.h))).items).toEqual([]);                           // not in the open list any more
    expect((await ok(call('GET', lf(w, '?status=RETURNED'), sup.h))).items[0]).toMatchObject({ ref: item.ref });
  });

  it('a courier hand-over needs the tracking number; a high-value item cannot be released by the person who found it', async () => {
    const w = await sunset(); const sup = await staff(w, 'housekeeping_supervisor'); const sup2 = await staff(w, 'housekeeping_supervisor');
    const item = await ok(call('POST', lf(w), sup.h, { item: 'Gold bracelet', category: 'JEWELLERY', highValue: true, roomId: w.room['102'] }), 201);
    const cour = { receiverName: 'Sara Khan', method: 'COURIER', courierRef: 'TCS-123', verified: 'Matched description' };
    await code(call('POST', lf(w, `/${item.id}/return`), sup.h, cour), 403, 'SECOND_PERSON_REQUIRED');
    expect((await call('POST', lf(w, `/${item.id}/return`), sup2.h, { ...cour, courierRef: undefined })).statusCode).toBe(400);
    expect(await ok(call('POST', lf(w, `/${item.id}/return`), sup2.h, cour))).toMatchObject({ status: 'RETURNED', handoverMethod: 'COURIER', courierRef: 'TCS-123' });
  });

  it('disposal waits for the keeping period unless confirmed early with a reason; a returned item can be re-opened if it was a mistake', async () => {
    const w = await sunset(); const sup = await staff(w, 'housekeeping_supervisor'); const att = await staff(w, 'housekeeper');
    const item = await ok(call('POST', lf(w), att.h, { item: 'Old umbrella' }), 201);
    await code(call('POST', lf(w, `/${item.id}/dispose`), sup.h, { reason: 'Nobody claimed it' }), 409, 'KEEPING_PERIOD');
    await setBd(w, '2027-02-06');
    expect((await ok(call('GET', lf(w), sup.h))).items[0].dueForDisposal).toBe(true);
    expect((await ok(call('POST', lf(w, `/${item.id}/dispose`), sup.h, { reason: 'Nobody claimed it in 90 days' }))).status).toBe('DISPOSED');
    await code(call('POST', lf(w, `/${item.id}/reopen`), att.h, { reason: 'Guest called' }), 403, 'PERMISSION_DENIED');
    expect((await ok(call('POST', lf(w, `/${item.id}/reopen`), sup.h, { reason: 'Guest called back' }))).status).toBe('FOUND');
  });

  it('messaging needs an owner to be linked; contact without one is refused; search finds by item, reference and guest name', async () => {
    const w = await sunset(); const sunsetOther = await sunset(); const sup = await staff(w, 'housekeeping_supervisor'); const s = await stay(w, 'Zubair Qureshi');
    const a = await ok(call('POST', lf(w), sup.h, { item: 'Phone charger' }), 201);
    await code(call('POST', lf(w, `/${a.id}/message`), sup.h), 422, 'NO_OWNER');
    await code(call('POST', lf(w, `/${a.id}/contact`), sup.h, {}), 422, 'NO_OWNER');
    const found = (await ok(call('GET', lf(w, '/find-guest?q=qureshi%20zubair'), sup.h))).items;          // housekeeping can find guests of this property, by name in any order
    expect(found).toEqual([expect.objectContaining({ guestName: 'Zubair Qureshi', guestId: s.guestId, confirmationNo: s.confirmationNo })]);
    expect((await ok(call('GET', lf(w, '/find-guest?q=nobody%20here'), sup.h))).items).toEqual([]);
    expect((await ok(call('GET', lf(sunsetOther, '/find-guest?q=zubair'), O))).items).toEqual([]);              // guests of another property are not offered
    await ok(call('PATCH', lf(w, `/${a.id}`), sup.h, { guestId: s.guestId, version: a.version }));
    expect((await ok(call('GET', lf(w, '?q=zubair'), sup.h))).items.map((x: any) => x.ref)).toEqual([a.ref]);
    expect((await ok(call('GET', lf(w, '?q=charger'), sup.h))).items).toHaveLength(1);
    expect((await ok(call('GET', lf(w, `?q=${a.ref}`), sup.h))).items).toHaveLength(1);
    expect((await ok(call('GET', lf(w, '?q=nothing-like-this'), sup.h))).items).toHaveLength(0);
    await code(call('PATCH', lf(w, `/${a.id}`), sup.h, { item: 'xx', version: 99 }), 412, 'VERSION_CONFLICT');
  });

  it('is private to the business and the property', async () => {
    const w = await sunset(); const other = await sunset(); const sup = await staff(w, 'housekeeping_supervisor');
    const a = await ok(call('POST', lf(w), sup.h, { item: 'Scarf' }), 201);
    expect((await call('GET', lf(other, `/${a.id}`), O)).statusCode).toBe(404);
    expect((await call('GET', lf(other), sup.h)).statusCode).toBe(403);
  });
});
