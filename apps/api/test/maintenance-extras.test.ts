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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'mnx'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@mnx.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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


const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(40, 1)]);
function upload(url: string, headers: Record<string, string>, data: Buffer, name = 'x.png') {
  const b = '----hosboundary';
  const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]);
  return app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': `multipart/form-data; boundary=${b}` }, payload });
}
const vendor = async (name: string) => ok(app.inject({ method: 'POST', url: '/v1/maintenance/vendors', headers: O, payload: { name: `${name} ${++n}`, trade: 'PLUMBING', phone: '0300 1112223' } }), 201);

describe('maintenance pictures and videos', () => {
  it('the person who asked adds pictures of the fault, the technician adds progress and finished photos; strangers cannot; types and limits are enforced; they show on the job', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    const asker = await staff(w, 'housekeeper'); const stranger = await staff(w, 'front_desk_agent'); const tech = await staff(w, 'maintenance_technician');
    const req = await ok(create(w, { title: 'Ceiling stain', roomId: w.room['101'] }, asker.h), 201);
    expect(req.status).toBe('REQUESTED');
    const m1 = await ok(upload(W(w, `/${req.id}/media`), asker.h, PNG), 201);
    expect(m1).toMatchObject({ kind: 'IMAGE', stage: 'REPORTED' });
    await code(upload(W(w, `/${req.id}/media`), stranger.h, PNG), 403, 'NOT_YOUR_JOB');
    await code(upload(W(w, `/${req.id}/media`), asker.h, Buffer.from('not a picture at all, just text'), 'x.png'), 400, 'MEDIA_TYPE_UNSUPPORTED');
    await ok(act(w, req.id, 'approve', { assignedTo: tech.id }));
    await ok(act(w, req.id, 'start', {}, tech.h));
    const v = await ok(upload(W(w, `/${req.id}/media`), tech.h, MP4, 'work.mp4'), 201);
    expect(v).toMatchObject({ kind: 'VIDEO', stage: 'PROGRESS' });
    await ok(upload(W(w, `/${req.id}/media`), tech.h, MP4, 'two.mp4'), 201);
    await code(upload(W(w, `/${req.id}/media`), tech.h, MP4, 'three.mp4'), 409, 'VIDEO_LIMIT');
    await ok(act(w, req.id, 'done', { note: 'Sealed the pipe above' }, tech.h));
    expect((await ok(upload(W(w, `/${req.id}/media`), tech.h, PNG), 201)).stage).toBe('COMPLETED');
    const job = await ok(call('GET', W(w, `/${req.id}`), asker.h));
    expect(job.media.map((x: any) => [x.kind, x.stage])).toEqual([['IMAGE', 'REPORTED'], ['VIDEO', 'PROGRESS'], ['VIDEO', 'PROGRESS'], ['IMAGE', 'COMPLETED']]);
    expect((await app.inject({ method: 'GET', url: job.media[0].url })).statusCode).toBe(200);
    expect(job.bills).toBeNull();                                                              // the person who asked does not see bills
    await code(app.inject({ method: 'DELETE', url: W(w, `/${req.id}/media/${m1.id}`), headers: tech.h }), 403, 'PERMISSION_DENIED');
    expect((await app.inject({ method: 'DELETE', url: W(w, `/${req.id}/media/${m1.id}`), headers: asker.h })).statusCode).toBe(204);
  });
});

describe('maintenance bills', () => {
  it('a contractor’s bill is recorded, approved by an approver, paid by someone who may pay, and read only by people who deal with bills; the estimate is compared with what was billed', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    const v = await vendor('Aqua Fix'); const accountant = await staff(w, 'accountant'); const clerk = await staff(w, 'front_desk_agent');
    const job = await ok(create(w, { title: 'Replace geyser', estimatedCost: '20000', vendorId: v.id, kind: 'CORRECTIVE' }), 201);
    await code(call('POST', W(w, `/${job.id}/bills`), clerk.h, { billNo: 'A-1', billDate: '2026-11-02', amount: '25000' }), 403, 'PERMISSION_DENIED');
    const b = await ok(call('POST', W(w, `/${job.id}/bills`), O, { billNo: 'A-101', billDate: '2026-11-02', dueDate: '2026-11-16', amount: '25000', note: 'Geyser and fitting' }), 201);
    await code(call('POST', W(w, `/${job.id}/bills`), O, { billNo: 'a-101', billDate: '2026-11-02', amount: '100' }), 409, 'DUPLICATE');
    await code(call('POST', W(w, `/${job.id}/bills`), O, { billNo: 'X', billDate: '2026-11-02', amount: '0' }), 422, 'VALIDATION_FAILED');
    expect((await upload(W(w, `/${job.id}/bills/${b.id}/file`), O, PDF, 'bill.pdf')).statusCode).toBe(201);
    const f = await call('GET', W(w, `/${job.id}/bills/${b.id}/file`), accountant.h);
    expect(f.statusCode).toBe(200); expect(f.headers['content-type']).toBe('application/pdf'); expect(f.headers['cache-control']).toContain('no-store');
    await code(call('GET', W(w, `/${job.id}/bills/${b.id}/file`), clerk.h), 403, 'PERMISSION_DENIED');
    const view = await ok(call('GET', W(w, `/${job.id}`), O));
    expect(view.bills).toMatchObject({ billed: { amount: '25000.00' }, paid: { amount: '0.00' }, overEstimate: true }); expect(view.bills.items[0]).toMatchObject({ status: 'RECEIVED', hasFile: true, payee: expect.stringContaining('Aqua Fix') });
    await code(call('POST', W(w, `/${job.id}/bills/${b.id}/pay`), accountant.h, { method: 'BANK_TRANSFER', ref: 'TT-1' }), 409, 'WRONG_STATE');      // not approved yet
    await code(call('POST', W(w, `/${job.id}/bills/${b.id}/approve`), accountant.h, {}), 403, 'PERMISSION_DENIED');
    await ok(call('POST', W(w, `/${job.id}/bills/${b.id}/approve`), O, {}));
    const open = await ok(call('GET', u(w, 'maintenance-bills'), accountant.h));
    expect(open.totals.approvedUnpaid.amount).toBe('25000.00'); expect(open.owedByPayee[0]).toMatchObject({ amount: { amount: '25000.00' } }); expect(open.items).toHaveLength(1);
    await ok(call('POST', W(w, `/${job.id}/bills/${b.id}/pay`), accountant.h, { method: 'BANK_TRANSFER', ref: 'TT-9981' }));
    await code(call('POST', W(w, `/${job.id}/bills/${b.id}/pay`), accountant.h, { method: 'CASH' }), 409, 'WRONG_STATE');
    const after = await ok(call('GET', u(w, 'maintenance-bills?status=ALL'), accountant.h));
    expect(after.totals).toMatchObject({ approvedUnpaid: { amount: '0.00' }, paid: { amount: '25000.00' } }); expect(after.items[0]).toMatchObject({ status: 'PAID', paidMethod: 'BANK_TRANSFER', paidRef: 'TT-9981' });
    await code(call('GET', u(w, 'maintenance-bills'), clerk.h), 403, 'PERMISSION_DENIED');
    const hist = (await ok(call('GET', W(w, `/${job.id}`), O))).events.map((e: any) => e.action); expect(hist).toEqual(expect.arrayContaining(['BILL', 'BILL_APPROVED', 'BILL_PAID']));
  });

  it('a rejected bill can be entered again corrected; an in-house job can have a bill from a shop by name; a bill needs an approved job', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    const v = await vendor('Spark Co'); const asker = await staff(w, 'housekeeper');
    const requested = await ok(create(w, { title: 'Light', category: 'ELECTRICAL' }, asker.h), 201);
    await code(call('POST', W(w, `/${requested.id}/bills`), O, { payee: 'Hardware shop', billNo: '1', billDate: '2026-11-02', amount: '500' }), 409, 'WRONG_STATE');
    const job = await ok(create(w, { title: 'Rewire', category: 'ELECTRICAL', vendorId: v.id }), 201);
    const b1 = await ok(call('POST', W(w, `/${job.id}/bills`), O, { billNo: 'S-7', billDate: '2026-11-02', amount: '9000' }), 201);
    await ok(call('POST', W(w, `/${job.id}/bills/${b1.id}/reject`), O, { reason: 'Quantity does not match the job' }));
    await ok(call('POST', W(w, `/${job.id}/bills`), O, { billNo: 'S-7', billDate: '2026-11-03', amount: '7500' }), 201);
    const shop = await ok(call('POST', W(w, `/${job.id}/bills`), O, { payee: 'Mian Hardware', billNo: 'H-12', billDate: '2026-11-03', amount: '800' }), 201);
    const v2 = await ok(call('GET', W(w, `/${job.id}`), O));
    expect(v2.bills.billed.amount).toBe('8300.00');                                                // the rejected 9000 is not counted
    expect(v2.bills.items.map((x: any) => [x.billNo, x.status])).toEqual(expect.arrayContaining([['S-7', 'REJECTED'], ['S-7', 'RECEIVED'], ['H-12', 'RECEIVED']]));
  });
});

describe('recurring preventive maintenance', () => {
  it('a schedule creates its job once, ahead of its due date and already assigned; the night audit creates them; the next date moves on and skips missed ones', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    const tech = await staff(w, 'maintenance_technician'); const clerk = await staff(w, 'front_desk_agent');
    await code(call('POST', u(w, 'maintenance-schedules'), clerk.h, { title: 'AC service', category: 'AC', everyN: 3, unit: 'MONTH', firstDue: '2026-11-10' }), 403, 'PERMISSION_DENIED');
    const s = await ok(call('POST', u(w, 'maintenance-schedules'), O, { title: 'AC filter service', category: 'AC', everyN: 3, unit: 'MONTH', firstDue: '2026-11-10', leadDays: 7, assignedTo: tech.id, roomIds: [w.room['101'], w.room['102']], estimatedCost: '1500' }), 201);
    expect(s.ids).toHaveLength(2);
    expect((await ok(call('POST', u(w, 'maintenance-schedules/run'), O, {}))).created).toBe(0);               // 1 Nov is more than 7 days before 10 Nov
    await setBd(w, '2026-11-03');
    expect((await ok(call('POST', u(w, 'maintenance-schedules/run'), O, {}))).created).toBe(2);
    expect((await ok(call('POST', u(w, 'maintenance-schedules/run'), O, {}))).created).toBe(0);               // once per due date
    const jobs = (await ok(call('GET', W(w, '?status=ALL&kind=PREVENTIVE'), O))).items;
    expect(jobs).toHaveLength(2); expect(jobs[0]).toMatchObject({ kind: 'PREVENTIVE', status: 'ASSIGNED', assignee: expect.any(String), dueDate: '2026-11-10' });
    const list = (await ok(call('GET', u(w, 'maintenance-schedules'), O))).items;
    expect(list.every((x: any) => x.nextDue === '2027-02-10' && x.lastCreatedFor === '2026-11-10')).toBe(true);
    // a long gap: the next date is the first one on or after today, not a pile of old jobs
    await ok(call('PATCH', u(w, `maintenance-schedules/${s.ids[0]}`), O, { everyN: 1, unit: 'WEEK', nextDue: '2026-11-04', leadDays: 0 }));
    await setBd(w, '2026-12-20');
    expect((await ok(call('POST', u(w, 'maintenance-schedules/run'), O, {}))).created).toBe(1);
    expect((await ok(call('GET', u(w, 'maintenance-schedules'), O))).items.find((x: any) => x.id === s.ids[0]).nextDue >= '2026-12-20').toBe(true);
    await ok(call('PATCH', u(w, `maintenance-schedules/${s.ids[0]}`), O, { active: false }));
  });

  it('the night audit creates the jobs that fall due in the coming days', async () => {
    const w = await sunset(); at('2026-11-01', '21:00');
    await ok(call('POST', u(w, 'maintenance-schedules'), O, { title: 'Fire extinguisher check', category: 'SAFETY', everyN: 6, unit: 'MONTH', firstDue: '2026-11-04', leadDays: 3 }), 201);
    const r = await audit(w); expect(r.statusCode, r.body).toBe(200);
    const jobs = (await ok(call('GET', W(w, '?status=ALL&kind=PREVENTIVE'), O))).items;
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ title: 'Fire extinguisher check', status: 'OPEN', dueDate: '2026-11-04' });
  });
});
