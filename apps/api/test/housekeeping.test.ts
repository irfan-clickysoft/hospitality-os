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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'hk'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

async function sunset() {
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `HK${++n}`, name: `Housekeeping ${n}` })).json().id as string;
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'STD', name: 'Standard', maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id as string;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, from: 101, to: 105 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'BAR', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '12000', extraAdult: '3000', extraChild: '1500' }] });
  const rooms = (await call('GET', `/v1/properties/${pid}/rooms`, O)).json().items as Array<{ id: string; number: string }>;
  return { pid, rt, room: Object.fromEntries(rooms.map((r) => [r.number, r.id])) as Record<string, string> };
}
type W = Awaited<ReturnType<typeof sunset>>;
const hk = (w: W, tail: string) => `/v1/properties/${w.pid}/housekeeping/${tail}`;
const setBd = (w: W, d: string) => adminDb.updateTable('property').set({ business_date: d }).where('id', '=', w.pid).execute();
const staff = async (w: W, role: string, name?: string) => { const id = await addUser(T.tenantId, `${role}${++n}@hk.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); if (name) await adminDb.updateTable('staff_user').set({ full_name: name }).where('id', '=', id).execute(); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };
const roomRow = (w: W, num: string) => adminDb.selectFrom('room').select(['hk_status', 'dnd']).where('id', '=', w.room[num]!).executeTakeFirstOrThrow();
const tasks = (w: W, num?: string) => { let q = adminDb.selectFrom('housekeeping_task').selectAll().where('property_id', '=', w.pid); if (num) q = q.where('room_id', '=', w.room[num]!); return q.orderBy('created_at').execute(); };

async function book(w: W, o: { arrival?: string; departure?: string; vip?: boolean } = {}) {
  const q = (await call('POST', `/v1/properties/${w.pid}/quotes`, O, { arrival: o.arrival ?? '2026-11-05', departure: o.departure ?? '2026-11-07', adults: 2 })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(5000000 + n).slice(-7)}`, nationality: 'PK', vip: !!o.vip }), 201);
  const r = await ok(call('POST', `/v1/properties/${w.pid}/reservations`, O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, { 'idempotency-key': `hk-${++n}-${Date.now()}` }), 201);
  return { id: r.id as string, line: r.lines[0].id as string };
}
const checkIn = (w: W, b: { id: string; line: string }, room: string) => ok(call('POST', `/v1/properties/${w.pid}/reservations/${b.id}/rooms/${b.line}/check-in`, O, { roomId: w.room[room], occupants: [{ fullName: 'Guest', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671' }] }));
const checkOut = (w: W, b: { id: string; line: string }) => ok(call('POST', `/v1/properties/${w.pid}/reservations/${b.id}/rooms/${b.line}/check-out`, OM, { balanceReason: 'test: settled elsewhere' }));
const assign = (w: W, ids: string[], to: string | null, h = O) => ok(call('POST', hk(w, 'tasks/assign'), h, { taskIds: ids, assigneeId: to }));

describe('tasks appear when guests leave', () => {
  it('check-out turns the room dirty and queues a clean', async () => {
    const w = await sunset();
    const a = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, a, '101');
    await setBd(w, '2026-11-07'); await checkOut(w, a);
    expect((await roomRow(w, '101')).hk_status).toBe('DIRTY');
    const t = await tasks(w, '101'); expect(t).toHaveLength(1); expect(t[0]).toMatchObject({ task_type: 'CHECKOUT_CLEAN', status: 'PENDING', priority: 3 });
    expect(t[0]!.status).toBe('PENDING');
  });

  it('priority rules at the moment of vacating', async () => {
    const w = await sunset();
    const out = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' }); await setBd(w, '2026-11-05'); await checkIn(w, out, '104');
    const vip = await book(w, { arrival: '2026-11-07', departure: '2026-11-08', vip: true });
    const reg = await book(w, { arrival: '2026-11-07', departure: '2026-11-08' });
    await ok(call('PUT', `/v1/properties/${w.pid}/reservations/${reg.id}/rooms/${reg.line}/assignment`, O, { roomId: w.room['105'] }));
    await setBd(w, '2026-11-07');
    // vip arrives into 104 once the departing guest leaves — assign after checkout is impossible (still in-house), so assign for the same dates is refused;
    // the realistic order is: checkout first, then the arrival is assigned and the board raises the clean's priority at generation time.
    await checkOut(w, out);
    expect((await tasks(w, '104'))[0]!.priority).toBe(3);
    await ok(call('PUT', `/v1/properties/${w.pid}/reservations/${vip.id}/rooms/${vip.line}/assignment`, O, { roomId: w.room['104'] }));
    const g = await ok(call('POST', hk(w, 'generate'), O));
    expect(g.prioritised).toBe(1);
    expect((await tasks(w, '104'))[0]!.priority).toBe(1);                        // VIP arriving today
  });
});

describe('the attendant’s day', () => {
  it('assigned by a supervisor, cleaned by the attendant: room goes dirty → cleaning → clean; replays change nothing', async () => {
    const w = await sunset(); const sup = await staff(w, 'housekeeping_supervisor'); const a1 = await staff(w, 'housekeeper', 'Attendant One'); const a2 = await staff(w, 'housekeeper', 'Attendant Two');
    const b = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, b, '101'); await setBd(w, '2026-11-07'); await checkOut(w, b);
    const [task] = await tasks(w, '101');
    await assign(w, [task!.id], a1.id, sup.h);
    const mine = await ok(call('GET', hk(w, 'my-tasks'), a1.h));
    expect(mine.items).toHaveLength(1); expect(mine.items[0]).toMatchObject({ roomNumber: '101', type: 'CHECKOUT_CLEAN', status: 'PENDING' });
    expect((await ok(call('GET', hk(w, 'my-tasks'), a2.h))).items).toEqual([]);
    await code(call('POST', hk(w, `tasks/${task!.id}/start`), a2.h, {}), 403, 'NOT_YOUR_TASK');
    const s1 = await ok(call('POST', hk(w, `tasks/${task!.id}/start`), a1.h, {}));
    expect(s1).toMatchObject({ status: 'IN_PROGRESS', roomStatus: 'CLEANING' });
    const s2 = await ok(call('POST', hk(w, `tasks/${task!.id}/start`), a1.h, {}));                  // a replayed offline action
    expect(s2.startedAt).toBe(s1.startedAt);
    const f1 = await ok(call('POST', hk(w, `tasks/${task!.id}/finish`), a1.h, { notes: 'Replaced towels' }));
    expect(f1).toMatchObject({ status: 'DONE', roomStatus: 'CLEAN', inspection: null });
    const f2 = await ok(call('POST', hk(w, `tasks/${task!.id}/finish`), a1.h, {}));
    expect(f2.finishedAt).toBe(f1.finishedAt);
    expect((await ok(call('GET', hk(w, 'my-tasks'), a1.h))).items).toEqual([]);
    expect((await ok(call('GET', hk(w, 'my-tasks?includeDone=true'), a1.h))).items[0].status).toBe('DONE');
    const ev = (await adminDb.selectFrom('outbox_event').select('event_type').where('tenant_id', '=', T.tenantId).where('aggregate_id', '=', task!.id).execute()).map((e) => e.event_type);
    expect(ev).toEqual(expect.arrayContaining(['HousekeepingTaskCreated', 'HousekeepingTaskStarted', 'HousekeepingTaskFinished']));
  });

  it('an unassigned task can be claimed; one room at a time; a room being cleaned is not ready for a guest; releasing puts it back', async () => {
    const w = await sunset(); const a1 = await staff(w, 'housekeeper'); const sup = await staff(w, 'housekeeping_supervisor');
    const t1 = await ok(call('POST', hk(w, 'tasks'), sup.h, { roomId: w.room['101'], priority: 2, notes: 'Extra pillows' }), 201);
    const t2 = await ok(call('POST', hk(w, 'tasks'), sup.h, { roomId: w.room['102'] }), 201);
    await ok(call('POST', hk(w, `tasks/${t1.id}/start`), a1.h, {}));
    await code(call('POST', hk(w, `tasks/${t2.id}/start`), a1.h, {}), 409, 'ALREADY_CLEANING');
    expect((await roomRow(w, '101')).hk_status).toBe('CLEANING');
    const rel = await ok(call('POST', hk(w, `tasks/${t1.id}/release`), a1.h));
    expect(rel).toMatchObject({ status: 'PENDING', roomStatus: 'DIRTY' });
    await ok(call('POST', hk(w, `tasks/${t2.id}/start`), a1.h, {}));
    await ok(call('POST', hk(w, `tasks/${t2.id}/finish`), a1.h, {}));
    expect((await roomRow(w, '102')).hk_status).toBe('CLEAN');
  });

  it('offline actions carry the time they really happened — within 48 hours and never in the future', async () => {
    const w = await sunset(); const a1 = await staff(w, 'housekeeper'); const sup = await staff(w, 'housekeeping_supervisor');
    testClock.set(zonedToUtcMs('2026-11-03', '12:00', 'Asia/Karachi'));
    const t = await ok(call('POST', hk(w, 'tasks'), sup.h, { roomId: w.room['101'] }), 201);
    const when = new Date(testClock.now() - 25 * 60_000).toISOString();
    const s = await ok(call('POST', hk(w, `tasks/${t.id}/start`), a1.h, { at: when }));
    expect(s.startedAt).toBe(when);
    const f = await ok(call('POST', hk(w, `tasks/${t.id}/finish`), a1.h, { at: new Date(testClock.now() + 3_600_000).toISOString() }));   // a clock set in the future is ignored
    expect(new Date(f.finishedAt).getTime()).toBe(testClock.now());
    const t2 = await ok(call('POST', hk(w, 'tasks'), sup.h, { roomId: w.room['102'] }), 201);
    const old = await ok(call('POST', hk(w, `tasks/${t2.id}/start`), a1.h, { at: new Date(testClock.now() - 5 * 86_400_000).toISOString() }));
    expect(new Date(old.startedAt).getTime()).toBe(testClock.now());
  });
});

describe('inspection', () => {
  it('when required: a different person inspects; a failed room goes back with the note and cannot be sold dirty', async () => {
    const w = await sunset(); const sup = await staff(w, 'housekeeping_supervisor'); const a1 = await staff(w, 'housekeeper');
    await ok(call('PUT', hk(w, 'settings'), O, { requireInspection: true }));
    const t = await ok(call('POST', hk(w, 'tasks'), sup.h, { roomId: w.room['101'], assignTo: a1.id }), 201);
    await ok(call('POST', hk(w, `tasks/${t.id}/start`), a1.h, {}));
    const f = await ok(call('POST', hk(w, `tasks/${t.id}/finish`), a1.h, {}));
    expect(f).toMatchObject({ status: 'DONE', inspection: 'PENDING', roomStatus: 'CLEAN' });
    expect((await ok(call('GET', hk(w, 'board'), sup.h))).summary.awaitingInspection).toBe(1);
    await code(call('POST', hk(w, `tasks/${t.id}/inspect`), a1.h, { pass: true }), 403, 'PERMISSION_DENIED');
    await code(call('POST', hk(w, `tasks/${t.id}/inspect`), sup.h, { pass: false }), 422, 'NOTE_REQUIRED');
    const bad = await ok(call('POST', hk(w, `tasks/${t.id}/inspect`), sup.h, { pass: false, note: 'Dust under the bed' }));
    expect(bad).toMatchObject({ status: 'PENDING', inspection: 'FAILED', inspectionNote: 'Dust under the bed', reworkCount: 1, roomStatus: 'DIRTY', priority: 2 });
    expect((await ok(call('GET', hk(w, 'my-tasks'), a1.h))).items[0]).toMatchObject({ reworkCount: 1, inspectionNote: 'Dust under the bed' });
    await ok(call('POST', hk(w, `tasks/${t.id}/start`), a1.h, {})); await ok(call('POST', hk(w, `tasks/${t.id}/finish`), a1.h, {}));
    const good = await ok(call('POST', hk(w, `tasks/${t.id}/inspect`), sup.h, { pass: true }));
    expect(good).toMatchObject({ inspection: 'PASSED', roomStatus: 'INSPECTED' });
    await code(call('POST', hk(w, `tasks/${t.id}/inspect`), sup.h, { pass: true }), 409, 'NOT_AWAITING_INSPECTION');
    // a supervisor who also cleaned it cannot inspect their own work
    const t2 = await ok(call('POST', hk(w, 'tasks'), sup.h, { roomId: w.room['102'], assignTo: sup.id }), 201);
    await ok(call('POST', hk(w, `tasks/${t2.id}/finish`), sup.h, {}));
    await code(call('POST', hk(w, `tasks/${t2.id}/inspect`), sup.h, { pass: true }), 403, 'SELF_INSPECTION');
    // only structure admins change the setting
    await code(call('PUT', hk(w, 'settings'), sup.h, { requireInspection: false }), 403, 'PERMISSION_DENIED');
  });
});

describe('daily generation, DND and skipping', () => {
  it('stay-over services are generated once per day; a do-not-disturb room is skipped and recorded', async () => {
    const w = await sunset();
    const a = await book(w, { departure: '2026-11-09' }); const b = await book(w, { departure: '2026-11-09' });
    await setBd(w, '2026-11-05'); await checkIn(w, a, '101'); await checkIn(w, b, '102');
    await setBd(w, '2026-11-06');
    await ok(call('PUT', hk(w, 'rooms/' + w.room['102'] + '/dnd'), (await staff(w, 'housekeeper')).h, { dnd: true }));
    const g1 = await ok(call('POST', hk(w, 'generate'), O));
    expect(g1).toMatchObject({ stayovers: 1, skippedDnd: 1 });
    expect((await roomRow(w, '101')).hk_status).toBe('DIRTY');                              // service due
    const g2 = await ok(call('POST', hk(w, 'generate'), O));
    expect(g2).toMatchObject({ stayovers: 0, skippedDnd: 0 });                              // repeating creates nothing
    const all = await tasks(w);
    expect(all.filter((t) => t.task_type === 'STAYOVER')).toHaveLength(2);
    expect(all.find((t) => t.room_id === w.room['102'])).toMatchObject({ status: 'SKIPPED', skip_reason: 'Do not disturb' });
    // the guest leaves on the 9th: the pending service is moot, DND is cleared and the room turns over
    await setBd(w, '2026-11-09'); await checkOut(w, a);
    expect((await tasks(w, '101')).find((t) => t.task_type === 'STAYOVER')).toMatchObject({ status: 'CANCELLED' });
    await checkOut(w, b);
    expect((await roomRow(w, '102')).dnd).toBe(false);
  });

  it('turning DND on skips the day’s pending service; stay-over can be skipped with a reason, a checkout clean cannot', async () => {
    const w = await sunset(); const a1 = await staff(w, 'housekeeper'); const sup = await staff(w, 'housekeeping_supervisor');
    const b = await book(w, { departure: '2026-11-09' }); await setBd(w, '2026-11-05'); await checkIn(w, b, '101'); await setBd(w, '2026-11-06');
    await ok(call('POST', hk(w, 'generate'), O));
    const [svc] = (await tasks(w, '101')).filter((t) => t.task_type === 'STAYOVER');
    await ok(call('PUT', hk(w, `rooms/${w.room['101']}/dnd`), a1.h, { dnd: true }));
    expect((await tasks(w, '101')).find((t) => t.id === svc!.id)).toMatchObject({ status: 'SKIPPED' });
    await ok(call('PUT', hk(w, `rooms/${w.room['101']}/dnd`), a1.h, { dnd: false }));
    // guest refuses service on another room
    const c = await book(w, { departure: '2026-11-09', arrival: '2026-11-06' }); await checkIn(w, c, '102'); await setBd(w, '2026-11-07');
    await ok(call('POST', hk(w, 'generate'), O));
    const t = (await tasks(w, '102')).find((x) => x.task_type === 'STAYOVER')!;
    await code(call('POST', hk(w, `tasks/${t.id}/skip`), a1.h, { reason: 'x' }), 400, 'VALIDATION_FAILED');
    const sk = await ok(call('POST', hk(w, `tasks/${t.id}/skip`), a1.h, { reason: 'Guest declined service' }));
    expect(sk).toMatchObject({ status: 'SKIPPED', roomStatus: 'CLEAN' });
    const man = await ok(call('POST', hk(w, 'tasks'), sup.h, { roomId: w.room['103'], taskType: 'DEEP_CLEAN' }), 201);
    await code(call('POST', hk(w, `tasks/${man.id}/skip`), a1.h, { reason: 'Not needed' }), 422, 'NOT_SKIPPABLE');
    await ok(call('POST', hk(w, `tasks/${man.id}/cancel`), sup.h, { reason: 'Created by mistake' }));
    await code(call('POST', hk(w, `tasks/${man.id}/start`), a1.h, {}), 409, 'TASK_NOT_PENDING');
  });

  it('a room coming back from out-of-order gets a deep clean; arriving guests find a dirty room with an arrival-prep task', async () => {
    const w = await sunset();
    await setBd(w, '2026-11-04');
    await ok(call('POST', `/v1/properties/${w.pid}/room-blocks`, O, { roomId: w.room['105'], type: 'OUT_OF_ORDER', startDate: '2026-11-04', endDate: '2026-11-06', reason: 'Painting' }), 201);
    const arr = await book(w, { arrival: '2026-11-06', departure: '2026-11-07' });
    await ok(call('PUT', `/v1/properties/${w.pid}/reservations/${arr.id}/rooms/${arr.line}/assignment`, O, { roomId: w.room['104'] }));
    await adminDb.updateTable('room').set({ hk_status: 'DIRTY' }).where('id', '=', w.room['104']!).execute();
    await setBd(w, '2026-11-06');
    const g = await ok(call('POST', hk(w, 'generate'), O));
    expect(g).toMatchObject({ deepClean: 1, arrivalPrep: 1 });
    expect((await tasks(w, '105'))[0]).toMatchObject({ task_type: 'DEEP_CLEAN' });
    expect((await tasks(w, '104'))[0]).toMatchObject({ task_type: 'ARRIVAL_PREP', priority: 2 });
    expect((await roomRow(w, '105')).hk_status).toBe('DIRTY');
  });
});

describe('the board and the team', () => {
  it('shows rooms by state with tasks and workload, and lists the people who can be given work', async () => {
    const w = await sunset(); const sup = await staff(w, 'housekeeping_supervisor', 'Sana Supervisor'); const a1 = await staff(w, 'housekeeper', 'Bilal Attendant');
    await staff(w, 'kitchen_cook');                                                           // not an attendant
    const t1 = await ok(call('POST', hk(w, 'tasks'), sup.h, { roomId: w.room['101'] }), 201);
    const t2 = await ok(call('POST', hk(w, 'tasks'), sup.h, { roomId: w.room['102'], taskType: 'DEEP_CLEAN' }), 201);
    await ok(call('POST', hk(w, 'tasks'), sup.h, { roomId: w.room['103'] }), 201);
    await assign(w, [t1.id, t2.id], a1.id, sup.h);
    await ok(call('POST', hk(w, `tasks/${t1.id}/start`), a1.h, {})); await ok(call('POST', hk(w, `tasks/${t1.id}/finish`), a1.h, {}));
    const board = await ok(call('GET', hk(w, 'board'), sup.h));
    expect(board.rooms.map((r: any) => r.number)).toEqual(['101', '102', '103', '104', '105']);
    expect(board.summary).toMatchObject({ openTasks: 2, unassigned: 1, doneToday: 1, byStatus: { CLEAN: 5, DIRTY: 0 } });
    expect(board.workload).toEqual([{ userId: a1.id, name: 'Bilal Attendant', tasks: 2, credits: 2.5, done: 1 }]);
    expect(board.rooms[1].tasks[0]).toMatchObject({ type: 'DEEP_CLEAN', assignee: { name: 'Bilal Attendant' } });
    const team = (await ok(call('GET', hk(w, 'attendants'), sup.h))).items.map((x: any) => x.name);
    expect(team).toContain('Bilal Attendant'); expect(team).toContain('Sana Supervisor'); expect(team).toHaveLength(2);
    await code(call('POST', hk(w, `tasks/assign`), sup.h, { taskIds: [t2.id], assigneeId: (await staff(w, 'kitchen_cook')).id }), 422, 'NOT_AN_ATTENDANT');
  });
});

describe('issues and lost & found', () => {
  it('attendants report problems and found items; supervisors resolve and close them', async () => {
    const w = await sunset(); const a1 = await staff(w, 'housekeeper'); const sup = await staff(w, 'housekeeping_supervisor');
    const i = await ok(call('POST', hk(w, 'issues'), a1.h, { roomId: w.room['103'], category: 'AC', description: 'AC leaking water', priority: 2 }), 201);
    await ok(call('POST', hk(w, 'issues'), a1.h, { area: 'Corridor, first floor', category: 'ELECTRICAL', description: 'Light flickering' }), 201);
    expect((await call('POST', hk(w, 'issues'), a1.h, { category: 'AC', description: 'No room or area' })).statusCode).toBe(400);
    const open = (await ok(call('GET', hk(w, 'issues'), sup.h))).items;
    expect(open).toHaveLength(2); expect(open[0]).toMatchObject({ roomNumber: '103', category: 'AC', priority: 2 });
    await code(call('POST', hk(w, `issues/${i.id}/resolve`), a1.h, {}), 403, 'PERMISSION_DENIED');
    await ok(call('POST', hk(w, `issues/${i.id}/resolve`), sup.h, { note: 'Drain cleared' }));
    await code(call('POST', hk(w, `issues/${i.id}/resolve`), sup.h, {}), 409, 'NOT_OPEN');
    expect((await ok(call('GET', hk(w, 'issues'), sup.h))).items).toHaveLength(1);
    const lf = await ok(call('POST', hk(w, 'lost-found'), a1.h, { roomId: w.room['101'], item: 'Black phone charger' }), 201);
    expect((await ok(call('GET', hk(w, 'lost-found'), sup.h))).items[0]).toMatchObject({ item: 'Black phone charger', roomNumber: '101', status: 'FOUND' });
    await code(call('POST', hk(w, `lost-found/${lf.id}/close`), a1.h, { status: 'RETURNED' }), 403, 'PERMISSION_DENIED');
    await ok(call('POST', hk(w, `lost-found/${lf.id}/close`), sup.h, { status: 'RETURNED', note: 'Collected by guest' }));
    expect((await ok(call('GET', hk(w, 'lost-found'), sup.h))).items).toEqual([]);
  });
});

describe('access', () => {
  it('is limited to the property’s own staff, and attendants cannot supervise', async () => {
    const w = await sunset(); const other = await sunset(); const a1 = await staff(w, 'housekeeper'); const sup = await staff(w, 'housekeeping_supervisor');
    expect((await call('GET', hk(other, 'board'), sup.h)).statusCode).toBe(403);
    expect((await call('GET', hk(other, 'my-tasks'), a1.h)).statusCode).toBe(403);
    expect((await call('POST', hk(w, 'generate'), a1.h)).statusCode).toBe(403);
    expect((await call('POST', hk(w, 'tasks'), a1.h, { roomId: w.room['101'] })).statusCode).toBe(403);
    expect((await call('GET', hk(w, 'board'), a1.h)).statusCode).toBe(200);                    // attendants may look at the board
    const cook = await staff(w, 'kitchen_cook');
    expect((await call('GET', hk(w, 'board'), cook.h)).statusCode).toBe(403);
    expect((await call('GET', hk(w, 'board'), as(T.tenantId, T.ownerUserId)))).toBeDefined();
  });
});
