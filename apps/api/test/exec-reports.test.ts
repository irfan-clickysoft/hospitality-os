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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'exe'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@exe.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };


async function book(w: W, o: { arrival: string; departure: string }, guest: Record<string, unknown> = {}) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival, departure: o.departure, adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(9100000 + n).slice(-7)}`, nationality: 'PK', ...guest }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string };
}
describe('executive, invoice, data-quality, pipeline and upkeep reports', () => {
  it('scorecard, invoice checks, data quality, pipeline, preventive due, vendor performance', async () => {
    const w = await sunset();      // bookings can only be made from the business date on (and the system opens on 1 Nov), so move it forward between them
    at('2026-11-01', '10:00'); await setBd(w, '2026-11-01'); await book(w, { arrival: '2026-11-03', departure: '2026-11-05' });
    at('2026-11-10', '10:00'); await setBd(w, '2026-11-10'); await book(w, { arrival: '2026-11-12', departure: '2026-11-13' }, { nationality: null });
    const sc = await ok(call('GET', u(w, 'insights/scorecard'), O));
    expect(sc.rows.map((x: any) => x.what)).toEqual(expect.arrayContaining(['Rooms sold', 'Occupancy %', 'ADR', 'RevPAR', 'Room revenue']));
    expect(sc.rows.find((x: any) => x.what === 'Rooms sold')).toMatchObject({ mtd: 2, lm: 0, y: 2, ly: 0 });
    expect(sc.rows.find((x: any) => x.what === 'Room revenue')).toMatchObject({ _fmt: 'money', ly: '0.00' }); expect(Number(sc.rows.find((x: any) => x.what === 'Room revenue').mtd)).toBeGreaterThan(0);
    const ic = await ok(call('GET', u(w, 'insights/invoice-exceptions'), O)); expect(ic.rows).toEqual([]);
    const dq = await ok(call('GET', u(w, 'insights/data-quality?from=2026-11-10&to=2026-11-30'), O)); expect(dq.rows.some((x: any) => x.kind === 'No nationality')).toBe(true);
    const pl = await ok(call('GET', u(w, 'insights/quotation-pipeline?from=2026-11-01&to=2026-11-30'), O)); expect(pl.rows).toEqual([]);
    await adminDb.insertInto('maintenance_schedule').values({ tenant_id: T.tenantId, property_id: w.pid, title: 'Service AC filters', category: 'AC', every_n: 3, unit: 'MONTH', next_due: '2026-11-08', created_by: T.ownerUserId } as never).execute();
    const pm = await ok(call('GET', u(w, 'insights/preventive-due'), O)); expect(pm.rows).toHaveLength(1); expect(pm.rows[0]).toMatchObject({ title: 'Service AC filters', state: 'Overdue', every: '3 months' });
    const vendor = await ok(call('POST', '/v1/maintenance/vendors', O, { name: 'Cool Air', trade: 'AC', slaFixHours: 24 }), 201);
    const wo = await ok(call('POST', u(w, 'work-orders'), O, { title: 'AC not cooling', category: 'AC', priority: 2, roomId: w.room['103'], vendorId: vendor.id }), 201);
    await adminDb.updateTable('work_order').set({ created_at: new Date(testClock.now()), status: 'DONE', done_at: new Date(testClock.now() + 5 * 3_600_000), cost_minor: '150000' } as never).where('id', '=', wo.id).execute();
    const vp = await ok(call('GET', u(w, 'insights/vendor-performance?from=2026-11-01&to=2026-11-30'), O)); expect(vp.rows).toHaveLength(1); expect(vp.rows[0]).toMatchObject({ vendor: 'Cool Air', jobs: 1, done: 1, within: '100%', cost: '150000' });
  });
});
