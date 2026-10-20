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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'audit'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@audit.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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

describe('the night audit closes a day', () => {
  it('posts the night, charges no-shows, expires options, snapshots the day, rolls the date and prepares tomorrow', async () => {
    const w = await sunset();
    at('2026-11-05', '10:00');
    const g1 = await book(w, { departure: '2026-11-07' }), g2 = await book(w, { departure: '2026-11-06' }), g3 = await book(w), hold = await book(w, { arrival: '2026-11-06', departure: '2026-11-07', hold: 30 });
    await setBd(w, '2026-11-05'); await checkIn(w, g1, '101'); await checkIn(w, g2, '102');
    // money in the day: cash (counted and closed), a wallet payment, a charge
    const s = await ok(call('POST', u(w, 'cashier/sessions'), O, { openingFloat: '1000' }), 201);
    await ok(call('POST', u(w, `reservations/${g1.id}/payments`), O, { method: 'CASH', amount: '5000' }, key()), 201);
    await ok(call('POST', u(w, `reservations/${g2.id}/payments`), O, { method: 'WALLET', amount: '2000', reference: 'JC-77' }, key()), 201);
    const fid = (await folioOf(w, g1)).folio.id as string;
    await ok(call('POST', u(w, `folios/${fid}/charges`), O, { txnCode: 'FNB', amount: '1500', description: 'Dinner' }), 201);
    await ok(call('POST', u(w, `cashier/sessions/${s.id}/close`), O, { counted: '6000' }));

    // before the audit
    at('2026-11-05', '23:40');
    const st = await ok(call('GET', u(w, 'night-audit/status'), O));
    expect(st).toMatchObject({ businessDate: '2026-11-05', canStart: true, needsOverride: [] });
    expect(st.exceptions.map((e: any) => e.kind)).toEqual(['ARRIVAL_PENDING']);                      // g3 has not arrived

    const run = await ok(audit(w));
    expect(run).toMatchObject({ businessDate: '2026-11-05', status: 'COMPLETED', resumedCount: 0 });
    expect(run.steps.map((x: any) => [x.key, x.status])).toEqual([['NO_SHOWS', 'DONE'], ['OPTIONS', 'DONE'], ['ROOM_CHARGES', 'DONE'], ['TAXES', 'DONE'], ['CLOSE_DAY', 'DONE']]);
    expect(run.steps[3].result).toMatchObject({ postings: 0, configured: false });                // no tax rates are configured, so nothing is added
    expect(run.steps[0].result).toMatchObject({ lines: 1 });
    expect(await bdOf(w)).toBe('2026-11-06');

    // the ledger
    const f1 = await folioOf(w, g1);
    expect(f1.postings.filter((p: any) => p.sourceType === 'ROOM_NIGHT').map((p: any) => [p.businessDate, p.amount.amount])).toEqual([['2026-11-05', '12000.00']]);
    expect(f1.folio.balance.amount).toBe('8500.00');                                                  // night + dinner − cash
    expect((await folioOf(w, g3)).postings.map((p: any) => [p.txnCode, p.amount.amount])).toEqual([['NOSHOW_FEE', '12000.00']]);
    expect((await ok(call('GET', u(w, `reservations/${g3.id}`), O))).status).toBe('NO_SHOW');
    expect((await ok(call('GET', u(w, `reservations/${hold.id}`), O))).status).toBe('CANCELLED');   // the unpaid hold expired

    // the immutable snapshot
    const rep = await ok(call('GET', u(w, 'night-audit/reports/2026-11-05'), O));
    expect(rep.occupancy).toEqual({ roomsTotal: 4, outOfOrder: 0, roomsAvailable: 4, roomsSold: 2, occupancyPct: 50 });
    expect(rep.revenue).toMatchObject({ room: { amount: '24000.00' }, fees: { amount: '12000.00' }, other: { amount: '1500.00' }, adr: { amount: '12000.00' }, revPar: { amount: '6000.00' } });
    expect(rep.movement).toMatchObject({ arrivals: 2, departures: 0, inHouse: 2, noShows: 1 });
    expect(rep.ledger).toMatchObject({ guestLedger: { amount: '30500.00' }, advanceDeposits: { amount: '0.00' } });   // 8,500 + 10,000 + 12,000 no-show fee
    expect(rep.paymentsByTender).toEqual({ PAY_CASH: { amount: '5000.00', currency: 'PKR' }, PAY_WALLET: { amount: '2000.00', currency: 'PKR' } });
    expect(rep.revenueLines.find((l: any) => l.txnCode === 'ROOM')).toMatchObject({ roomType: 'STD', source: 'PHONE', amount: { amount: '24000.00' } });
    expect(rep.lists.inHouse).toHaveLength(2); expect(rep.lists.noShows).toHaveLength(1); expect(rep.lists.arrivals).toHaveLength(2);
    expect(rep.cashierVariance.amount).toBe('0.00');
    await expect(adminDb.updateTable('daily_property_stats').set({ rooms_sold: 99 }).where('property_id', '=', w.pid).execute()).rejects.toThrow(/append-only/);
    await expect(adminDb.deleteFrom('daily_revenue_line').where('property_id', '=', w.pid).execute()).rejects.toThrow(/append-only/);

    // the closed day stays closed
    await expect(adminDb.insertInto('folio_posting').values({ tenant_id: T.tenantId, property_id: w.pid, folio_id: fid, posting_type: 'CHARGE', txn_code: 'MISC', amount_minor: '100', currency: 'PKR', business_date: '2026-11-05', source_type: 'MANUAL' } as never).execute()).rejects.toThrow(/closed/);
    const late = await code(call('POST', u(w, `folios/${fid}/charges`), O, { txnCode: 'MISC', amount: '100', description: 'Tomorrow' }).then(async (r) => { expect(r.statusCode).toBe(201); return call('POST', u(w, 'night-audit/runs'), O, {}); }), 409, 'AUDIT_BLOCKED');
    expect(late.needsOverride).toContain('EARLY_AUDIT');                                              // it is still the evening of the 5th on the clock

    // tomorrow is ready: the in-house guest gets a stay-over service, availability reaches one day further, the room is not counted twice
    const hk = await ok(call('GET', u(w, 'housekeeping/board'), O));
    expect(hk.businessDate).toBe('2026-11-06');
    const task = await adminDb.selectFrom('housekeeping_task').select(['task_type', 'business_date']).where('property_id', '=', w.pid).execute();
    expect(task).toEqual([{ task_type: 'STAYOVER', business_date: '2026-11-06' }]);
    const last = await adminDb.selectFrom('inventory_day').select('business_date').where('property_id', '=', w.pid).orderBy('business_date', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(last.business_date).toBe('2028-11-04');                                                    // two years ahead of the NEW business date
    const ev = (await adminDb.selectFrom('outbox_event').select('event_type').where('tenant_id', '=', T.tenantId).where('aggregate_id', '=', w.pid).execute()).map((e) => e.event_type);
    expect(ev).toEqual(expect.arrayContaining(['NightAuditCompleted', 'BusinessDateRolled']));
    expect((await ok(call('GET', u(w, 'folio-check'), O))).ok).toBe(true);
    expect((await ok(call('GET', u(w, 'inventory-check'), O))).issues).toEqual([]);
  });

  it('a second night: the checked-out guest is not charged again; the second audit needs the early-audit override on the same evening', async () => {
    const w = await sunset();
    at('2026-11-05', '10:00');
    const g1 = await book(w, { departure: '2026-11-07' }); await setBd(w, '2026-11-05'); await checkIn(w, g1, '101');
    at('2026-11-05', '23:30'); await ok(audit(w));
    await code(audit(w), 409, 'AUDIT_BLOCKED');                                                       // 6th not over yet
    at('2026-11-06', '23:30');
    await ok(audit(w));                                                                               // clock now past the 6th: no override needed
    expect(await bdOf(w)).toBe('2026-11-07');
    const f = await folioOf(w, g1);
    expect(f.postings.filter((p: any) => p.sourceType === 'ROOM_NIGHT').map((p: any) => p.businessDate)).toEqual(['2026-11-05', '2026-11-06']);
    const checkedOut = await checkOut(w, g1);
    expect(checkedOut.checkOut.folio.balance.amount).toBe('24000.00');                                // both nights were posted by the two audits, none twice
    const days = (await ok(call('GET', u(w, 'night-audit/reports'), O))).items;
    expect(days.map((d: any) => d.businessDate)).toEqual(['2026-11-06', '2026-11-05']);
    expect(days[0]).toMatchObject({ roomsSold: 1, inHouse: 1 });
  });
});

describe('blocking exceptions', () => {
  it('open cashier sessions can never be skipped; overdue departures, early audits and ledger problems need a manager’s override with a reason', async () => {
    const w = await sunset(); const auditor = await staff(w, 'night_auditor'); const gm = await staff(w, 'general_manager');
    at('2026-11-05', '10:00');
    const g1 = await book(w, { departure: '2026-11-06' }); await setBd(w, '2026-11-05'); await checkIn(w, g1, '101');
    const s = await ok(call('POST', u(w, 'cashier/sessions'), O, { openingFloat: '0' }), 201);
    at('2026-11-06', '23:30'); await setBd(w, '2026-11-06');                                          // the 6th: g1 should have left
    const blocked = await code(audit(w, {}, auditor.h), 409, 'AUDIT_BLOCKED');
    expect(blocked.cannotOverride).toEqual(['OPEN_CASHIER_SESSION']); expect(blocked.needsOverride).toEqual(['DEPARTURE_OVERDUE']);
    await code(audit(w, { overrides: [{ kind: 'OPEN_CASHIER_SESSION', reason: 'Just this once please' }, { kind: 'DEPARTURE_OVERDUE', reason: 'Guest extending' }] }, gm.hm), 409, 'AUDIT_BLOCKED');
    await ok(call('POST', u(w, `cashier/sessions/${s.id}/close`), O, { counted: '0' }));
    const st = await ok(call('GET', u(w, 'night-audit/status'), auditor.h));
    expect(st).toMatchObject({ canStart: true, needsOverride: ['DEPARTURE_OVERDUE'] });
    expect(st.exceptions[0].items[0]).toMatchObject({ room: '101', departure: '2026-11-06' });
    await code(audit(w, {}, auditor.h), 409, 'AUDIT_BLOCKED');                                         // no override given
    await code(audit(w, { overrides: [{ kind: 'DEPARTURE_OVERDUE', reason: 'ab' }] }, gm.hm), 400, 'VALIDATION_FAILED');     // reason too short
    await code(audit(w, { overrides: [{ kind: 'DEPARTURE_OVERDUE', reason: 'Guest is extending' }] }, auditor.hm), 403, 'PERMISSION_DENIED');   // an auditor cannot override
    await code(audit(w, { overrides: [{ kind: 'DEPARTURE_OVERDUE', reason: 'Guest is extending' }] }, gm.h), 403, 'MFA_REQUIRED');
    const run = await ok(audit(w, { overrides: [{ kind: 'DEPARTURE_OVERDUE', reason: 'Guest is extending' }] }, gm.hm));
    expect(run.status).toBe('COMPLETED'); expect(run.overrides).toEqual([{ kind: 'DEPARTURE_OVERDUE', reason: 'Guest is extending' }]);
    const logged = await adminDb.selectFrom('audit_log').select(['reason_code', 'note']).where('tenant_id', '=', T.tenantId).where('action', '=', 'night_audit.start').where('resource_id', '=', run.id).executeTakeFirstOrThrow();
    expect(logged).toMatchObject({ reason_code: 'AUDIT_OVERRIDE' }); expect(logged.note).toContain('Guest is extending');
  });

  it('only staff with the night-audit permission can see or start it', async () => {
    const w = await sunset(); const fd = await staff(w, 'front_desk_agent'); const other = await sunset(); const auditor = await staff(other, 'night_auditor');
    expect((await call('GET', u(w, 'night-audit/status'), fd.h)).statusCode).toBe(403);
    expect((await audit(w, {}, fd.h)).statusCode).toBe(403);
    expect((await call('GET', u(w, 'night-audit/status'), auditor.h)).statusCode).toBe(403);           // an auditor of another property
    expect((await call('GET', u(w, 'night-audit/reports/2026-11-01'), O)).statusCode).toBe(404);       // a day that was never closed
  });
});

describe('failure, resume and concurrency', () => {
  it('a failed step stops the audit cleanly; fixing the cause and starting again resumes at that step without repeating the earlier ones', async () => {
    const w = await sunset();
    at('2026-11-05', '10:00');
    const g1 = await book(w, { departure: '2026-11-07' }); const g3 = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, g1, '101');
    const fid = (await folioOf(w, g1)).folio.id as string;
    await adminDb.updateTable('folio').set({ status: 'CLOSED' }).where('id', '=', fid).execute();      // something is wrong with a guest's folio
    at('2026-11-05', '23:40');
    const failed = await code(audit(w), 500, 'AUDIT_STEP_FAILED');
    expect(failed).toMatchObject({ step: 'ROOM_CHARGES' });
    expect(await bdOf(w)).toBe('2026-11-05');                                                         // the date did not move
    const runs = (await ok(call('GET', u(w, 'night-audit/runs'), O))).items;
    expect(runs).toHaveLength(1); expect(runs[0]).toMatchObject({ status: 'FAILED' });
    const view = await ok(call('GET', u(w, `night-audit/runs/${failed.runId}`), O));
    expect(view.steps.map((s: any) => [s.key, s.status])).toEqual([['NO_SHOWS', 'DONE'], ['OPTIONS', 'DONE'], ['ROOM_CHARGES', 'FAILED'], ['TAXES', 'PENDING'], ['CLOSE_DAY', 'PENDING']]);
    expect(view.steps[2].error).toMatch(/FOLIO_NOT_OPEN/);
    expect((await ok(call('GET', u(w, `reservations/${g3.id}`), O))).status).toBe('NO_SHOW');         // the no-show step did finish
    await adminDb.updateTable('folio').set({ status: 'OPEN' }).where('id', '=', fid).execute();        // the cause is fixed
    const run = await ok(audit(w));
    expect(run).toMatchObject({ status: 'COMPLETED', resumedCount: 1 });
    expect(run.steps.map((s: any) => [s.key, s.attempts])).toEqual([['NO_SHOWS', 1], ['OPTIONS', 1], ['ROOM_CHARGES', 2], ['TAXES', 1], ['CLOSE_DAY', 1]]);
    expect(await bdOf(w)).toBe('2026-11-06');
    expect((await adminDb.selectFrom('folio_posting').select('id').where('folio_id', '=', fid).where('txn_code', '=', 'ROOM').execute())).toHaveLength(1);      // charged once
    expect((await adminDb.selectFrom('folio_posting').select('id').where('txn_code', '=', 'NOSHOW_FEE').where('property_id', '=', w.pid).execute())).toHaveLength(1);   // fee once
  });

  it('two people starting the audit at once close the day exactly once', async () => {
    const w = await sunset();
    at('2026-11-05', '10:00');
    const g1 = await book(w, { departure: '2026-11-07' }); await setBd(w, '2026-11-05'); await checkIn(w, g1, '101');
    at('2026-11-05', '23:40');
    const [a, b] = await Promise.all([audit(w), audit(w)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(200); expect(codes[1]).toBeGreaterThanOrEqual(409);
    expect(await bdOf(w)).toBe('2026-11-06');                                                         // rolled once, not twice
    expect((await adminDb.selectFrom('night_audit_run').select('status').where('property_id', '=', w.pid).execute())).toEqual([{ status: 'COMPLETED' }]);
    expect((await adminDb.selectFrom('daily_property_stats').select('business_date').where('property_id', '=', w.pid).execute())).toHaveLength(1);
    expect((await adminDb.selectFrom('folio_posting').select('id').where('property_id', '=', w.pid).where('txn_code', '=', 'ROOM').execute())).toHaveLength(1);
  });

  it('a stalled run (the server died mid-audit) is picked up by the next start; a fresh running one is left alone', async () => {
    const w = await sunset();
    at('2026-11-05', '10:00');
    const g1 = await book(w, { departure: '2026-11-07' }); await setBd(w, '2026-11-05'); await checkIn(w, g1, '101');
    at('2026-11-05', '23:40');
    const run = await adminDb.insertInto('night_audit_run').values({ tenant_id: T.tenantId, property_id: w.pid, business_date: '2026-11-05', status: 'RUNNING', started_by: T.ownerUserId, started_at: new Date(testClock.now()), updated_at: new Date(testClock.now()) } as never).returning('id').executeTakeFirstOrThrow();
    await adminDb.insertInto('night_audit_step').values(['NO_SHOWS', 'OPTIONS', 'ROOM_CHARGES', 'TAXES', 'CLOSE_DAY'].map((k, i) => ({ tenant_id: T.tenantId, run_id: run.id, step_key: k, seq: i + 1, status: i === 0 ? 'DONE' : 'PENDING' })) as never).execute();
    await code(audit(w), 409, 'AUDIT_RUNNING');                                                       // looks alive
    at('2026-11-05', '23:50');                                                                         // ten minutes later nothing has moved
    const r = await ok(audit(w));
    expect(r).toMatchObject({ id: run.id, status: 'COMPLETED', resumedCount: 1 });
    expect(await bdOf(w)).toBe('2026-11-06');
  });
});

describe('the posting freeze', () => {
  it('a posting that arrives while the day is being closed waits, then is refused for the closed date — it can never slip into a closed day', async () => {
    const w = await sunset();
    at('2026-11-05', '10:00');
    const g1 = await book(w, { departure: '2026-11-07' }); await setBd(w, '2026-11-05'); await checkIn(w, g1, '101');
    const fid = (await folioOf(w, g1)).folio.id as string;
    // hold the closing lock the way the audit's last step does, try to post for the day meanwhile
    const { createDb } = await import('@hos/db');
    const holder = createDb(process.env.DATABASE_URL_ADMIN!, 1);
    const tx = holder.transaction().execute(async (trx) => {
      await trx.selectFrom('property').select('id').where('id', '=', w.pid).forUpdate().executeTakeFirstOrThrow();
      await new Promise((r) => setTimeout(r, 400));
      await trx.updateTable('property').set({ business_date: '2026-11-06' }).where('id', '=', w.pid).execute();
    });
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    const r = await call('POST', u(w, `folios/${fid}/charges`), O, { txnCode: 'MISC', amount: '100', description: 'Racing the audit' });
    await tx; await holder.destroy();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);                                         // it waited for the lock
    expect(r.statusCode).toBe(409); expect(r.json().code).toBe('BUSINESS_DATE_CLOSED');               // then found the day closed and was refused
    expect((await adminDb.selectFrom('folio_posting').select('id').where('folio_id', '=', fid).where('txn_code', '=', 'MISC').execute())).toHaveLength(0);
    const again = await ok(call('POST', u(w, `folios/${fid}/charges`), O, { txnCode: 'MISC', amount: '100', description: 'Retry' }), 201);   // a retry lands on the new day
    expect((await adminDb.selectFrom('folio_posting').select('business_date').where('id', '=', again.postingId).executeTakeFirstOrThrow()).business_date).toBe('2026-11-06');
  });
});
