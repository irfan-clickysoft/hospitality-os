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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'tmf'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@tmf.test`); await adminDb.updateTable('staff_user').set({ status: 'ACTIVE' }).where('id', '=', id).execute(); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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

const RULE = { early: [{ upToMinutes: 120, percent: 0 }, { upToMinutes: 360, percent: 50 }], late: [{ upToMinutes: 180, percent: 50 }] };
const fee = (w: W, b: { id: string; line: string }) => u(w, `reservations/${b.id}/rooms/${b.line}/timing-fee`);
const setRule = async (w: W, rule: unknown) => { const v = (await ok(call('GET', `/v1/properties/${w.pid}`, O))).version; return ok(call('PATCH', `/v1/properties/${w.pid}`, O, { timingFeeRule: rule, version: v })); };

describe('early check-in and late checkout fees', () => {
  it('charges or waives an early check-in fee before the guest is checked in, and records who decided', async () => {
    const w = await sunset(); await setBd(w, '2026-11-05'); await setRule(w, RULE); const fd = await staff(w, 'front_desk_agent');
    const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' });
    at('2026-11-05', '10:00');                                                               // 4 hours before the 14:00 standard time
    const info = await ok(call('GET', `${fee(w, b)}?kind=EARLY_CHECKIN`, fd.h));
    expect(info).toMatchObject({ applies: true, standardTime: '14:00', localTime: '10:00', minutes: 240, percent: 50, required: true, suggested: { amount: '6000.00' }, night: { amount: '12000.00' }, decided: null });
    await code(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-in`), O, { roomId: w.room['101'], occupants: [{ fullName: 'Guest', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671', nationality: 'PK' }] }), 422, 'TIMING_FEE_DECISION_REQUIRED');
    await code(call('POST', fee(w, b), fd.hm, { kind: 'EARLY_CHECKIN', action: 'WAIVE', reason: 'Regular guest' }), 403, 'PERMISSION_DENIED');            // waiving is a manager's call
    await code(call('POST', fee(w, b), fd.hm, { kind: 'EARLY_CHECKIN', action: 'CHARGE', amount: '2000', reason: 'Goodwill' }), 403, 'PERMISSION_DENIED');   // so is a different amount
    await code(call('POST', fee(w, b), fd.h, { kind: 'LATE_CHECKOUT', action: 'CHARGE' }), 409, 'NOT_APPLICABLE');
    const done = await ok(call('POST', fee(w, b), fd.h, { kind: 'EARLY_CHECKIN', action: 'CHARGE' })); expect(done.charged.amount).toBe('6000.00');
    await code(call('POST', fee(w, b), fd.h, { kind: 'EARLY_CHECKIN', action: 'CHARGE' }), 409, 'ALREADY_DECIDED');
    expect((await folioOf(w, b)).postings.find((x: any) => x.txnCode === 'MISC')).toMatchObject({ amount: { amount: '6000.00' }, description: expect.stringContaining('Early check-in fee (240 min early)') });
    await checkIn(w, b, '101');
    const rep = await ok(call('GET', u(w, 'insights/early-late?from=2026-11-05&to=2026-11-05'), O));
    expect(rep.rows[0]).toMatchObject({ kind: 'Early check-in', mins: 240, suggested: '600000', charged: '600000', waived: '0', status: 'Charged' }); expect(rep.kpis.find((k: any) => k.key === 'fees').value).toBe('6000.00');
    // within the free step (30 minutes early at 0%): nothing to decide
    const b2 = await book(w, { arrival: '2026-11-05', departure: '2026-11-06' }); at('2026-11-05', '13:30');
    expect((await ok(call('GET', `${fee(w, b2)}?kind=EARLY_CHECKIN`, fd.h))).required).toBe(false);
    await checkIn(w, b2, '102');
  });

  it('can be waived by a manager with a reason; a late checkout needs a decision before the guest leaves', async () => {
    const w = await sunset(); await setBd(w, '2026-11-05'); await setRule(w, RULE);
    at('2026-11-05', '15:00'); const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' }); await checkIn(w, b, '101');
    await setBd(w, '2026-11-07'); at('2026-11-07', '15:00');                                  // three hours after the 12:00 standard time
    const info = await ok(call('GET', `${fee(w, b)}?kind=LATE_CHECKOUT`, O)); expect(info).toMatchObject({ applies: true, minutes: 180, percent: 50, required: true });
    await code(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-out`), OM, { balanceReason: 'test' }), 422, 'TIMING_FEE_DECISION_REQUIRED');
    await code(call('POST', fee(w, b), OM, { kind: 'LATE_CHECKOUT', action: 'WAIVE' }), 422, 'REASON_REQUIRED');
    await ok(call('POST', fee(w, b), OM, { kind: 'LATE_CHECKOUT', action: 'WAIVE', reason: 'Flight delayed, guest asked politely' }));
    await checkOut(w, b);
    const rep = await ok(call('GET', u(w, 'insights/early-late?from=2026-11-07&to=2026-11-07'), O));
    expect(rep.rows.find((x: any) => x.kind === 'Late checkout')).toMatchObject({ status: 'Waived', waived: '600000', charged: '0', why: expect.stringContaining('Flight delayed') });
    expect((await adminDb.selectFrom('timing_fee_event').select('action').where('property_id', '=', w.pid).execute()).map((x) => x.action)).toEqual(['WAIVE']);
  });

  it('suggests nothing when no steps are set, and never asks a same-day walk-in', async () => {
    const w = await sunset(); await setBd(w, '2026-11-05'); at('2026-11-05', '08:00');
    const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-06' });
    expect(await ok(call('GET', `${fee(w, b)}?kind=EARLY_CHECKIN`, O))).toMatchObject({ applies: true, percent: 0, required: false, suggested: { amount: '0.00' } });
    await checkIn(w, b, '101');                                                               // no steps set: no fee asked
    await setRule(w, RULE);
    const r = await call('POST', u(w, 'front-desk/walk-ins'), O, { guest: { fullName: 'Morning Walk', phone: '03137770001', nationality: 'PK' }, roomTypeId: w.rt, nights: 1, adults: 1, children: 0, occupants: [{ fullName: 'Morning Walk', isPrimary: true, idType: 'CNIC', idNumber: '3520212345999', nationality: 'PK' }] }, { 'idempotency-key': `tm-${Date.now()}` });
    expect(r.statusCode, r.body).toBe(201);
    const bad = await call('PATCH', `/v1/properties/${w.pid}`, O, { timingFeeRule: { early: [{ upToMinutes: 0, percent: 10 }], late: [] }, version: (await ok(call('GET', `/v1/properties/${w.pid}`, O))).version }); expect(bad.statusCode).toBe(400);
  });
});
