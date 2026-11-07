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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'bud'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@bud.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };


async function book(w: W, o: { arrival: string; departure: string }) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival, departure: o.departure, adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(9200000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
}
describe('budgets', () => {
  it('are saved by a manager, and the reports compare actual and forecast with them', async () => {
    const w = await sunset(); at('2026-11-01', '10:00'); await setBd(w, '2026-11-01'); await book(w, { arrival: '2026-11-03', departure: '2026-11-05' }); await book(w, { arrival: '2026-11-15', departure: '2026-11-17' });
    at('2026-11-10', '10:00'); await setBd(w, '2026-11-10');
    const fd = await staff(w, 'front_desk_agent');
    await code(call('PUT', u(w, 'budgets/2026-11'), fd.h, { roomRevenue: '300000' }), 403, 'PERMISSION_DENIED');
    await code(call('PUT', u(w, 'budgets/2026-13'), O, { roomRevenue: '300000' }), 400, 'VALIDATION_FAILED');
    await code(call('PUT', u(w, 'budgets/2026-11'), O, { roomRevenue: 'abc' }), 400, 'VALIDATION_FAILED');
    await ok(call('PUT', u(w, 'budgets/2026-11'), O, { roomRevenue: '300000', fnbRevenue: '50000', occupancyPct: 60, note: 'Owner plan' }));
    const y = await ok(call('GET', u(w, 'budgets?year=2026'), O)); expect(y.items).toHaveLength(12); expect(y.items[10]).toMatchObject({ month: '2026-11', roomRevenue: '300000.00', fnbRevenue: '50000.00', occupancyPct: 60, set: true }); expect(y.items[9].set).toBe(false);
    const ro = await ok(call('GET', u(w, 'budgets?year=2026'), fd.h)); expect(ro.items[10].set).toBe(true);        // anyone who can see reports may read it
    await ok(call('PUT', u(w, 'budgets/2026-11'), O, { roomRevenue: '360000', fnbRevenue: '50000', occupancyPct: 60 }));
    const v = await ok(call('GET', u(w, 'insights/budget-variance'), O)); const room = v.rows.find((x: any) => x.what === 'Room revenue');
    expect(room).toMatchObject({ full: '360000.00', todate: '120000.00' });            // 10 of 30 days
    expect(Number(room.actual)).toBeGreaterThan(0); expect(Number(room.forecast)).toBeGreaterThan(Number(room.actual)); expect(Number(room.var)).toBeCloseTo(Number(room.actual) - 120000, 1);
    expect(v.rows.find((x: any) => x.what === 'Occupancy %')).toMatchObject({ full: 60 });
    const op = await ok(call('GET', u(w, 'insights/owner-pack'), O)); expect(new Set(op.rows.map((x: any) => x.section))).toEqual(new Set(['Performance', 'Budget', 'Position']));
    const pv = await ok(call('GET', '/v1/insights/portfolio/portfolio-budget', O)); expect(pv.rows.find((x: any) => x.set === 'Set')).toMatchObject({ month: '2026-11', bud: '36000000' });
    const e = await call('GET', u(w, 'insights/budget-variance?format=csv'), O); expect(e.statusCode).toBe(200);
  });
});
