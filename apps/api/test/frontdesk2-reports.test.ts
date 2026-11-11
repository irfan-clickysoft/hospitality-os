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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'fd2'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@fd2.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };


async function book(w: W, o: { arrival: string; departure: string; source?: string; rooms?: number }) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival, departure: o.departure, adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(1000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const lines = Array.from({ length: o.rooms ?? 1 }, () => ({ quoteToken: q.options[0].quoteToken }));
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: o.source ?? 'PHONE', lines }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string };
}
const checkIn = (w: W, b: { id: string; line: string }, room: string) => ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-in`), O, { roomId: w.room[room], occupants: [{ fullName: 'Guest', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671', nationality: 'PK' }] }));
describe('more front desk reports', () => {
  it('in house, checkouts, walk-ins, unassigned, overbooking, guarantees, rooming, ID', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const a = await book(w, { arrival: '2026-11-05', departure: '2026-11-07', source: 'WALK_IN' }); await checkIn(w, a, '101');
    const c = await book(w, { arrival: '2026-11-05', departure: '2026-11-06' }); await checkIn(w, c, '102');
    const grp = await book(w, { arrival: '2026-11-08', departure: '2026-11-09', rooms: 2 });
    const ih = await ok(call('GET', u(w, 'insights/in-house'), O)); expect(ih.rows).toHaveLength(2); expect(ih.rows.map((x: any) => x.room).sort()).toEqual(['101', '102']);
    at('2026-11-06', '09:00'); await setBd(w, '2026-11-06');          // the next day: the one-night guest is due out
    const due = await ok(call('GET', u(w, 'insights/in-house?view=dueout'), O)); expect(due.rows).toHaveLength(1); expect(due.rows[0].room).toBe('102');
    await ok(call('POST', u(w, `reservations/${c.id}/rooms/${c.line}/check-out`), OM, { balanceReason: 'test: settled elsewhere' }));
    const co = await ok(call('GET', u(w, 'insights/checkouts?from=2026-11-06&to=2026-11-06'), O)); expect(co.rows).toHaveLength(1); expect(co.rows[0]).toMatchObject({ room: '102', how: 'On the day' });
    const wi = await ok(call('GET', u(w, 'insights/walk-ins?from=2026-11-01&to=2027-06-30'), O)); expect(wi.rows).toHaveLength(1); expect(wi.rows[0].room).toBe('101');
    const un = await ok(call('GET', u(w, 'insights/unassigned-rooms?from=2026-11-05&to=2026-11-30'), O)); expect(un.rows).toHaveLength(2); expect(un.rows[0].days).toBe(2);
    const ob = await ok(call('GET', u(w, 'insights/overbooking-risk?from=2026-11-05&to=2026-11-10&view=all'), O)); expect(ob.rows.length).toBeGreaterThan(0); expect(ob.rows.find((x: any) => x.d === '2026-11-08')).toMatchObject({ used: 2, left: 2 });
    const mg = await ok(call('GET', u(w, 'insights/missing-guarantees?from=2026-11-05&to=2026-11-30'), O)); expect(mg.rows.some((x: any) => x.conf)).toBe(true);
    const rl = await ok(call('GET', u(w, 'insights/rooming-list?from=2026-11-05&to=2026-11-30'), O)); expect(rl.rows).toHaveLength(2); expect(grp.id).toBeTruthy(); expect(rl.rows.map((x: any) => x.line)).toEqual([1, 2]);
    const id = await ok(call('GET', u(w, 'insights/id-compliance?view=all'), O)); expect(id.rows.length).toBeGreaterThan(0); expect(id.rows[0]).toMatchObject({ who: 'Main guest', idt: 'CNIC' });
    const pr = await ok(call('GET', u(w, 'insights/id-compliance'), O)); expect(pr.rows.every((x: any) => x.issue !== 'OK')).toBe(true);
  });
});
