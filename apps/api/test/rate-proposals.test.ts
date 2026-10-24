import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { zonedToUtcMs } from '@hos/domain-types';
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
const key = () => ({ 'idempotency-key': `na-${++n}-${Date.now()}` });
const at = (date: string, time: string) => testClock.set(zonedToUtcMs(date, time, 'Asia/Karachi'));

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'rp'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

async function sunset() {
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `RP${++n}`, name: `Rates ${n}` })).json().id as string;
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'STD', name: 'Standard', maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id as string;
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  return { pid, rt };
}
type W = Awaited<ReturnType<typeof sunset>>;
const u = (w: W, tail: string) => `/v1/properties/${w.pid}/${tail}`;
const body = async (w: W, o: Record<string, unknown> = {}) => { const d = await ok(call('GET', u(w, 'rate-proposals/defaults'), O));
  return { reference: 'SS-CT-ZU-0126/106', companyName: 'Skilled Score', attnName: 'Dr. Zeeshan Hassan Usmani', attnTitle: 'Chief Executive Officer', validFrom: d.validFrom, validTo: d.validTo, title: d.title, intro: d.intro, notes: d.notes, facilities: d.facilities, terms: d.terms,
    billing: { contactName: 'Amjad Siddiqui', phone: '+92 333 7725555', email: 'reservations@sunsetbb.com', steps: d.billing.steps }, signatory: 'Hamza Arshad (Manager Finance)', withPhotos: true,
    rows: [{ label: 'Standard Room with breakfast', roomTypeId: w.rt, p1: '11000', p2: '12000' }, { label: 'Deluxe Family room (Triple Occupancy) with breakfast', p1: '17000', p2: '18000', p3: '19000' }, { label: 'Deluxe Executive room (Quad Occupancy) with breakfast', p1: '17000', p2: '18000', p3: '19000', p4: '20000' }], ...o }; };

describe('corporate rate proposals', () => {
  it('starts from the hotel wording, keeps the rates by number of guests, shows a private page with the photos of the room category, and can be copied for the next company', async () => {
    const w = await sunset();
    const d = await ok(call('GET', u(w, 'rate-proposals/defaults'), O));
    expect(d.title).toMatch(/Corporate Room Rates Proposal for 20\d\d/); expect(d.intro).toContain('Greetings from Rates'); expect(d.terms.length).toBeGreaterThan(15); expect(d.facilities.length).toBeGreaterThan(4);
    const q = await ok(call('POST', u(w, 'rate-proposals'), O, await body(w)), 201);
    expect(q.number).toMatch(/^RP-RP\d+-\d{6}$/); expect(q.status).toBe('DRAFT'); expect(q.rows).toHaveLength(3); expect(q.rows[2]).toMatchObject({ p1: '17000.00', p4: '20000.00' }); expect(q.rows[0].p3).toBeNull();
    await adminDb.insertInto('room_type_media').values({ tenant_id: T.tenantId, property_id: w.pid, room_type_id: w.rt, kind: 'IMAGE', file_name: 'abcdef0123456789abcdef0123456789.jpg', content_type: 'image/jpeg', size_bytes: '1000', uploaded_by: T.ownerUserId } as never).execute();
    const page = (await call('GET', u(w, `rate-proposals/${q.id}/page`), O)).body;
    for (const t of ['Skilled Score', 'SS-CT-ZU-0126/106', 'Single guest', 'Quad guests', 'PKR 11,000', 'PKR 20,000', 'Facilities included', 'Terms &amp; conditions', 'Booking and billing instructions', 'Amjad Siddiqui', 'Hamza Arshad', 'abcdef0123456789abcdef0123456789.jpg']) expect(page, t).toContain(t);
    const upd = await ok(call('PUT', u(w, `rate-proposals/${q.id}`), O, { ...(await body(w, { title: 'Corporate Room Rates 2027' })), version: q.version })); expect(upd.title).toBe('Corporate Room Rates 2027');
    await code(call('PUT', u(w, `rate-proposals/${q.id}`), O, { ...(await body(w)), version: q.version }), 412, 'VERSION_CONFLICT');
    const msg = await ok(call('POST', u(w, `rate-proposals/${q.id}/message`), O, {})); expect(msg.text).toContain('/v1/guest/rates/'); expect(msg.text).toContain('SS-CT-ZU-0126/106'); expect(msg.text).toContain('Dr. Zeeshan');
    expect((await ok(call('GET', u(w, `rate-proposals/${q.id}`), O))).status).toBe('SENT');
    const pub = await app.inject({ method: 'GET', url: new URL(msg.url, 'http://x').pathname }); expect(pub.statusCode).toBe(200); expect(pub.body).toContain('PKR 18,000'); expect(pub.headers['x-robots-tag']).toBe('noindex');
    expect((await app.inject({ method: 'GET', url: '/v1/guest/rates/00000000000000000000000000000000-00000000000000000000000000000000' })).statusCode).toBe(404);
    const copy = await ok(call('POST', u(w, `rate-proposals/${q.id}/duplicate`), O, {})); expect(copy.status).toBe('DRAFT'); expect(copy.number).not.toBe(q.number); expect(copy.reference).toBeNull(); expect(copy.rows).toHaveLength(3); expect(copy.terms).toEqual(upd.terms);
    await ok(call('POST', u(w, `rate-proposals/${q.id}/archive`), O, {}));
    expect((await app.inject({ method: 'GET', url: new URL(msg.url, 'http://x').pathname })).statusCode).toBe(404);
    expect((await ok(call('GET', u(w, 'rate-proposals?status=OPEN'), O))).items.map((x: any) => x.id)).toEqual([copy.id]);
  });
  it('is limited to people who manage companies, and refuses a table with no rates or a backwards period', async () => {
    const w = await sunset();
    const fd = await addUser(T.tenantId, `fd${++n}@rp.test`); await assignRole(T.tenantId, fd, 'front_desk_agent', 'PROPERTY', w.pid);
    expect((await call('GET', u(w, 'rate-proposals'), as(T.tenantId, fd))).statusCode).toBe(200);
    expect((await call('POST', u(w, 'rate-proposals'), as(T.tenantId, fd), await body(w))).statusCode).toBe(403);
    const hk = await addUser(T.tenantId, `hk${++n}@rp.test`); await assignRole(T.tenantId, hk, 'housekeeper', 'PROPERTY', w.pid);
    expect((await call('GET', u(w, 'rate-proposals'), as(T.tenantId, hk))).statusCode).toBe(403);
    await code(call('POST', u(w, 'rate-proposals'), O, await body(w, { rows: [{ label: 'Standard Room', p1: '', p2: null }] })), 400, 'VALIDATION_FAILED');
    await code(call('POST', u(w, 'rate-proposals'), O, await body(w, { validFrom: '2026-12-01', validTo: '2026-11-01' })), 400, 'VALIDATION_FAILED');
    await code(call('POST', u(w, 'rate-proposals'), O, await body(w, { rows: [{ label: 'Standard Room', roomTypeId: '00000000-0000-4000-8000-000000000000', p1: '100' }] })), 422, 'REFERENCE_INVALID');
  });
});
