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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'prt'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@prt.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };


async function book(w: W, o: { arrival: string; departure: string; source?: string }) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival, departure: o.departure, adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(2000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: o.source ?? 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string };
}
describe('portfolio reports', () => {
  it('combine the properties a person may see, and nothing else', async () => {
    const a = await sunset(); const b = await sunset(); at('2026-11-05', '10:00'); await setBd(a, '2026-11-05'); await setBd(b, '2026-11-05');
    await book(a, { arrival: '2026-11-10', departure: '2026-11-12' }); await book(a, { arrival: '2026-11-12', departure: '2026-11-13', source: 'WEBSITE' }); await book(b, { arrival: '2026-11-10', departure: '2026-11-11' });
    const cat = await ok(call('GET', '/v1/insights/portfolio', O)); expect(cat.properties).toBeGreaterThanOrEqual(2); expect(cat.items.map((x: any) => x.id)).toEqual(expect.arrayContaining(['portfolio-flash', 'portfolio-comparison', 'portfolio-cash', 'portfolio-mix', 'portfolio-channels', 'portfolio-risk']));
    for (const it of cat.items) { const e = await ok(call('GET', `/v1/insights/portfolio/${it.id}?from=2026-11-01&to=2026-11-30`, O)); expect(e.meta).toMatchObject({ id: it.id, currency: 'PKR' }); expect(e.rows.length, it.id).toBeGreaterThan(0); const x = await call('GET', `/v1/insights/portfolio/${it.id}?from=2026-11-01&to=2026-11-30&format=csv`, O); expect(x.statusCode, it.id).toBe(200); expect(x.body).toContain('All properties'); }
    const cmp = await ok(call('GET', '/v1/insights/portfolio/portfolio-comparison?from=2026-11-01&to=2026-11-30', O));
    expect(cmp.rows).toHaveLength(cat.properties + 1); const all = cmp.rows.at(-1); expect(all).toMatchObject({ prop: 'All properties', sold: 4 }); expect(cmp.rows.slice(0, -1).map((x: any) => x.sold).filter((v: number) => v > 0).sort()).toEqual([1, 3]);
    const ch = await ok(call('GET', '/v1/insights/portfolio/portfolio-channels?from=2026-11-01&to=2026-11-30', O)); expect(ch.rows.find((x: any) => x.what === 'Phone')).toMatchObject({ props: 2, nights: 3 });
    const gm = await addUser(T.tenantId, `gm${++n}@prt.test`); await adminDb.updateTable('staff_user').set({ status: 'ACTIVE' } as never).where('id', '=', gm).execute(); await assignRole(T.tenantId, gm, 'general_manager', 'PROPERTY', a.pid);
    const one = await ok(call('GET', '/v1/insights/portfolio', as(T.tenantId, gm))); expect(one.items).toEqual([]);
    const solo = await ok(call('GET', '/v1/insights/portfolio/portfolio-comparison?from=2026-11-01&to=2026-11-30', as(T.tenantId, gm))); expect(solo.rows).toHaveLength(2); expect(solo.rows[0].sold).toBe(3); expect(solo.warnings.join(' ')).toContain('single-property');
    await code(call('GET', '/v1/insights/portfolio/nope', O), 404, 'NOT_FOUND');
  });
});
