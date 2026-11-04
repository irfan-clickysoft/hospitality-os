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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'aud'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@aud.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };


async function book(w: W) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: '2026-11-05', departure: '2026-11-07', adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(3000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string };
}
describe('audit and staff reports', () => {
  it('activity, reservation and money audit, approvals, sensitive access, deliveries, cashier variance, queue', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const b = await book(w);
    await ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-in`), O, { roomId: w.room['101'], occupants: [{ fullName: 'Guest', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671', nationality: 'PK' }] }));
    const sess = await ok(call('POST', u(w, 'cashier/sessions'), O, { openingFloat: '1000' }), 201);
    await ok(call('POST', u(w, `reservations/${b.id}/payments`), O, { method: 'CASH', amount: '5000' }, key()), 201);
    await ok(call('POST', u(w, `cashier/sessions/${sess.id}/close`), O, { counted: '5800' }));
    const q = '?from=2026-11-05&to=2026-11-05';
    const ua = await ok(call('GET', u(w, `insights/user-activity${q}`), O)); expect(ua.rows.length).toBeGreaterThan(0); expect(ua.rows[0].what).toBe('aud owner');
    const ul = await ok(call('GET', u(w, `insights/user-activity${q}&group=list`), O)); expect(ul.rows.some((x: any) => x.action === 'Payment record')).toBe(true);
    const ra = await ok(call('GET', u(w, `insights/reservation-audit${q}`), O)); expect(ra.rows.length).toBeGreaterThan(1); expect(ra.rows.every((x: any) => x.conf === ra.rows[0].conf)).toBe(true);
    const ma = await ok(call('GET', u(w, `insights/folio-payment-audit${q}`), O)); expect(ma.rows.some((x: any) => x.action === 'Payment record')).toBe(true); expect(ma.rows.some((x: any) => x.action === 'Cashier close')).toBe(true);
    const mc = await ok(call('GET', u(w, `insights/folio-payment-audit${q}&view=cashier`), O)); expect(mc.rows.every((x: any) => /^Cash/.test(x.action))).toBe(true);
    await ok(call('GET', u(w, `insights/approvals-overrides${q}`), O));
    const se = await ok(call('GET', u(w, `insights/sensitive-access${q}`), O)); expect(Array.isArray(se.rows)).toBe(true);
    await ok(call('GET', u(w, 'insights/report-deliveries?from=2026-11-01&to=2026-11-30'), O));
    const cv = await ok(call('GET', u(w, `insights/cashier-variance${q}`), O)); expect(cv.rows[0]).toMatchObject({ who: 'aud owner', shifts: 1, off: 1, net: '-20000' });
    const aq = await ok(call('GET', u(w, 'insights/approval-queue'), O)); expect(aq.rows).toEqual([]);
    await ok(call('POST', u(w, 'work-orders'), O, { title: 'Tap leaks', category: 'PLUMBING', priority: 2, roomId: w.room['102'] }), 201);
  });
});
