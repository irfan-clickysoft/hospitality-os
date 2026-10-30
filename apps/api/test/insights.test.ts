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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'rep'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@rep.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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

describe('Reporting Center', () => {
  it('lists reports by permission, runs each one with the standard header, and exports what is on screen', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' });
    await checkIn(w, b, '101');
    await ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/move`), O, { roomId: w.room['102'], reason: 'Noisy AC' }));
    const c = await book(w, { arrival: '2026-11-08', departure: '2026-11-09' });
    await ok(call('POST', u(w, `reservations/${c.id}/cancel`), O, { reason: 'Guest changed plans' }));
    const sess = await ok(call('POST', u(w, 'cashier/sessions'), O, { openingFloat: '1000' }), 201);
    await ok(call('POST', u(w, `reservations/${b.id}/payments`), O, { method: 'CASH', amount: '5000' }, key()), 201);
    await ok(call('POST', u(w, `cashier/sessions/${sess.id}/close`), O, { counted: '5800' }));
    at('2026-11-05', '23:30'); await ok(audit(w));

    const cat = await ok(call('GET', u(w, 'insights'), O));
    const ids = cat.items.map((x: any) => x.id); expect(ids).toEqual(expect.arrayContaining(['flash', 'checkins', 'room-moves', 'cancellations', 'cashier', 'outstanding', 'room-status', 'historical', 'future-bookings', 'night-audit', 'lost-found', 'rate-changes', 'discounts', 'early-late', 'expected-arrivals', 'room-reassignments']));
    expect(cat.planned).toEqual([]); expect(ids).toEqual(expect.arrayContaining(['damage-charges', 'complaints-incidents']));
    for (const id of ids) {
      const e = await ok(call('GET', u(w, `insights/${id}?from=2026-11-01&to=2026-11-30`), O));
      expect(e.meta, id).toMatchObject({ id, timezone: 'Asia/Karachi', currency: 'PKR', property: { id: w.pid } }); expect(e.meta.asOf).toBeTruthy(); expect(e.meta.dateBasis.label).toBeTruthy(); expect(Array.isArray(e.rows) && Array.isArray(e.columns) && Array.isArray(e.kpis), id).toBe(true);
      const x = await call('GET', u(w, `insights/${id}?from=2026-11-01&to=2026-11-30&format=csv`), O); expect(x.statusCode, `${id}: ${x.body}`).toBe(200); expect(x.headers['content-type']).toContain('text/csv'); expect(x.body).toContain('Date basis:'); expect(x.body).toContain('Data as of:');
    }
    const ci = await ok(call('GET', u(w, 'insights/checkins?from=2026-11-05&to=2026-11-05'), O));
    expect(ci.rows).toHaveLength(1); expect(ci.rows[0]).toMatchObject({ room: '102', registration: 'ID recorded' });
    const mv = await ok(call('GET', u(w, 'insights/room-moves?from=2026-10-01&to=2026-12-31'), O));
    expect(mv.rows).toHaveLength(1); expect(mv.rows[0]).toMatchObject({ from: '101', to: '102', reason: 'Noisy AC' });
    const cn = await ok(call('GET', u(w, 'insights/cancellations?from=2026-10-01&to=2026-12-31&view=noshow'), O)); expect(cn.rows).toHaveLength(0);
    const cn2 = await ok(call('GET', u(w, 'insights/cancellations?from=2026-10-01&to=2026-12-31'), O)); expect(cn2.rows).toHaveLength(1); expect(cn2.rows[0]).toMatchObject({ type: 'Cancelled', why: 'Guest changed plans' });
    const ca = await ok(call('GET', u(w, 'insights/cashier?from=2026-11-05&to=2026-11-05'), O));
    expect(ca.rows[0]).toMatchObject({ status: 'Closed', float: '100000', cashIn: '500000', expected: '600000', counted: '580000', variance: '-20000' });
    const hi = await ok(call('GET', u(w, 'insights/historical?from=2026-11-05&to=2026-11-05'), O)); expect(hi.rows[0]).toMatchObject({ period: '2026-11-05', sold: 1, avail: 4, occ: 25 });
    const csvOut = (await call('GET', u(w, 'insights/cashier?from=2026-11-05&to=2026-11-05&format=csv'), O)).body; expect(csvOut).toContain('Expected closing cash'); expect(csvOut).toContain('6000.00');
    const trail = await adminDb.selectFrom('audit_log').select('action').where('action', '=', 'report.export').execute(); expect(trail.length).toBeGreaterThan(5);
  });

  it('keeps reports away from people without the permission, and limits the period', async () => {
    const w = await sunset(); const ro = await staff(w, 'read_only'); const nobody = as(T.tenantId, await addUser(T.tenantId, `nobody${++n}@rep.test`));
    expect((await ok(call('GET', u(w, 'insights'), nobody))).items).toHaveLength(0);
    await code(call('GET', u(w, 'insights/cashier'), nobody), 403, 'PERMISSION_DENIED');
    await code(call('GET', u(w, 'insights/nope'), O), 404, 'NOT_FOUND');
    await code(call('GET', u(w, 'insights/historical?from=2024-01-01&to=2026-11-01'), O), 400, 'RANGE_TOO_LONG');
    await code(call('GET', u(w, 'insights/historical?from=2026-11-05&to=2026-11-01'), O), 400, 'VALIDATION_FAILED');
    expect(ro.id).toBeTruthy();
  });
});
