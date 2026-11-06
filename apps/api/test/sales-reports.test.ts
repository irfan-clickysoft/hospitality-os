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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'sal'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@sal.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };


async function book(w: W, o: { arrival: string; departure: string; hold?: number }) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival, departure: o.departure, adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(9000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }], ...(o.hold ? { hold: { minutes: o.hold } } : {}) }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string };
}
describe('sales reports', () => {
  it('group nights and revenue by source, room type and plan; booking behaviour; tentative holds', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    await book(w, { arrival: '2026-11-10', departure: '2026-11-12' }); const b2 = await book(w, { arrival: '2026-11-15', departure: '2026-11-18' });
    await book(w, { arrival: '2026-11-20', departure: '2026-11-21', hold: 600 });
    await ok(call('POST', u(w, `reservations/${b2.id}/cancel`), O, { reason: 'Changed plans' }));
    const q = '?from=2026-11-01&to=2026-11-30';
    const ch = await ok(call('GET', u(w, `insights/channel-performance${q}`), O));
    expect(ch.rows).toHaveLength(1); expect(ch.rows[0]).toMatchObject({ what: 'Phone', lines: 1, nights: 2, lost: 1, cancel: 50 }); expect(BigInt(ch.rows[0].rev)).toBeGreaterThan(0n); expect(ch.rows[0].share).toBe(100);
    const rt = await ok(call('GET', u(w, `insights/roomtype-performance${q}`), O)); expect(rt.rows[0]).toMatchObject({ what: 'Standard', nights: 2 });
    const rp = await ok(call('GET', u(w, `insights/rateplan-performance${q}`), O)); expect(rp.rows[0]).toMatchObject({ what: 'BAR', nights: 2 });
    const co = await ok(call('GET', u(w, `insights/corporate-production${q}`), O)); expect(co.rows[0].what).toBe('Not recorded');
    const win = await ok(call('GET', u(w, `insights/booking-behaviour${q}&group=window`), O)); expect(win.rows.map((x: any) => x.what)).toContain('4–7 days');
    const los = await ok(call('GET', u(w, `insights/booking-behaviour${q}&group=los`), O)); expect(los.rows[0]).toMatchObject({ what: '2 nights', lines: 1, nights: 2 });
    const dow = await ok(call('GET', u(w, `insights/booking-behaviour${q}&group=dow`), O)); expect(dow.rows.reduce((s: number, x: any) => s + x.nights, 0)).toBe(2);
    const te = await ok(call('GET', u(w, `insights/tentative-bookings${q}`), O)); expect(te.rows).toHaveLength(1); expect(te.rows[0]).toMatchObject({ arrival: '2026-11-20', nights: 1 }); expect(['Holding', 'Past its time']).toContain(te.rows[0].state);   // lateness uses the database clock, which the test cannot set
  });
});
