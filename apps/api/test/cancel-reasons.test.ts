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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'crs'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@crs.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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


const csv = async (url: string, h = O, status = 200) => { const r = await call('GET', url, h); expect(r.statusCode, r.body).toBe(status); return r; };
const lines = (body: string) => body.replace(/^﻿/, '').trim().split('\r\n');

const rows = async (w: W, q = '') => (await ok(call('GET', u(w, `insights/cancellations?from=2026-10-01&to=2026-12-31${q}`), O))).rows as any[];

describe('cancellation reasons', () => {
  it('keeps a standard reason and who started it, and the report groups by them', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const a = await book(w, { arrival: '2026-11-10', departure: '2026-11-12' }); const b = await book(w, { arrival: '2026-11-10', departure: '2026-11-11' });
    const c = await book(w, { arrival: '2026-11-12', departure: '2026-11-13' }); const d = await book(w, { arrival: '2026-11-14', departure: '2026-11-15' });
    await ok(call('POST', u(w, `reservations/${a.id}/cancel`), O, { reason: 'Flight cancelled', code: 'TRAVEL_DISRUPTION' }));            // initiator follows the reason: the guest
    await ok(call('POST', u(w, `reservations/${b.id}/cancel`), O, { reason: 'We had no room', code: 'OVERBOOKED' }));                    // the property
    await ok(call('POST', u(w, `reservations/${c.id}/cancel`), O, { reason: 'OTA sent a cancellation', code: 'CHANNEL_CANCELLED', initiator: 'CHANNEL' }));
    await ok(call('POST', u(w, `reservations/${d.id}/cancel`), O, { reason: 'Old style, no code' }));
    await code(call('POST', u(w, `reservations/${d.id}/cancel`), O, { reason: 'x y z', code: 'NOT_A_REASON' }), 400, 'VALIDATION_FAILED');
    const list = await rows(w); const by = (conf: string) => list.find((x) => x.conf === conf);
    const conf = async (r: { id: string }) => (await adminDb.selectFrom('reservation').select('confirmation_no').where('id', '=', r.id).executeTakeFirstOrThrow()).confirmation_no;
    expect(by(await conf(a))).toMatchObject({ reason: 'Travel disrupted (flight, road, weather)', initiator: 'Guest', why: 'Flight cancelled' });
    expect(by(await conf(b))).toMatchObject({ reason: 'We could not honour it (overbooked)', initiator: 'Property' });
    expect(by(await conf(c))).toMatchObject({ reason: 'Cancelled by the booking channel', initiator: 'Booking channel' });
    expect(by(await conf(d))).toMatchObject({ reason: 'Not recorded', initiator: 'Not recorded' });
    const byInit = await rows(w, '&group=initiator'); expect(byInit.map((x) => [x.what, x.n]).sort()).toEqual([['Booking channel', 1], ['Guest', 1], ['Not recorded', 1], ['Property', 1]]);
    const byReason = await ok(call('GET', u(w, 'insights/cancellations?from=2026-10-01&to=2026-12-31&group=reason'), O)); expect(byReason.rows).toHaveLength(4); expect(byReason.rows.reduce((s: number, x: any) => s + x.n, 0)).toBe(4); expect(byReason.chart.series[0].key).toBe('n');
    // reinstating clears the reason with the cancellation
    await ok(call('POST', u(w, `reservations/${a.id}/reinstate`), O, { reason: 'Guest is coming after all' }));
    const aConf = await conf(a); expect((await rows(w)).find((x) => x.conf === aConf)).toBeUndefined();
    const line = (await adminDb.selectFrom('reservation_room').select(['cancel_code', 'cancel_initiator']).where('id', '=', a.line).executeTakeFirstOrThrow()); expect(line).toEqual({ cancel_code: null, cancel_initiator: null });
  });

  it('records who marked a no-show: the desk by hand, or the night audit on its own', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const hand = await book(w, { arrival: '2026-11-05', departure: '2026-11-06' }); const auto = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' });
    await ok(call('POST', u(w, `reservations/${hand.id}/no-show`), O, { reason: 'Phone off, no answer', code: 'UNREACHABLE' }));
    at('2026-11-05', '23:30'); await ok(audit(w));
    const list = await rows(w, '&view=noshow'); expect(list).toHaveLength(2);
    expect(list.map((x) => [x.reason, x.initiator]).sort()).toEqual([['Could not be reached', 'Guest'], ['Did not arrive', 'System']]);
  });
});
