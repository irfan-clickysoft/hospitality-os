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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'safe'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@safe.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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


const SAFE = (w: W, tail = '') => u(w, `cash-safe${tail}`);
const cashPay = (w: W, b: { id: string }, h: Record<string, string>, amount: string) => call('POST', u(w, `reservations/${b.id}/payments`), h, { method: 'CASH', amount, kind: 'DEPOSIT' }, key());
/** One register's day: open with a float, take cash, drop some in the safe, close with a count. */
async function registerDay(w: W, h: Record<string, string>, b: { id: string }, o: { register: string; float: string; cash: string; drop?: string; counted: string }) {
  const s = await ok(call('POST', u(w, 'cashier/sessions'), h, { openingFloat: o.float, registerName: o.register }), 201);
  await ok(cashPay(w, b, h, o.cash), 201);
  if (o.drop) await ok(call('POST', u(w, `cashier/sessions/${s.id}/drops`), h, { amount: o.drop }), 201);
  await ok(call('POST', u(w, `cashier/sessions/${s.id}/close`), h, { counted: o.counted }));
  return s.id as string;
}

describe('the cash safe and the weekly handover to head office', () => {
  it('closed registers feed the safe as daily envelopes; a handover takes cash out, records who received it and any difference, and cannot exceed or misstate the safe', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const clerk1 = await staff(w, 'cashier'); const clerk2 = await staff(w, 'cashier'); const gm = await staff(w, 'property_admin'); const desk = await staff(w, 'front_desk_agent');
    const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' });
    expect((await ok(call('GET', SAFE(w), O))).balance.amount).toBe('0.00');
    await registerDay(w, clerk1.h, b, { register: 'Register 1', float: '5000', cash: '20000', drop: '8000', counted: '17000' });      // drawer should hold 5,000 + 20,000 − 8,000 = 17,000; envelope = 17,000 − 5,000 + 8,000 = 20,000
    await registerDay(w, clerk2.h, b, { register: 'Register 2', float: '5000', cash: '10000', counted: '14900' });                      // 100 short: envelope 9,900
    const safe = await ok(call('GET', SAFE(w), O));
    expect(safe.balance.amount).toBe('29900.00');
    expect(safe.envelopes.map((e: any) => [e.register, e.amount.amount, e.variance.amount])).toEqual([['Register 1', '20000.00', '0.00'], ['Register 2', '9900.00', '-100.00']]);
    await code(call('GET', SAFE(w), desk.h), 403, 'PERMISSION_DENIED');
    const hand = (amount: string, extra: Record<string, unknown> = {}, h = OM) => call('POST', SAFE(w, '/handovers'), h, { amount, receivedByName: 'M Hamza', receivedByTitle: 'CFO', safeBefore: '29900', ...extra });
    await code(hand('29900', {}, O), 403, 'MFA_REQUIRED');                                                           // needs a fresh second factor
    await code(hand('29900', {}, desk.hm), 403, 'PERMISSION_DENIED');
    await code(hand('29900', { safeBefore: '30000' }), 409, 'SAFE_CHANGED');                                        // the screen was out of date
    await code(hand('50000'), 422, 'HANDOVER_EXCEEDS_SAFE');
    await code(hand('20000'), 422, 'NOTE_REQUIRED');                                                                // less than the whole safe needs a reason
    await code(hand('29900', { receivedByName: 'x' }), 400, 'VALIDATION_FAILED');
    const part = await ok(hand('20000', { note: 'Rest kept for a supplier payment' }), 201);
    expect(part.balance.amount).toBe('9900.00');
    const done = await ok(call('POST', SAFE(w, '/handovers'), as(T.tenantId, gm.id, { mfa: true }), { amount: '9900', receivedByName: 'M Hamza', safeBefore: '9900' }), 201);
    expect(done.balance.amount).toBe('0.00');
    const after = await ok(call('GET', SAFE(w), O));
    expect(after.handedOver.amount).toBe('29900.00');
    expect(after.handovers.map((x: any) => [x.amount.amount, x.difference.amount, x.receivedBy])).toEqual([['9900.00', '0.00', 'M Hamza'], ['20000.00', '-9900.00', 'M Hamza']]);
    // handovers are for good: the table refuses edits
    await expect(adminDb.updateTable('cash_handover').set({ amount_minor: '1' }).where('id', '=', part.id).execute()).rejects.toThrow();
  });
});
