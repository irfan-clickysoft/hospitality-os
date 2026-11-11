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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'fbk'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@fbk.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };


async function book(w: W) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: '2026-11-05', departure: '2026-11-06', adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(1700000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string };
}
describe('guest feedback', () => {
  it('is asked for after check-out on the guest page, once, and reported', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const b = await book(w);
    const token = (await call('GET', u(w, `reservations/${b.id}/guest-link`), O)).json().token as string; const url = `/v1/guest/booking/${token}`;
    await ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-in`), O, { roomId: w.room['101'], occupants: [{ fullName: 'Guest', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671', nationality: 'PK' }] }));
    expect((await call('GET', url, {})).json().feedback).toMatchObject({ canGive: false, given: false });
    await code(call('POST', `${url}/feedback`, {}, { overall: 4 }), 409, 'FEEDBACK_NOT_YET');
    at('2026-11-06', '09:00'); await setBd(w, '2026-11-06'); await ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-out`), OM, { balanceReason: 'test: settled elsewhere' }));
    expect((await call('GET', url, {})).json().feedback).toMatchObject({ canGive: true, given: false });
    await code(call('POST', `${url}/feedback`, {}, { overall: 6 }), 400, 'VALIDATION_FAILED'); await code(call('POST', `${url}/feedback`, {}, {}), 400, 'VALIDATION_FAILED');
    await ok(call('POST', `${url}/feedback`, {}, { overall: 2, cleanliness: 2, staff: 5, wouldRecommend: false, comment: 'Room was noisy at night' }), 201);
    await code(call('POST', `${url}/feedback`, {}, { overall: 5 }), 409, 'ALREADY_GIVEN');
    expect((await call('GET', url, {})).json().feedback).toMatchObject({ given: true });
    const l = await ok(call('GET', u(w, 'insights/guest-feedback?from=2026-11-01&to=2027-06-30'), O)); expect(l.rows).toHaveLength(1); expect(l.rows[0]).toMatchObject({ overall: 2, cl: 2, st: 5, rec: 'No', comment: 'Room was noisy at night', room: '101' });
    expect(l.kpis.find((k: any) => k.key === 'low').value).toBe(1); expect(l.kpis.find((k: any) => k.key === 'rate').value).toBe(100);
    const lo = await ok(call('GET', u(w, 'insights/guest-feedback?from=2026-11-01&to=2027-06-30&group=low'), O)); expect(lo.rows).toHaveLength(1);
    const ty = await ok(call('GET', u(w, 'insights/guest-feedback?from=2026-11-01&to=2027-06-30&group=type'), O)); expect(ty.rows[0]).toMatchObject({ what: 'Standard', n: 1, overall: '2' });
  });
});
