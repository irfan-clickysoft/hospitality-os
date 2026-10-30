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

describe('damage cases', () => {
  it('runs from a suspected report to a charge on the guest bill, with the rules a front desk cannot skip', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' }); await checkIn(w, b, '101');
    const hk = await staff(w, 'housekeeper'); const fd = await staff(w, 'front_desk_agent');
    const made = await ok(call('POST', u(w, 'damage'), hk.h, { reservationId: b.id, area: 'Bedside lamp', category: 'FIXTURE', severity: 'MINOR', description: 'Lamp shade torn and base cracked', estimatedCost: '2500' }), 201);
    expect(made.ref).toMatch(/^DMG-/);
    await code(call('GET', u(w, 'damage'), hk.h), 403, 'PERMISSION_DENIED');                                     // a housekeeper can report but not browse the register
    const d = await ok(call('GET', u(w, `damage/${made.id}`), fd.h)); expect(d).toMatchObject({ status: 'SUSPECTED', room: '101', area: 'Bedside lamp', estimated: { amount: '2500.00' }, canCharge: false });
    await code(call('POST', u(w, `damage/${made.id}/approve-charge`), fd.hm, { amount: '2500' }), 403, 'PERMISSION_DENIED');   // the front desk may verify, not charge
    await code(call('POST', u(w, `damage/${made.id}/approve-charge`), OM, { amount: '2500' }), 409, 'INVALID_STATE');          // still only suspected
    await ok(call('POST', u(w, `damage/${made.id}/verify`), fd.h, { note: 'Seen in room', actualCost: '3000' }));
    await code(call('POST', u(w, `damage/${made.id}/approve-charge`), OM, { amount: '3000' }), 409, 'GUEST_NOT_NOTIFIED');
    await code(call('POST', u(w, `damage/${made.id}/guest-response`), fd.h, { response: 'ACKNOWLEDGED' }), 409, 'GUEST_NOT_NOTIFIED');
    await ok(call('POST', u(w, `damage/${made.id}/notify-guest`), fd.h)); await ok(call('POST', u(w, `damage/${made.id}/guest-response`), fd.h, { response: 'ACKNOWLEDGED', note: 'Guest agreed at the desk' }));
    await ok(call('POST', u(w, `damage/${made.id}/approve-charge`), OM, { amount: '3000', reason: 'Replacement lamp' }));
    const ch = await ok(call('POST', u(w, `damage/${made.id}/charge`), OM)); expect(ch.charged.amount).toBe('3000.00');
    const after = await folioOf(w, b); expect(after.postings.some((x: any) => x.txnCode === 'MISC' && x.description.includes('Bedside lamp'))).toBe(true);
    expect(after.postings.find((x: any) => x.txnCode === 'MISC').amount.amount).toBe('3000.00');
    await code(call('POST', u(w, `damage/${made.id}/charge`), OM), 409, 'INVALID_STATE');
    await code(call('POST', u(w, `damage/${made.id}/waive`), OM, { reason: 'Changed our mind' }), 409, 'INVALID_STATE');          // a posted charge is reversed on the bill, not waived here
    await ok(call('POST', u(w, `damage/${made.id}/resolve`), fd.h, { note: 'Charged and paid with the bill' }));
    const done = await ok(call('GET', u(w, `damage/${made.id}`), O)); expect(done.status).toBe('RESOLVED');
    expect(done.events.map((e: any) => e.action)).toEqual(['REPORTED', 'VERIFIED', 'GUEST_NOTIFIED', 'GUEST_ACKNOWLEDGED', 'CHARGE_APPROVED', 'CHARGED', 'RESOLVED']);
    await code(call('PATCH', u(w, `damage/${made.id}`), fd.h, { description: 'rewritten' }), 409, 'CASE_CLOSED');
    const list = await ok(call('GET', u(w, 'damage?status=RESOLVED'), fd.h)); expect(list.items).toHaveLength(1);
    const trail = await adminDb.selectFrom('audit_log').select('action').where('resource_id', '=', made.id).execute(); expect(trail.map((x) => x.action)).toEqual(expect.arrayContaining(['damage.report', 'damage.verified', 'damage.charged']));
  });

  it('can be waived or dismissed instead, and needs a booking to be charged', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05'); const fd = await staff(w, 'front_desk_agent');
    const noRes = await ok(call('POST', u(w, 'damage'), fd.h, { roomId: w.room['102'], area: 'Curtain', category: 'LINEN', severity: 'MINOR', description: 'Curtain ripped, found at turnover' }), 201);
    await ok(call('POST', u(w, `damage/${noRes.id}/verify`), fd.h, {})); await ok(call('POST', u(w, `damage/${noRes.id}/notify-guest`), fd.h));
    await code(call('POST', u(w, `damage/${noRes.id}/approve-charge`), OM, { amount: '1000' }), 409, 'NO_BOOKING');
    await ok(call('POST', u(w, `damage/${noRes.id}/waive`), OM, { reason: 'Wear and tear' })); expect((await ok(call('GET', u(w, `damage/${noRes.id}`), O))).status).toBe('WAIVED');
    const x = await ok(call('POST', u(w, 'damage'), fd.h, { roomId: w.room['103'], area: 'Mirror', category: 'FIXTURE', severity: 'MINOR', description: 'Looked cracked' }), 201);
    await ok(call('POST', u(w, `damage/${x.id}/dismiss`), fd.h, { reason: 'Only a reflection, not cracked' })); expect((await ok(call('GET', u(w, `damage/${x.id}`), O))).status).toBe('DISMISSED');
  });
});

describe('complaints and incidents', () => {
  it('keeps restricted cases away from people without the permission and runs the case to closure', async () => {
    const w = await sunset(); const fd = await staff(w, 'front_desk_agent'); const hk = await staff(w, 'housekeeper');
    const c1 = await ok(call('POST', u(w, 'cases'), fd.h, { type: 'GUEST_COMPLAINT', category: 'Noise', severity: 'MEDIUM', description: 'Loud music next door', channel: 'PHONE', roomId: w.room['101'] }), 201);
    expect(c1).toMatchObject({ restricted: false, slaHours: 72 });
    const c2 = await ok(call('POST', u(w, 'cases'), hk.h, { type: 'SECURITY', severity: 'CRITICAL', description: 'Door found forced open on floor 1' }), 201);
    expect(c2).toMatchObject({ restricted: true, slaHours: 4 });
    const c3 = await ok(call('POST', u(w, 'cases'), fd.h, { type: 'SERVICE_FAILURE', severity: 'LOW', confidential: true, description: 'Guest asked that this stays private' }), 201); expect(c3.restricted).toBe(true);
    const seen = await ok(call('GET', u(w, 'cases'), fd.h)); expect(seen.items.map((x: any) => x.id)).toEqual([c1.id]); expect(seen.restrictedAccess).toBe(false);
    await code(call('GET', u(w, `cases/${c2.id}`), fd.h), 404, 'NOT_FOUND');
    await code(call('PATCH', u(w, `cases/${c2.id}`), fd.h, { rootCause: 'x' }), 404, 'NOT_FOUND');
    const all = await ok(call('GET', u(w, 'cases'), O)); expect(all.items).toHaveLength(3); expect(all.restrictedAccess).toBe(true);
    const sec = await ok(call('GET', u(w, `cases/${c2.id}`), O)); expect(sec.events[0].note).toBeNull();            // the text of a restricted report is not copied into its history
    const gm = await adminDb.selectFrom('staff_user').select('id').where('tenant_id', '=', T.tenantId).where('email', 'like', '%front_desk_agent%').executeTakeFirstOrThrow();
    await ok(call('PATCH', u(w, `cases/${c1.id}`), fd.h, { ownerId: gm.id, rootCause: 'Party in 102', correctiveAction: 'Spoke to the guests' }));
    expect((await ok(call('GET', u(w, `cases/${c1.id}`), fd.h))).status).toBe('IN_PROGRESS');
    await code(call('POST', u(w, `cases/${c1.id}/close`), fd.h), 409, 'INVALID_STATE');
    await ok(call('POST', u(w, `cases/${c1.id}/resolve`), fd.h, { note: 'Music stopped, guest satisfied' })); await ok(call('POST', u(w, `cases/${c1.id}/close`), fd.h));
    await code(call('PATCH', u(w, `cases/${c1.id}`), fd.h, { rootCause: 'edit' }), 409, 'CASE_CLOSED');
    await ok(call('POST', u(w, `cases/${c1.id}/reopen`), fd.h, { reason: 'Guest complained again' })); expect((await ok(call('GET', u(w, `cases/${c1.id}`), fd.h))).status).toBe('IN_PROGRESS');
    const g = await ok(call('GET', u(w, `cases/${c1.id}`), fd.h)); expect(g.events.map((e: any) => e.action)).toEqual(['REPORTED', 'ASSIGNED', 'RESOLVED', 'CLOSED', 'REOPENED']);
    await adminDb.updateTable('case_record').set({ sla_due_at: new Date('2020-01-01T00:00:00Z') }).where('id', '=', c1.id).execute();
    expect((await ok(call('GET', u(w, 'cases?status=IN_PROGRESS'), fd.h))).items[0]).toMatchObject({ overdue: true });
  });
});
