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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'gst'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@gst.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };


async function book(w: W, o: { arrival: string; departure: string }, vip = false) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival, departure: o.departure, adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(4000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  if (vip) await adminDb.updateTable('guest').set({ vip: true }).where('id', '=', g.id).execute();
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }], specialRequests: 'Quiet room please' }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string, guestId: g.id as string };
}
describe('guest experience reports', () => {
  it('requests, recovery, repeat guests, preferences, messaging, safety', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const b = await book(w, { arrival: '2026-11-06', departure: '2026-11-08' }, true);
    await adminDb.insertInto('guest_request').values([{ tenant_id: T.tenantId, property_id: w.pid, reservation_id: b.id, kind: 'WHEELCHAIR' }, { tenant_id: T.tenantId, property_id: w.pid, reservation_id: b.id, kind: 'AIRPORT_PICKUP', status: 'DONE', handled_at: new Date(testClock.now() + 7_200_000) }] as never).execute();
    const rq = await ok(call('GET', u(w, 'insights/guest-requests?from=2026-11-01&to=2026-11-30'), O)); expect(rq.rows).toHaveLength(2); expect(rq.kpis.find((k: any) => k.key === 'wait').value).toBe(1);
    const rg = await ok(call('GET', u(w, 'insights/guest-requests?from=2026-11-01&to=2026-11-30&group=kind'), O)); expect(rg.rows).toHaveLength(2);
    const c1 = await ok(call('POST', u(w, 'cases'), O, { type: 'GUEST_COMPLAINT', category: 'Noise', severity: 'MEDIUM', description: 'Loud music' }), 201);
    await adminDb.updateTable('case_record').set({ compensation_minor: '250000' } as never).where('id', '=', c1.id).execute();
    await ok(call('POST', u(w, 'cases'), O, { type: 'SECURITY', severity: 'CRITICAL', description: 'Door forced' }), 201);
    const rc = await ok(call('GET', u(w, 'insights/service-recovery?from=2026-11-01&to=2026-11-30'), O)); expect(rc.rows).toHaveLength(1); expect(rc.rows[0]).toMatchObject({ kind: 'Case compensation', amount: '250000' });
    const sf = await ok(call('GET', u(w, 'insights/safety-security-trends?from=2026-11-01&to=2026-11-30'), O)); expect(sf.rows).toEqual([expect.objectContaining({ what: 'Security', n: 1, crit: 1 })]);
    const pf = await ok(call('GET', u(w, 'insights/guest-preferences?from=2026-11-05&to=2026-11-30'), O)); expect(pf.rows).toHaveLength(1); expect(pf.rows[0]).toMatchObject({ vip: 'VIP', req: 'Quiet room please', open: 1 });
    await adminDb.insertInto('email_message').values([{ tenant_id: T.tenantId, property_id: w.pid, purpose: 'GUEST', to_address: 'a@x.test', subject: 'Confirmed', body: 'x', status: 'DELIVERED' }, { tenant_id: T.tenantId, property_id: w.pid, purpose: 'GUEST', to_address: 'b@x.test', subject: 'Confirmed', body: 'x', status: 'BOUNCED', error: 'mailbox full' }] as never).execute();
    const ms = await ok(call('GET', u(w, 'insights/message-delivery?from=2026-11-01&to=2026-11-30'), O)); expect(ms.kpis.find((k: any) => k.key === 'bad').value).toBe(1);
    const mp = await ok(call('GET', u(w, 'insights/message-delivery?from=2026-11-01&to=2026-11-30&group=problems'), O)); expect(mp.rows[0]).toMatchObject({ to: 'b@x.test', why: 'mailbox full' });
    const rp = await ok(call('GET', u(w, 'insights/repeat-guests?from=2026-11-01&to=2026-11-30'), O)); expect(rp.rows).toEqual([]);
    await adminDb.updateTable('reservation_room').set({ status: 'CHECKED_OUT', checked_out_business_date: '2026-11-05' } as never).where('id', '=', b.line).execute();
    const rp2 = await ok(call('GET', u(w, 'insights/repeat-guests?from=2026-11-01&to=2026-11-30'), O)); expect(rp2.rows).toHaveLength(1); expect(rp2.rows[0]).toMatchObject({ type: 'First-time', stays: 1, vip: 'VIP' }); expect(rp2.kpis.find((k: any) => k.key === 'rate').value).toBe(0);
  });
});
