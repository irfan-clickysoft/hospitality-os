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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'upk'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@upk.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };


async function book(w: W, o: { arrival: string; departure: string }) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival, departure: o.departure, adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(5000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string };
}

describe('upkeep reports', () => {
  it('open jobs, repeat faults, downtime, response times, rooms not ready, housekeeping', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const mk = (body: Record<string, unknown>) => ok(call('POST', u(w, 'work-orders'), O, { title: 'Tap leaks', category: 'PLUMBING', priority: 2, roomId: w.room['103'], ...body }), 201);
    const a = await mk({}); await mk({ title: 'Tap leaks again' });
    await mk({ title: 'AC not cooling', category: 'AC', priority: 1, roomId: w.room['104'], dueDate: '2026-11-03', outOfOrder: { startDate: '2026-11-05', endDate: '2026-11-09' } });
    const open = await ok(call('GET', u(w, 'insights/work-orders-open'), O)); expect(open.rows).toHaveLength(3); expect(open.rows[0]).toMatchObject({ where: '104', pri: 'Urgent', overdue: 'Overdue' });
    const od = await ok(call('GET', u(w, 'insights/work-orders-open?view=overdue'), O)); expect(od.rows).toHaveLength(1);
    const rep = await ok(call('GET', u(w, 'insights/repeat-faults?from=2026-11-01&to=2026-11-30'), O)); expect(rep.rows).toHaveLength(1); expect(rep.rows[0]).toMatchObject({ where: '103', cat: 'Plumbing', n: 2 });
    const dt = await ok(call('GET', u(w, 'insights/room-downtime?from=2026-11-01&to=2026-11-30'), O)); expect(dt.rows).toHaveLength(1); expect(dt.rows[0]).toMatchObject({ room: '104', kind: 'Out of order', nights: 4 });
    await adminDb.updateTable('work_order').set({ status: 'DONE', assigned_at: new Date(testClock.now() + 3_600_000), started_at: new Date(testClock.now() + 2 * 3_600_000), done_at: new Date(testClock.now() + 4 * 3_600_000) } as never).where('id', '=', a.id).execute();
    const tm = await ok(call('GET', u(w, 'insights/work-order-times?from=2026-11-01&to=2026-11-30'), O)); expect(tm.rows[0]).toMatchObject({ what: 'Plumbing', n: 1 }); expect(Number(tm.rows[0].toDone)).toBeGreaterThanOrEqual(4);
    const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-06' });
    const nr = await ok(call('GET', u(w, 'insights/rooms-not-ready'), O)); expect(nr.rows).toHaveLength(1); expect(nr.rows[0].state).toBe('No room assigned');
    await ok(call('PUT', u(w, `reservations/${b.id}/rooms/${b.line}/assignment`), O, { roomId: w.room['101'] })); await adminDb.updateTable('room').set({ hk_status: 'DIRTY' }).where('id', '=', w.room['101']!).execute();
    const nr2 = await ok(call('GET', u(w, 'insights/rooms-not-ready'), O)); expect(nr2.rows[0]).toMatchObject({ room: '101', state: 'Not ready' });
    for (const g of ['staff', 'type', 'list', 'failed']) await ok(call('GET', u(w, `insights/housekeeping-progress?group=${g}`), O));
  });
});
