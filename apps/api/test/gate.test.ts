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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'gate'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

async function sunset() {
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `NA${++n}`, name: `Audit ${n}` })).json().id as string;
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'STD', name: 'Standard', maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id as string;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, from: 101, to: 104 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'BAR', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '12000', extraAdult: '3000', extraChild: '1500' }] });
  const rooms = (await call('GET', `/v1/properties/${pid}/rooms`, O)).json().items as Array<{ id: string; number: string }>;
  return { pid, rt, room: Object.fromEntries(rooms.map((r) => [r.number, r.id])) as Record<string, string> };
}
type W = Awaited<ReturnType<typeof sunset>>;
const u = (w: W, tail: string) => `/v1/properties/${w.pid}/${tail}`;
const setBd = (w: W, d: string) => adminDb.updateTable('property').set({ business_date: d }).where('id', '=', w.pid).execute();
const bdOf = async (w: W) => (await adminDb.selectFrom('property').select('business_date').where('id', '=', w.pid).executeTakeFirstOrThrow()).business_date;
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@gate.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

async function book(w: W, o: { arrival?: string; departure?: string; hold?: number } = {}) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival ?? '2026-11-05', departure: o.departure ?? '2026-11-07', adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(6000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }], ...(o.hold ? { hold: { minutes: o.hold } } : {}) }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string };
}
const checkIn = (w: W, b: { id: string; line: string }, room: string) => ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-in`), O, { roomId: w.room[room], occupants: [{ fullName: 'Guest', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671' }] }));
const checkOut = (w: W, b: { id: string; line: string }) => ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-out`), OM, { balanceReason: 'test: settled elsewhere' }));
const audit = (w: W, body: Record<string, unknown> = {}, h = O) => call('POST', u(w, 'night-audit/runs'), h, body);
const folioOf = (w: W, b: { id: string }) => ok(call('GET', u(w, `reservations/${b.id}/folio`), O));


const G = (w: W, tail: string) => u(w, `gate/${tail}`);

describe('the gate', () => {
  it('gate security sees today’s arrivals with the name shortened and nothing else, and keeps a log of visitors, vehicles and deliveries coming in and going out', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const gate = await staff(w, 'gate_security'); const clerk = await staff(w, 'cashier'); const desk = await staff(w, 'front_desk_agent');
    const q = (await call('POST', u(w, 'quotes'), O, { arrival: '2026-11-05', departure: '2026-11-06', adults: 2, channel: 'PHONE' })).json();
    const g = await ok(call('POST', '/v1/guests', O, { fullName: 'Sara Ahmed Khan', phone: '03001239999', nationality: 'PK' }), 201);
    await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
    const arr = await ok(call('GET', G(w, 'arrivals'), gate.h));
    expect(arr.items).toHaveLength(1);
    expect(arr.items[0]).toMatchObject({ guest: 'Sara K.', adults: 2, arrived: false });
    expect(JSON.stringify(arr)).not.toContain('Ahmed'); expect(JSON.stringify(arr)).not.toContain('0300'); expect(Object.keys(arr.items[0]).sort()).toEqual(['adults', 'arrived', 'children', 'confirmationNo', 'guest', 'room', 'roomType']);
    await code(call('GET', G(w, 'arrivals'), clerk.h), 403, 'PERMISSION_DENIED');
    await ok(call('GET', G(w, 'arrivals'), desk.h));
    // the log
    await code(call('POST', G(w, 'visits'), gate.h, { kind: 'VISITOR', purpose: 'meeting' }), 400, 'VALIDATION_FAILED');       // nobody identified
    await code(call('POST', G(w, 'visits'), gate.h, { kind: 'VISITOR', name: 'x' }), 400, 'VALIDATION_FAILED');
    const v1 = await ok(call('POST', G(w, 'visits'), gate.h, { kind: 'VISITOR', name: 'Imran Shah', phone: '03111234567', idLast4: '4567', visiting: 'Room 101', purpose: 'Meeting a guest' }), 201);
    const v2 = await ok(call('POST', G(w, 'visits'), gate.h, { kind: 'VEHICLE', plate: 'bkx-123', visiting: 'Executive Room guest' }), 201);
    expect(v2.plate).toBe('BKX-123');
    await ok(call('POST', G(w, 'visits'), gate.h, { kind: 'DELIVERY', name: 'Foodpanda rider', purpose: 'Delivery to kitchen' }), 201);
    await code(call('POST', G(w, 'visits'), clerk.h, { kind: 'VISITOR', name: 'Nobody' }), 403, 'PERMISSION_DENIED');
    let list = await ok(call('GET', G(w, 'visits'), gate.h)); expect(list.open).toHaveLength(3); expect(list.today).toHaveLength(0);
    at('2026-11-05', '11:00');
    expect(await ok(call('POST', G(w, `visits/${v1.id}/out`), gate.h, {}))).toMatchObject({ id: v1.id });
    await code(call('POST', G(w, `visits/${v1.id}/out`), gate.h, {}), 409, 'ALREADY_OUT');
    list = await ok(call('GET', G(w, 'visits'), gate.h)); expect(list.open).toHaveLength(2); expect(list.today.map((x: any) => x.name)).toEqual(['Imran Shah']);
    const trail = await adminDb.selectFrom('audit_log').select('action').where('resource_id', '=', v1.id).execute();
    expect(trail.map((x) => x.action).sort()).toEqual(['gate.in', 'gate.out']);
  });

  it('a printable registration card with signature lines: ID numbers masked unless revealed, which needs the right and a fresh second factor', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' }); await checkIn(w, b, '101');
    const url = (reveal = false) => u(w, `reservations/${b.id}/rooms/${b.line}/registration-card${reveal ? '?reveal=true' : ''}`);
    const r = await call('GET', url(), O);
    expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toContain('text/html'); expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.body).toContain('GUEST REGISTRATION CARD'); expect(r.body).toContain('Guest signature'); expect(r.body).toContain('Front desk'); expect(r.body).toContain('<strong>101</strong>'); expect(r.body).toContain('CNIC');
    expect(r.body).not.toContain('35202-1234567'); expect(r.body).toContain('*****-*******-1');
    await code(call('GET', url(true), O), 403, 'MFA_REQUIRED');
    const full = await call('GET', url(true), OM); expect(full.statusCode, full.body).toBe(200); expect(full.body).toContain('35202-1234567-1');
    const hk = await staff(w, 'housekeeper'); await code(call('GET', url(), hk.h), 403, 'PERMISSION_DENIED');
    const audit = await adminDb.selectFrom('audit_log').select('action').where('action', '=', 'frontdesk.view_id').execute(); expect(audit.length).toBeGreaterThanOrEqual(1);   // revealing is recorded
  });
});
