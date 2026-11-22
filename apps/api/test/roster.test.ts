import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { zonedToUtcMs } from '@hos/domain-types';
import { addUser, adminDb, as, assignRole, createTestApp, provision, testClock } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
let O: Record<string, string>;
const OPEN = '2026-11-01';
let n = 0;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...headers, ...extra }, payload: body as object | undefined });
const ok = async (r: Promise<any>, status = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json(); };
const code = async (r: Promise<any>, status: number, c: string) => { const x = await r; expect(x.statusCode, x.body).toBe(status); expect(x.json().code).toBe(c); return x.json(); };
const key = () => ({ 'idempotency-key': `rs-${++n}-${Date.now()}` });
const at = (date: string, time: string) => testClock.set(zonedToUtcMs(date, time, 'Asia/Karachi'));

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'ros'); O = as(T.tenantId, T.ownerUserId); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

async function sunset() {
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `RS${++n}`, name: `Comm ${n}` })).json().id as string;
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'STD', name: 'Standard', maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id as string;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, from: 101, to: 104 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'BAR', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '12000', extraAdult: '3000', extraChild: '1500' }] });
  return { pid };
}
const book = async (pid: string, source: string, arrival: string, departure: string) => {
  const q = (await call('POST', `/v1/properties/${pid}/quotes`, O, { arrival, departure, adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(9300000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  await ok(call('POST', `/v1/properties/${pid}/reservations`, O, { guestId: g.id, source, lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
};

describe('roster and staffing forecast', () => {
  it('a manager rosters people and sets standards; the report shows who is short', async () => {
    const { pid } = await sunset(); at('2026-11-01', '10:00');
    await book(pid, 'PHONE', '2026-11-03', '2026-11-04'); await book(pid, 'PHONE', '2026-11-03', '2026-11-04'); await book(pid, 'PHONE', '2026-11-03', '2026-11-04');   // 3 rooms on the 3rd
    const fdId = await addUser(T.tenantId, `fd${++n}@ros.test`); await assignRole(T.tenantId, fdId, 'front_desk_agent', 'PROPERTY', pid); const fd = as(T.tenantId, fdId);
    const u = (t: string) => `/v1/properties/${pid}/${t}`;
    await code(call('POST', u('roster/shifts'), fd, { userId: fdId, date: '2026-11-03', department: 'HOUSEKEEPING', start: '08:00', end: '16:00' }), 403, 'PERMISSION_DENIED');
    await code(call('POST', u('roster/shifts'), O, { userId: fdId, date: '2026-11-03', department: 'KITCHEN', start: '08:00', end: '16:00' }), 400, 'VALIDATION_FAILED');
    await code(call('POST', u('roster/shifts'), O, { userId: fdId, date: '2026-11-03', department: 'HOUSEKEEPING', start: '8am', end: '16:00' }), 400, 'VALIDATION_FAILED');
    await code(call('PUT', u('roster/rules/HOUSEKEEPING'), O, { roomsPerStaff: 0, minStaff: 1 }), 400, 'VALIDATION_FAILED');
    const w0 = await ok(call('GET', u('roster?from=2026-11-02&to=2026-11-08'), O)); expect(w0.shifts).toHaveLength(0); expect(w0.rules.find((r: any) => r.department === 'HOUSEKEEPING').roomsPerStaff).toBeNull(); expect(w0.staff.some((s: any) => s.id === fdId)).toBe(true);
    const none = await ok(call('GET', u('insights/staffing-forecast?from=2026-11-03&to=2026-11-05'), O)); expect(none.warnings[0]).toContain('No staffing standards');
    await ok(call('PUT', u('roster/rules/HOUSEKEEPING'), O, { roomsPerStaff: 2, minStaff: 1 }));      // 3 rooms → 2 people
    const s1 = await ok(call('POST', u('roster/shifts'), O, { userId: fdId, date: '2026-11-03', department: 'HOUSEKEEPING', start: '08:00', end: '16:00' }), 201);
    await code(call('POST', u('roster/shifts'), O, { userId: fdId, date: '2026-11-03', department: 'HOUSEKEEPING', start: '08:00', end: '14:00' }), 409, 'SHIFT_EXISTS');
    const w = await ok(call('GET', u('roster?from=2026-11-02&to=2026-11-08'), fd)); expect(w.shifts).toEqual([expect.objectContaining({ id: s1.id, userId: fdId, date: '2026-11-03', department: 'HOUSEKEEPING', start: '08:00', end: '16:00' })]);
    expect(w.rules.find((r: any) => r.department === 'HOUSEKEEPING')).toMatchObject({ roomsPerStaff: 2, minStaff: 1 });
    const r = await ok(call('GET', u('insights/staffing-forecast?from=2026-11-03&to=2026-11-04&group=day'), O));
    expect(r.rows[0]).toMatchObject({ d: '2026-11-03', rooms: 3, src: 'On the books', HOUSEKEEPING: -1, short: 1 }); expect(r.rows[1]).toMatchObject({ d: '2026-11-04', rooms: 0, HOUSEKEEPING: -1 });   // minimum of 1 and nobody rostered
    const d = await ok(call('GET', u('insights/staffing-forecast?from=2026-11-03&to=2026-11-03'), O)); expect(d.rows[0]).toMatchObject({ what: 'Housekeeping', need: 2, have: 1, shortDays: 1, shortPeople: 1 });
    const other = await addUser(T.tenantId, `hk${++n}@ros.test`);
    await ok(call('POST', u('roster/shifts'), O, { userId: other, date: '2026-11-03', department: 'HOUSEKEEPING', start: '08:00', end: '16:00' }), 201);
    const fixed = await ok(call('GET', u('insights/staffing-forecast?from=2026-11-03&to=2026-11-03'), O)); expect(fixed.rows[0]).toMatchObject({ have: 2, shortDays: 0 });
    await ok(call('DELETE', u(`roster/shifts/${s1.id}`), O)); await code(call('DELETE', u(`roster/shifts/${s1.id}`), O), 404, 'NOT_FOUND');
    expect((await ok(call('GET', u('roster?from=2026-11-02&to=2026-11-08'), O))).shifts).toHaveLength(1);
    await code(call('GET', u('roster?from=2026-11-01&to=2027-03-01'), O), 400, 'VALIDATION_FAILED');
  });
});
