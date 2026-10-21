import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'wd'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

async function sunset() {
  const pcode = `FD${++n}`;
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: pcode, name: `Desk ${pcode}` })).json().id as string;
  const rt: Record<string, string> = {};
  for (const [c, nm] of [['STD', 'Standard'], ['DLX', 'Deluxe']] as const) rt[c] = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: c, name: nm, maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt.STD, from: 101, to: 103 });
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt.DLX, from: 201, to: 202 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'Best Available (local)', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [
    { roomTypeId: rt.STD, amount: '12000', extraAdult: '3000', extraChild: '1500' }, { roomTypeId: rt.DLX, amount: '15000', extraAdult: '3500', extraChild: '1500' }] });
  const intl = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'INTL', name: 'International', residency: 'NON_RESIDENT', ...rules, derive: { parentPlanId: bar, type: 'PERCENT', value: 2500, roundTo: '100' } })).json().id as string;
  const rooms = (await call('GET', `/v1/properties/${pid}/rooms`, O)).json().items as Array<{ id: string; number: string }>;
  const room = Object.fromEntries(rooms.map((r) => [r.number, r.id])) as Record<string, string>;
  return { pid, rt, bar, intl, room };
}
type W = Awaited<ReturnType<typeof sunset>>;
const setBd = (w: W, d: string) => adminDb.updateTable('property').set({ business_date: d }).where('id', '=', w.pid).execute();
const url = (w: W, rid: string, lid: string, tail: string) => `/v1/properties/${w.pid}/reservations/${rid}/rooms/${lid}/${tail}`;
const cnic = (k = 1) => `3520212345${String(670 + k).padStart(3, '0')}`;
const occ = (o: Record<string, unknown> = {}) => ({ fullName: `Guest ${++n}`, idType: 'CNIC', idNumber: cnic(n % 300), nationality: 'PK', ...o });

/** Books via quote → reservation (arrival defaults to 5 Nov, 2 nights). */
async function book(w: W, o: { room?: string; plan?: string; arrival?: string; departure?: string; adults?: number; children?: number; nationality?: string } = {}) {
  const q = (await call('POST', `/v1/properties/${w.pid}/quotes`, O, { arrival: o.arrival ?? '2026-11-05', departure: o.departure ?? '2026-11-07', adults: o.adults ?? 2, children: o.children ?? 0, residency: o.nationality && o.nationality !== 'PK' ? 'NON_RESIDENT' : 'RESIDENT' })).json();
  const opt = q.options.find((x: any) => x.roomType.code === (o.room ?? 'STD') && x.plan.code === (o.plan ?? 'BAR'));
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Booker ${++n}`, phone: `0300${String(2000000 + n).slice(-7)}`, nationality: o.nationality ?? 'PK' }), 201);
  const r = await ok(call('POST', `/v1/properties/${w.pid}/reservations`, O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: opt.quoteToken }] }, { 'idempotency-key': `fd-${++n}-${Date.now()}` }), 201);
  return { id: r.id as string, line: r.lines[0].id as string, res: r };
}
const checkIn = (w: W, b: { id: string; line: string }, room: string | undefined, o: Record<string, unknown> = {}, h = O) =>
  call('POST', url(w, b.id, b.line, 'check-in'), h, { roomId: room ? w.room[room] : undefined, occupants: [occ({ isPrimary: true }), ...(o.extra as unknown[] ?? [])], ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'extra')) });
const issues = async (w: W) => (await call('GET', `/v1/properties/${w.pid}/inventory-check`, O)).json().issues as Array<{ kind: string }>;
const avail = async (w: W, code: string, d: string) => {
  const r = (await call('GET', `/v1/properties/${w.pid}/availability?from=${d}&to=${d.slice(0, 8)}${String(Number(d.slice(8)) + 1).padStart(2, '0')}`, O)).json();
  return r.roomTypes.find((x: any) => x.code === code).nights[0];
};


const bdate = (w: W, d: string) => setBd(w, d);
const today = (w: W, h = O) => call('GET', `/v1/properties/${w.pid}/today`, h);
const folioOf = async (w: W, rid: string) => (await call('GET', `/v1/properties/${w.pid}/reservations/${rid}/folio`, O)).json().folio.id as string;

describe('today queue', () => {
  it('lists arrivals with the problems that would stop a check-in, worst first', async () => {
    const w = await sunset(); const a = await book(w, { arrival: OPEN, departure: '2026-11-03' }); const b = await book(w, { arrival: OPEN, departure: '2026-11-03' });
    let t = await ok(today(w));
    expect(t.businessDate).toBe(OPEN); expect(t.summary).toMatchObject({ arrivalsPending: 2, arrivalsWithProblems: 2 });
    const row = (rid: string) => t.arrivals.find((x: any) => x.reservationId === rid);
    expect(row(a.id).blockers.map((x: any) => x.code)).toContain('NO_ROOM');
    await ok(call('PUT', `${url(w, a.id, a.line, 'assignment')}`, O, { roomId: w.room['101'] }));
    await adminDb.updateTable('room').set({ hk_status: 'DIRTY' }).where('id', '=', w.room['101']).execute();
    t = await ok(today(w));
    expect(row(a.id).blockers[0]).toEqual({ code: 'ROOM_NOT_READY', level: 'BLOCKER' });
    expect(row(a.id).blockers.map((x: any) => x.code)).not.toContain('NO_ROOM');
    await adminDb.updateTable('room').set({ hk_status: 'CLEAN' }).where('id', '=', w.room['101']).execute();
    t = await ok(today(w));
    expect(row(a.id).blockers.map((x: any) => x.code)).toEqual(['AT_RISK']);                          // fixed: the room blockers are gone by themselves; the unguaranteed booking remains
    expect(row(b.id).blockers.some((x: any) => x.code === 'NO_ROOM')).toBe(true);
  });

  it('shows what a departing guest still owes', async () => {
    const w = await sunset(); const b = await book(w, { arrival: OPEN, departure: '2026-11-03' });
    await ok(checkIn(w, b, '101'));
    const fid = await folioOf(w, b.id);
    await ok(call('POST', `/v1/properties/${w.pid}/folios/${fid}/charges`, O, { txnCode: 'FNB', amount: '2500', description: 'Dinner' }), 201);
    await bdate(w, '2026-11-03');
    const t = await ok(today(w));
    const d = t.departures.find((x: any) => x.reservationId === b.id);
    expect(d.blockers.find((x: any) => x.code === 'BALANCE_DUE')).toMatchObject({ level: 'ACTION' });
    expect(Number(d.blockers.find((x: any) => x.code === 'BALANCE_DUE').amount.amount)).toBeGreaterThan(0);
    expect(t.summary.departuresWithProblems).toBe(1);
  });

  it('lists a guest who changed rooms once, in the room they are in now', async () => {
    const w = await sunset(); const b = await book(w, { arrival: OPEN, departure: '2026-11-03' });
    await ok(checkIn(w, b, '101'));
    await ok(call('POST', url(w, b.id, b.line, 'move'), OM, { roomId: w.room['102'], reason: 'test: move' }));
    await bdate(w, '2026-11-03');
    const t = await ok(today(w));
    const rows = t.departures.filter((x: any) => x.reservationId === b.id);
    expect(rows).toHaveLength(1); expect(rows[0].room).toBe('102');
    expect(t.summary.departuresPending).toBe(1);
  });

  it('is limited to people who may see reservations', async () => {
    const w = await sunset();
    const hk = await addUser(T.tenantId, `hk${++n}@wd.test`); await assignRole(T.tenantId, hk, 'housekeeper', 'PROPERTY', w.pid);
    await code(today(w, as(T.tenantId, hk)), 403, 'PERMISSION_DENIED');
  });
});

describe('inbox', () => {
  it('collects the same blockers into one list for the desk, with counts', async () => {
    const w = await sunset(); await book(w, { arrival: OPEN, departure: '2026-11-03' });
    const r = await ok(call('GET', `/v1/properties/${w.pid}/inbox`, O));
    expect(r.items.some((i: any) => i.kind === 'NO_ROOM')).toBe(true);
    expect(r.summary.total).toBe(r.items.length);
    const ranks = r.items.map((i: any) => ({ BLOCKER: 0, ACTION: 1, INFO: 2 } as any)[i.level]);
    expect([...ranks].sort()).toEqual(ranks);                                                    // most urgent first
  });

  it('shows a housekeeper only what is theirs: no reservations, no money', async () => {
    const w = await sunset(); await book(w, { arrival: OPEN, departure: '2026-11-03' });
    const hk = await addUser(T.tenantId, `hk${++n}@wd.test`); await assignRole(T.tenantId, hk, 'housekeeper', 'PROPERTY', w.pid);
    const r = await ok(call('GET', `/v1/properties/${w.pid}/inbox`, as(T.tenantId, hk)));
    expect(r.items.filter((i: any) => ['NO_ROOM', 'BALANCE_DUE', 'PAYMENT_TO_VERIFY'].includes(i.kind))).toEqual([]);
  });

  it('refuses someone with no sign-in', async () => {
    const w = await sunset();
    await code(call('GET', `/v1/properties/${w.pid}/inbox`, {}), 401, 'UNAUTHENTICATED');
  });
});
