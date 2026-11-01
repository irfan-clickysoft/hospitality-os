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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'dsc'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string, limits?: object) => { const id = await addUser(T.tenantId, `${role}${++n}@dsc.test`); await adminDb.updateTable('staff_user').set({ status: 'ACTIVE' }).where('id', '=', id).execute(); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid, limits ? { limits } : {}); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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

const Q = { arrival: '2026-11-05', departure: '2026-11-07', adults: 2, channel: 'PHONE' };
const quote = (w: W, body: Record<string, unknown>, h = O) => call('POST', u(w, 'quotes'), h, { ...Q, ...body });
const optionOf = async (w: W, body: Record<string, unknown>, h = O) => (await ok(quote(w, body, h))).options[0];
const reserve = (w: W, token: string, extra: Record<string, unknown> = {}, h = O) => call('POST', u(w, 'reservations'), h, { guestId: undefined, guest: { fullName: `Guest ${++n}`, phone: `0300${String(7000000 + n).slice(-7)}`, nationality: 'PK' }, source: 'PHONE', lines: [{ quoteToken: token }], ...extra }, key());
const ask = (w: W, o: { pct: number }, opt: any, h: Record<string, string>, extra: Record<string, unknown> = {}) => call('POST', u(w, 'discount-approvals'), h, { quote: { ...Q, roomTypeId: opt.roomType.id, discountPct: o.pct }, roomTypeId: opt.roomType.id, planId: opt.plan.id, rooms: 1, reason: { code: 'LOYALTY', note: 'Stays every month' }, ...extra });

describe('discount reasons', () => {
  it('asks why a discount is given, keeps the answer with who gave it, and shows it in the report', async () => {
    const w = await sunset(); await setBd(w, '2026-11-05'); at('2026-11-05', '10:00');
    const opt = await optionOf(w, { discountPct: 5 });
    await code(reserve(w, opt.quoteToken), 422, 'DISCOUNT_REASON_REQUIRED');
    await code(reserve(w, opt.quoteToken, { discountReason: { code: 'NOT_A_REASON' } }), 400, 'VALIDATION_FAILED');
    const r = await ok(reserve(w, opt.quoteToken, { discountReason: { code: 'PROMOTION', note: 'November offer' } }), 201);
    const line = await adminDb.selectFrom('reservation_room').select(['discount_code', 'discount_note', 'discount_given_by', 'discount_approved_by']).where('id', '=', r.lines[0].id).executeTakeFirstOrThrow();
    expect(line).toMatchObject({ discount_code: 'PROMOTION', discount_note: 'November offer', discount_given_by: T.ownerUserId, discount_approved_by: null });
    const full = await optionOf(w, {}); const plain = await ok(reserve(w, full.quoteToken), 201); expect(plain.id).toBeTruthy();       // no discount, no reason needed
    const rep = await ok(call('GET', u(w, 'insights/discounts?from=2026-11-01&to=2026-11-30'), O));
    expect(rep.rows).toHaveLength(1); expect(rep.rows[0]).toMatchObject({ kind: 'Booking discount', category: 'Promotional', code: 'Promotion or offer', reason: 'November offer' });
    const byCat = await ok(call('GET', u(w, 'insights/discounts?from=2026-11-01&to=2026-11-30&group=category'), O)); expect(byCat.rows[0]).toMatchObject({ what: 'Promotional', n: 1 });
  });
});

describe('discount approvals', () => {
  it('sends a discount above the desk limit to a manager, who approves it once, for exactly that price', async () => {
    const w = await sunset(); await setBd(w, '2026-11-05'); at('2026-11-05', '10:00');
    const desk = await staff(w, 'front_desk_agent', { maxDiscountPct: 10 }); const other = await staff(w, 'front_desk_agent', { maxDiscountPct: 10 }); const mgr = await staff(w, 'general_manager');
    const big = await optionOf(w, { discountPct: 15 }, desk.h); expect(big.bookable).toBe(false); expect(big.quoteToken).toBeNull();
    await code(ask(w, { pct: 5 }, big, desk.h), 409, 'APPROVAL_NOT_NEEDED');                                       // within the limit: nothing to approve
    const req = await ok(ask(w, { pct: 15 }, big, desk.h), 201); expect(req.status).toBe('PENDING');
    expect((await ok(ask(w, { pct: 15 }, big, desk.h), 201)).id).toBe(req.id);                                         // asking twice does not double the queue
    const mine = await ok(call('GET', u(w, 'discount-approvals'), desk.h)); expect(mine.approver).toBe(false); expect(mine.items[0]).toMatchObject({ id: req.id, status: 'PENDING', pct: 15, codeLabel: 'Loyal or repeat guest' });
    expect((await ok(call('GET', u(w, 'discount-approvals'), other.h))).items).toHaveLength(0);                    // others do not see it
    await code(call('POST', u(w, `discount-approvals/${req.id}/approve`), desk.hm, {}), 403, 'PERMISSION_DENIED');   // a desk agent cannot approve
    const queue = await ok(call('GET', u(w, 'discount-approvals?status=PENDING'), mgr.hm)); expect(queue.approver).toBe(true); expect(queue.items).toHaveLength(1);
    await ok(call('POST', u(w, `discount-approvals/${req.id}/approve`), mgr.hm, { note: 'Good regular' }));
    await code(call('POST', u(w, `discount-approvals/${req.id}/approve`), mgr.hm, {}), 409, 'ALREADY_DECIDED');
    // quoting with the approval makes the discount bookable, but only for the same request and only for its owner
    const ok1 = await optionOf(w, { discountPct: 15, approvalId: req.id }, desk.h); expect(ok1.bookable).toBe(true);
    await code(quote(w, { discountPct: 15, approvalId: req.id, departure: '2026-11-08' }, desk.h), 422, 'APPROVAL_MISMATCH');
    await code(quote(w, { discountPct: 12, approvalId: req.id }, desk.h), 422, 'APPROVAL_MISMATCH');
    await code(quote(w, { discountPct: 15, approvalId: req.id }, other.h), 422, 'APPROVAL_INVALID');
    const booked = await ok(reserve(w, ok1.quoteToken, {}, desk.h), 201);                                         // the approval brings its own reason
    const line = await adminDb.selectFrom('reservation_room').select(['discount_code', 'discount_note', 'discount_given_by', 'discount_approved_by', 'discount_approval_id']).where('id', '=', booked.lines[0].id).executeTakeFirstOrThrow();
    expect(line).toMatchObject({ discount_code: 'LOYALTY', discount_note: 'Stays every month', discount_given_by: desk.id, discount_approved_by: mgr.id, discount_approval_id: req.id });
    await code(quote(w, { discountPct: 15, approvalId: req.id }, desk.h), 422, 'APPROVAL_INVALID');               // used up: one room, one booking
    const rep = await ok(call('GET', u(w, 'insights/discounts?from=2026-11-01&to=2026-11-30'), O)); expect(rep.rows[0]).toMatchObject({ approver: expect.stringContaining('general_manager'), by: expect.stringContaining('front_desk_agent'), code: 'Loyal or repeat guest' });
    expect((await adminDb.selectFrom('audit_log').select('action').where('resource_id', '=', req.id).execute()).map((x) => x.action)).toEqual(expect.arrayContaining(['discount.request', 'discount.approve']));
  });

  it('can be rejected with a note, withdrawn, and never approved by the person who asked', async () => {
    const w = await sunset(); await setBd(w, '2026-11-05'); at('2026-11-05', '10:00');
    const desk = await staff(w, 'front_desk_agent', { maxDiscountPct: 10 }); const mgr = await staff(w, 'general_manager');
    const big = await optionOf(w, { discountPct: 20 }, desk.h); const req = await ok(ask(w, { pct: 20 }, big, desk.h), 201);
    await code(call('POST', u(w, `discount-approvals/${req.id}/reject`), mgr.hm, {}), 400, 'VALIDATION_FAILED');       // a rejection needs its reason
    await ok(call('POST', u(w, `discount-approvals/${req.id}/reject`), mgr.hm, { note: 'Too deep for this date' }));
    expect((await ok(call('GET', u(w, 'discount-approvals'), desk.h))).items[0]).toMatchObject({ status: 'REJECTED', decisionNote: 'Too deep for this date' });
    await code(quote(w, { discountPct: 20, approvalId: req.id }, desk.h), 422, 'APPROVAL_INVALID');
    const again = await ok(ask(w, { pct: 20 }, big, desk.h), 201); expect(again.id).not.toBe(req.id);
    await ok(call('POST', u(w, `discount-approvals/${again.id}/withdraw`), desk.h)); expect((await ok(call('GET', u(w, 'discount-approvals'), desk.h))).items[0].status).toBe('CANCELLED');
    // a manager asking for a discount above their own limit cannot approve it themselves
    const lowMgr = await staff(w, 'general_manager', { maxDiscountPct: 10 }); const q3 = await optionOf(w, { discountPct: 30 }, lowMgr.h); const mine = await ok(ask(w, { pct: 30 }, q3, lowMgr.h), 201);
    await code(call('POST', u(w, `discount-approvals/${mine.id}/approve`), lowMgr.hm, {}), 403, 'SELF_APPROVAL');
  });
});
