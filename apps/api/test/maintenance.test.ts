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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'mnt'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@mnt.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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


const W = (w: W, tail: string) => u(w, `work-orders${tail}`);
const create = (w: W, body: Record<string, unknown>, h = O) => call('POST', W(w, ''), h, { title: 'Tap leaks', category: 'PLUMBING', priority: 2, ...body });
const act = (w: W, id: string, tail: string, body: unknown = {}, h = O) => call('POST', W(w, `/${id}/${tail}`), h, body);
const blocks = async (w: W) => (await ok(call('GET', u(w, 'room-blocks'), O))).items as Array<{ id: string; roomId: string }>;

describe('maintenance work orders', () => {
  it('a fault becomes a job: assigned to a technician, started, finished with its cost, checked by someone else; the room comes back dirty and the housekeeping report is closed', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    const tech = await staff(w, 'maintenance_technician'); const tech2 = await staff(w, 'maintenance_technician');
    const issue = await ok(call('POST', u(w, 'housekeeping/issues'), O, { roomId: w.room['102'], category: 'PLUMBING', description: 'Basin tap dripping', priority: 2 }), 201);
    const wo = await ok(create(w, { roomId: w.room['102'], issueId: issue.id, description: 'Washer worn', dueDate: '2026-11-03' }), 201);
    expect(wo).toMatchObject({ status: 'OPEN', number: expect.stringMatching(/-WO00001$/), room: '102', priority: 2, issueId: issue.id, overdue: false, cost: { amount: '0.00' } });
    await code(create(w, { issueId: issue.id }), 409, 'ISSUE_HAS_ORDER');
    await code(act(w, wo.id, 'assign', { assignedTo: T.ownerUserId === tech.id ? tech2.id : (await addUser(T.tenantId, `plain${++n}@mnt.test`)) }), 422, 'NOT_A_TECHNICIAN');
    await code(act(w, wo.id, 'start', {}, tech.h), 403, 'NOT_YOUR_JOB');                                // not assigned to them yet
    expect((await ok(call('GET', W(w, '/technicians'), O))).items.map((x: any) => x.id).sort()).toEqual([tech.id, tech2.id].sort());
    expect(await ok(act(w, wo.id, 'assign', { assignedTo: tech.id }))).toMatchObject({ status: 'ASSIGNED', assignee: expect.any(String) });
    await code(act(w, wo.id, 'start', {}, tech2.h), 403, 'NOT_YOUR_JOB');
    expect((await ok(call('GET', W(w, '?mine=true'), tech.h))).items.map((x: any) => x.id)).toEqual([wo.id]);
    expect(await ok(act(w, wo.id, 'start', {}, tech.h))).toMatchObject({ status: 'IN_PROGRESS' });
    expect(await ok(act(w, wo.id, 'wait', { reason: 'Waiting for a washer set' }, tech.h))).toMatchObject({ status: 'WAITING' });
    await ok(act(w, wo.id, 'start', {}, tech.h));
    await code(act(w, wo.id, 'verify', {}, tech.h), 403, 'PERMISSION_DENIED');
    const done = await ok(act(w, wo.id, 'done', { note: 'Replaced washer', cost: '350', vendor: 'Hardware shop' }, tech.h));
    expect(done).toMatchObject({ status: 'DONE', cost: { amount: '350.00' }, vendor: 'Hardware shop', doneNote: 'Replaced washer' });
    await code(act(w, wo.id, 'start', {}, tech.h), 409, 'WRONG_STATE');
    // the person who did it cannot check it; a manager can
    const mgr = await staff(w, 'property_admin');
    await ok(act(w, wo.id, 'reopen', { reason: 'Still dripping' }, mgr.h));
    await ok(act(w, wo.id, 'done', { note: 'Tightened and replaced', cost: '350' }, tech.h));
    expect(await ok(act(w, wo.id, 'verify', { note: 'Dry now' }, mgr.h))).toMatchObject({ status: 'VERIFIED', verifiedBy: expect.any(String) });
    expect((await adminDb.selectFrom('room_issue').select(['status', 'resolution_note']).where('id', '=', issue.id).executeTakeFirstOrThrow())).toMatchObject({ status: 'RESOLVED', resolution_note: expect.stringContaining('WO00001') });
    const h = await ok(call('GET', W(w, `/${wo.id}`), O));
    expect(h.events.map((e: any) => e.action)).toEqual(['CREATE', 'ASSIGN', 'START', 'WAIT', 'START', 'DONE', 'REOPEN', 'DONE', 'VERIFY']);
    expect((await ok(call('GET', W(w, '?status=DONE'), O))).items).toHaveLength(1);
    expect((await ok(call('GET', W(w, ''), O))).items).toHaveLength(0);
  });

  it('an out-of-order block is taken with the job (so the room cannot be sold) and released when the work is checked; a cancelled job releases it too; the self-check rule holds for owners as well', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    await setBd(w, '2026-11-01');
    const wo = await ok(create(w, { roomId: w.room['103'], title: 'AC not cooling', category: 'AC', priority: 1, outOfOrder: { startDate: '2026-11-01', endDate: '2026-11-08' } }), 201);
    expect((await blocks(w)).map((b) => b.roomId)).toEqual([w.room['103']]);
    expect(wo.blockId).toBeTruthy();
    const av = (await ok(call('GET', u(w, 'availability?from=2026-11-02&to=2026-11-03'), O))).roomTypes[0].nights[0];
    expect(av.available).toBe(3);                                                                         // 4 rooms, one out of order
    // the owner does the work himself and so cannot check it
    await ok(act(w, wo.id, 'start', {})); await ok(act(w, wo.id, 'done', { note: 'Gas refilled', cost: '4200' }));
    await code(act(w, wo.id, 'verify', {}, OM), 403, 'SELF_VERIFICATION');
    const mgr = await staff(w, 'general_manager');
    await ok(act(w, wo.id, 'verify', {}, mgr.h));
    expect(await blocks(w)).toHaveLength(0);                                                              // the block is gone: the room is for sale again
    expect((await ok(call('GET', u(w, 'availability?from=2026-11-02&to=2026-11-03'), O))).roomTypes[0].nights[0].available).toBe(4);
    expect(await adminDb.selectFrom('room').select('hk_status').where('id', '=', w.room['103']!).executeTakeFirstOrThrow()).toMatchObject({ hk_status: 'DIRTY' });
    // cancel releases a block as well
    const wo2 = await ok(create(w, { roomId: w.room['104'], title: 'Window broken', category: 'FURNITURE', outOfOrder: { startDate: '2026-11-03', endDate: '2026-11-06' } }), 201);
    expect(await blocks(w)).toHaveLength(1);
    await ok(act(w, wo2.id, 'cancel', { reason: 'Booked a repair for next month instead' }));
    expect(await blocks(w)).toHaveLength(0);
    await code(act(w, wo2.id, 'start', {}), 409, 'WRONG_STATE');
  });

  it('who may do what: front desk can look but not create; only the assigned technician (or a manager) moves a job; due dates show overdue; the overview counts them', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    const desk = await staff(w, 'front_desk_agent'); const tech = await staff(w, 'maintenance_technician');
    await code(create(w, {}, desk.h), 403, 'PERMISSION_DENIED');
    const wo = await ok(create(w, { title: 'Lobby light', category: 'ELECTRICAL', area: 'Lobby', dueDate: '2026-11-02', assignedTo: tech.id }), 201);
    expect(wo.status).toBe('ASSIGNED');
    expect((await ok(call('GET', W(w, ''), desk.h))).items).toHaveLength(1);
    await code(act(w, wo.id, 'notes', { note: 'hello' }, desk.h), 403, 'NOT_YOUR_JOB');
    await ok(act(w, wo.id, 'notes', { note: 'Bulb type is E27' }, tech.h));
    await setBd(w, '2026-11-05');
    expect((await ok(call('GET', W(w, `/${wo.id}`), O)))).toMatchObject({ overdue: true });
    const m = await ok(call('GET', '/v1/management/overview?from=2026-11-01&to=2026-11-02', O));
    expect(m.properties.find((p: any) => p.id === w.pid).maintenance).toMatchObject({ active: 1, overdue: 1, waiting: 0, urgent: 0, toCheck: 0 });
    await code(create(w, { title: 'x', category: 'AC' }, O), 400, 'VALIDATION_FAILED');
    await code(call('POST', W(w, ''), O, { title: 'Needs room', category: 'AC', outOfOrder: { startDate: '2026-11-05', endDate: '2026-11-06' } }), 400, 'VALIDATION_FAILED');
  });
});
