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
    expect((await ok(create(w, {}, desk.h), 201)).status).toBe('REQUESTED');                                 // anyone with the right may ask; it waits for approval
    await code(create(w, { assignedTo: tech.id }, desk.h), 403, 'PERMISSION_DENIED');                       // but cannot pick who does it
    const wo = await ok(create(w, { title: 'Lobby light', category: 'ELECTRICAL', area: 'Lobby', dueDate: '2026-11-02', assignedTo: tech.id }), 201);
    expect(wo.status).toBe('ASSIGNED');
    expect((await ok(call('GET', W(w, ''), desk.h))).items).toHaveLength(2);
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

describe('request, approval and contractors', () => {
  const W2 = (w: W, tail: string) => `/v1/properties/${w.pid}/work-orders${tail}`;
  const post = (w: W, tail: string, body: unknown, h: Record<string, string> = O) => call('POST', W2(w, tail), h, body);
  const vendor = async (o: Record<string, unknown> = {}) => ok(call('POST', '/v1/maintenance/vendors', O, { name: `Cool Air ${++n}`, trade: 'AC', contactName: 'Imran', phone: '0300 1112223', contractRef: 'SLA-2026-01', slaResponseHours: 4, slaFixHours: 24, ...o }), 201);

  it('a request waits for approval; the approver sends it to a contractor with an estimate; the contractor’s work is recorded and checked; the technician list never sees it before', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    const desk = await staff(w, 'front_desk_agent'); const gm = await staff(w, 'general_manager'); const v = await vendor();
    const req = await ok(post(w, '', { title: 'AC switches off by itself', description: 'Room 102, compressor trips after ten minutes', category: 'AC', kind: 'CORRECTIVE', priority: 2, roomId: w.room['102'], estimatedCost: '8000' }, desk.h), 201);
    expect(req).toMatchObject({ status: 'REQUESTED', kind: 'CORRECTIVE', estimatedCost: { amount: '8000.00' }, approvedBy: null });
    expect((await ok(call('GET', W2(w, '?status=REQUESTED'), O))).items.map((x: any) => x.id)).toEqual([req.id]);
    await code(post(w, `/${req.id}/approve`, {}, desk.h), 403, 'PERMISSION_DENIED');
    await code(post(w, `/${req.id}/start`, {}, gm.h), 409, 'WRONG_STATE');                                  // not before it is approved
    const ok1 = await ok(post(w, `/${req.id}/approve`, { vendorId: v.id, dueDate: '2026-11-02', estimatedCost: '9500', note: 'Call them today' }, gm.h));
    expect(ok1).toMatchObject({ status: 'ASSIGNED', vendorId: v.id, contractor: 'Cool Air ' + (n - 0), estimatedCost: { amount: '9500.00' }, approvedBy: expect.any(String) });
    at('2026-11-01', '11:00');
    await ok(post(w, `/${req.id}/start`, {}, gm.h));                                                         // a manager records that the contractor arrived
    at('2026-11-01', '15:00');
    const done = await ok(post(w, `/${req.id}/done`, { note: 'Replaced capacitor', cost: '9000' }, gm.h));
    expect(done).toMatchObject({ status: 'DONE', cost: { amount: '9000.00' } });
    expect(done.sla).toMatchObject({ responseHours: 4, fixHours: 24, responseBreached: false, fixBreached: false });
    await code(post(w, `/${req.id}/verify`, {}, gm.h), 403, 'SELF_VERIFICATION');
    expect((await ok(post(w, `/${req.id}/verify`, {}, O))).status).toBe('VERIFIED');
  });

  it('shows when a contractor was slow against their contract', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    const v = await vendor({ slaResponseHours: 2, slaFixHours: 6 });
    const wo = await ok(post(w, '', { title: 'Fumigation', category: 'FUMIGATION', kind: 'PREVENTIVE', vendorId: v.id }), 201);
    expect(wo).toMatchObject({ status: 'ASSIGNED', kind: 'PREVENTIVE', category: 'FUMIGATION' });
    at('2026-11-01', '13:00');
    expect((await ok(call('GET', W2(w, `/${wo.id}`), O))).sla).toMatchObject({ responseBreached: true, fixBreached: false });
    at('2026-11-01', '16:00');
    expect((await ok(call('GET', W2(w, `/${wo.id}`), O))).sla).toMatchObject({ responseBreached: true, fixBreached: true });
  });

  it('a request can be turned down with a reason, or withdrawn by the person who made it — nobody else', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    const d1 = await staff(w, 'front_desk_agent'), d2 = await staff(w, 'front_desk_agent'), gm = await staff(w, 'general_manager');
    const a = await ok(post(w, '', { title: 'Repaint lobby wall', category: 'OTHER' }, d1.h), 201);
    await code(post(w, `/${a.id}/reject`, { reason: 'ab' }, gm.h), 400, 'VALIDATION_FAILED');
    expect(await ok(post(w, `/${a.id}/reject`, { reason: 'Not in this year’s budget' }, gm.h))).toMatchObject({ status: 'REJECTED', rejectedReason: 'Not in this year’s budget' });
    const b = await ok(post(w, '', { title: 'Replace curtain', category: 'FURNITURE' }, d1.h), 201);
    await code(post(w, `/${b.id}/cancel`, { reason: 'Another request' }, d2.h), 403, 'PERMISSION_DENIED');
    expect((await ok(post(w, `/${b.id}/cancel`, { reason: 'Fixed it myself' }, d1.h))).status).toBe('CANCELLED');
  });

  it('approving can also take the room out of order, for those who may; requests cannot', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    const desk = await staff(w, 'front_desk_agent'); const gm = await staff(w, 'general_manager');
    await code(post(w, '', { title: 'Ceiling leak', category: 'PLUMBING', roomId: w.room['103'], outOfOrder: { startDate: '2026-11-01', endDate: '2026-11-04' } }, desk.h), 403, 'PERMISSION_DENIED');
    const r = await ok(post(w, '', { title: 'Ceiling leak', category: 'PLUMBING', roomId: w.room['103'] }, desk.h), 201);
    expect((await ok(post(w, `/${r.id}/approve`, { priority: 1, outOfOrder: { startDate: '2026-11-01', endDate: '2026-11-04' } }, gm.h)))).toMatchObject({ status: 'OPEN', priority: 1, blockId: expect.any(String) });
  });

  it('contractors: only those with the right manage them; names are unique; an inactive contractor cannot be given work', async () => {
    const w = await sunset(); const tech = await staff(w, 'maintenance_technician'); const gm = await staff(w, 'general_manager');
    const v = await vendor({ name: `Unique ${++n}` });
    await code(call('POST', '/v1/maintenance/vendors', tech.h, { name: 'Sneaky Ltd' }), 403, 'PERMISSION_DENIED');
    await code(call('POST', '/v1/maintenance/vendors', gm.h, { name: v.name }), 409, 'DUPLICATE_VENDOR');
    await code(call('POST', '/v1/maintenance/vendors', gm.h, { name: 'Dates Ltd', contractStart: '2026-12-01', contractEnd: '2026-11-01' }), 422, 'VALIDATION_FAILED');
    expect((await ok(call('GET', '/v1/maintenance/vendors', tech.h))).items.map((x: any) => x.id)).toContain(v.id);        // technicians can see the list
    await ok(call('PATCH', `/v1/maintenance/vendors/${v.id}`, gm.h, { status: 'INACTIVE' }));
    const wo = await ok(post(w, '', { title: 'Fan noise', category: 'ELECTRICAL' }), 201);
    await code(post(w, `/${wo.id}/assign`, { vendorId: v.id }), 422, 'VENDOR_INACTIVE');
    await code(post(w, `/${wo.id}/assign`, { vendorId: v.id, assignedTo: tech.id }), 400, 'VALIDATION_FAILED');
    expect((await ok(call('GET', '/v1/maintenance/vendors', gm.h))).items.map((x: any) => x.id)).not.toContain(v.id);        // inactive ones are hidden by default
  });

  it('lists the work by kind, by contractor, by technician and by trade', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    const tech = await staff(w, 'maintenance_technician'); const v = await vendor();
    await ok(post(w, '', { title: 'Service the chillers', category: 'AC', kind: 'PREVENTIVE', vendorId: v.id, estimatedCost: '5000' }), 201);
    await ok(post(w, '', { title: 'Fix AC remote', category: 'AC', assignedTo: tech.id }), 201);
    await ok(post(w, '', { title: 'Flush the tanks', category: 'PLUMBING', kind: 'PREVENTIVE' }), 201);
    const by = async (k: string) => (await ok(call('GET', W2(w, `/summary?by=${k}`), O))).items as Array<{ key: string | null; label: string | null; open: number; active: number; estimated: { amount: string } }>;
    expect((await by('kind')).map((g) => [g.key, g.open + g.active]).sort()).toEqual([['CORRECTIVE', 1], ['PREVENTIVE', 2]]);
    expect(await by('vendor')).toEqual([expect.objectContaining({ key: v.id, active: 1, estimated: { amount: '5000.00', currency: 'PKR' } })]);
    expect(await by('technician')).toEqual([expect.objectContaining({ key: tech.id, active: 1 })]);
    expect((await by('category')).find((g) => g.key === 'AC')).toMatchObject({ active: 2 });
    expect((await ok(call('GET', W2(w, `?kind=PREVENTIVE&vendorId=${v.id}`), O))).items).toHaveLength(1);
  });

  it('writes the message to the technician or contractor, in the owner’s wording, ready for WhatsApp', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    const v = await vendor({ contactName: 'Imran', name: `Msg Air ${++n}` });
    const wo = await ok(post(w, '', { title: 'AC trips', description: 'Compressor stops after 10 min', category: 'AC', priority: 1, roomId: w.room['101'], dueDate: '2026-11-02', vendorId: v.id }), 201);
    const m = await ok(call('POST', `/v1/properties/${w.pid}/work-orders/${wo.id}/message`, O, {}));
    expect(m.phone).toBe('0300 1112223');
    expect(m.text).toContain('Hello Imran (Msg Air'); expect(m.text).toContain('URGENT repair job'); expect(m.text).toContain('Where: Room 101'); expect(m.text).toContain('Details: Compressor stops after 10 min'); expect(m.text).toContain('Please finish by: 2 November 2026');
    const free = await ok(post(w, '', { title: 'Tap', category: 'PLUMBING' }), 201);
    await code(call('POST', `/v1/properties/${w.pid}/work-orders/${free.id}/message`, O, {}), 422, 'NOT_ASSIGNED');
  });
});
