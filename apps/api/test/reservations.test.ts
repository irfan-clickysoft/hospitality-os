import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { zonedToUtcMs } from '@hos/domain-types';
import { ReservationsService } from '../src/reservations/reservations.service.js';
import { runWithTenant } from '../src/tenancy/tenant-context.js';
import { addUser, adminDb, as, assignRole, createTestApp, provision, testClock } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
let O: Record<string, string>, OM: Record<string, string>;
const OPEN = '2026-11-01';                 // Sun. Thu 5 · Fri 6 · Sat 7 · Sun 8 · Mon 9 · Tue 10
let n = 0;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...headers, ...extra }, payload: body as object | undefined });
const karachi = (date: string, time: string) => zonedToUtcMs(date, time, 'Asia/Karachi');

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'resv'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

/** A live Boulevard-shaped property: STD/DLX/EXE × 3 rooms, BAR + INTL plans with the 72 h / 1 night / first-night-deposit rules. */
async function sunset() {
  const code = `RS${++n}`;
  const p = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code, name: `Resv ${code}` })).json();
  const pid = p.id as string;
  const rt: Record<string, string> = {};
  for (const [c, nm] of [['STD', 'Standard'], ['DLX', 'Deluxe'], ['EXE', 'Executive']] as const) rt[c] = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: c, name: nm, maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id;
  const first = { STD: 101, DLX: 201, EXE: 301 };
  for (const c of ['STD', 'DLX', 'EXE'] as const) await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt[c], from: first[c], to: first[c] + 2 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'Best Available (local)', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [
    { roomTypeId: rt.STD, amount: '12000', weekendAmount: '15000', extraAdult: '3000', extraChild: '1500' }, { roomTypeId: rt.DLX, amount: '15000', extraAdult: '3500', extraChild: '1500' },
    { roomTypeId: rt.EXE, amount: '20000', weekendAmount: '24000', extraAdult: '4000', extraChild: '2000' }] });
  const intl = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'INTL', name: 'International', residency: 'NON_RESIDENT', ...rules, derive: { parentPlanId: bar, type: 'PERCENT', value: 2500, roundTo: '100' } })).json().id as string;
  return { pid, rt, bar, intl };
}
type W = Awaited<ReturnType<typeof sunset>>;

const guestBody = (o: Record<string, unknown> = {}) => ({ fullName: `Guest ${++n}`, phone: `0300${String(1000000 + n).slice(-7)}`, nationality: 'PK', ...o });
async function newGuest(o: Record<string, unknown> = {}, h = O) { const r = await call('POST', '/v1/guests', h, guestBody(o)); expect(r.statusCode, r.body).toBe(201); return r.json().id as string; }
async function quoteOpt(w: W, room: string, plan: string, o: Record<string, unknown> = {}, h = O) {
  const q = await call('POST', `/v1/properties/${w.pid}/quotes`, h, { arrival: '2026-11-05', departure: '2026-11-07', adults: 2, ...o });
  expect(q.statusCode, q.body).toBe(200);
  const opt = q.json().options.find((x: any) => x.roomType.code === room && x.plan.code === plan);
  expect(opt, `${room}/${plan} option`).toBeDefined();
  return opt;
}
async function book(w: W, o: { room?: string; plan?: string; quote?: Record<string, unknown>; body?: Record<string, unknown>; h?: Record<string, string>; key?: string; guestId?: string } = {}) {
  const opt = await quoteOpt(w, o.room ?? 'STD', o.plan ?? 'BAR', o.quote ?? {}, o.h ?? O);
  const guestId = o.guestId ?? await newGuest({}, o.h ?? O);
  return call('POST', `/v1/properties/${w.pid}/reservations`, o.h ?? O, { guestId, source: 'PHONE', lines: [{ quoteToken: opt.quoteToken }], ...(o.body ?? {}) }, { 'idempotency-key': o.key ?? `key-${++n}-${Date.now()}` });
}
const avail = async (w: W, code: string, d: string) => {
  const r = (await call('GET', `/v1/properties/${w.pid}/availability?from=${d}&to=${d.slice(0, 8)}${String(Number(d.slice(8)) + 1).padStart(2, '0')}`, O)).json();
  return r.roomTypes.find((x: any) => x.code === code).nights[0];
};
const issues = async (w: W) => (await call('GET', `/v1/properties/${w.pid}/inventory-check`, O)).json().issues as Array<{ kind: string }>;
const ok = async (r: Promise<any>, status = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json(); };

describe('guests', () => {
  it('creates a guest, derives residency from nationality, and normalises the phone', async () => {
    const g = await ok(call('POST', '/v1/guests', O, { fullName: '  Ayesha Khan ', phone: '0321-5551234', nationality: 'pk', email: 'ayesha@example.com' }), 201);
    expect(g).toMatchObject({ fullName: 'Ayesha Khan', nationality: 'PK', residency: 'RESIDENT' });
    const f = await ok(call('POST', '/v1/guests', O, { fullName: 'John Smith', phone: '+44 7700 900123', nationality: 'GB' }), 201);
    expect(f.residency).toBe('NON_RESIDENT');
  });
  it('warns about duplicates by phone (any format) or email, and lets staff confirm it is a different person', async () => {
    await ok(call('POST', '/v1/guests', O, { fullName: 'Bilal Ahmed', phone: '0333 1112223' }), 201);
    const dup = await call('POST', '/v1/guests', O, { fullName: 'Bilal A.', phone: '+92 333 1112223' });
    expect(dup.statusCode).toBe(409); expect(dup.json().code).toBe('DUPLICATE_GUEST'); expect(dup.json().candidates[0].fullName).toBe('Bilal Ahmed');
    await ok(call('POST', '/v1/guests', O, { fullName: 'Bilal A.', phone: '+92 333 1112223', allowDuplicate: true }), 201);
  });
  it('searches by name (fuzzy), phone in any format, and email', async () => {
    const g = await ok(call('POST', '/v1/guests', O, { fullName: 'Zainab Siddiqui', phone: '0345-7776543', email: 'zainab.s@example.com' }), 201);
    for (const q of ['zainab', 'Zaynab Sidiqui', '03457776543', '+92 345 7776543', 'zainab.s@example.com']) {
      const r = await ok(call('GET', `/v1/guests/search?q=${encodeURIComponent(q)}`, O));
      expect(r.items.map((x: any) => x.id), q).toContain(g.id);
    }
    expect((await ok(call('GET', '/v1/guests/search?q=z', O))).items).toEqual([]);
  });
  it('is reachable by property-scoped front desk, not by housekeeping; stale edits are refused', async () => {
    const w = await sunset();
    const fd = await addUser(T.tenantId, `fd${++n}@resv.test`); await assignRole(T.tenantId, fd, 'front_desk_agent', 'PROPERTY', w.pid);
    const hk = await addUser(T.tenantId, `hk${++n}@resv.test`); await assignRole(T.tenantId, hk, 'housekeeper', 'PROPERTY', w.pid);
    const id = await newGuest({}, as(T.tenantId, fd));
    expect((await call('GET', `/v1/guests/${id}`, as(T.tenantId, hk))).statusCode).toBe(403);
    const g = (await call('GET', `/v1/guests/${id}`, as(T.tenantId, fd))).json();
    expect((await call('PATCH', `/v1/guests/${id}`, O, { vip: true, version: g.version })).statusCode).toBe(200);
    expect((await call('PATCH', `/v1/guests/${id}`, O, { vip: false, version: g.version })).statusCode).toBe(412);
  });
});

describe('booking', () => {
  it('books from a signed quote: takes the rooms, snapshots prices and policy, numbers the booking, records history/audit/events', async () => {
    const w = await sunset();
    const before = await avail(w, 'STD', '2026-11-05');
    const r = await ok(book(w, { body: { notesGuest: 'Late arrival', externalRef: 'BK-123' } }), 201);
    expect(r.confirmationNo).toMatch(/^RS\d+-26\d{5}$/);
    expect(r).toMatchObject({ status: 'CONFIRMED', channel: 'DIRECT', residency: 'RESIDENT', totalExTax: { amount: '27000.00' }, guarantee: { atRisk: true, depositRequired: { amount: '12000.00' } } });
    expect(r.lines[0]).toMatchObject({ lineNo: 1, status: 'CONFIRMED', nights: 2, total: { amount: '27000.00' }, depositDue: { amount: '12000.00' } });
    expect(r.lines[0].nightPrices.map((x: any) => x.total)).toEqual(['12000.00', '15000.00']);
    expect(r.lines[0].policy.cancellationRule).toMatchObject({ freeUntilHoursBefore: 72 });          // snapshot of the rule at booking time
    expect(r.history[0]).toMatchObject({ action: 'CREATE', to: 'CONFIRMED' });
    expect((await avail(w, 'STD', '2026-11-05')).reserved).toBe(before.reserved + 1);
    expect((await avail(w, 'STD', '2026-11-07')).reserved).toBe(0);                                  // departure date is not a night
    const actions = (await adminDb.selectFrom('audit_log').select('action').where('tenant_id', '=', T.tenantId).where('resource_id', '=', r.id).execute()).map((a) => a.action);
    expect(actions).toContain('reservation.create');
    const ev = (await adminDb.selectFrom('outbox_event').select('event_type').where('tenant_id', '=', T.tenantId).where('aggregate_id', '=', r.id).execute()).map((e) => e.event_type);
    expect(ev).toEqual(expect.arrayContaining(['ReservationCreated', 'ReservationConfirmed']));
    expect(await issues(w)).toEqual([]);
  });

  it('flags an unguaranteed booking as at-risk with a deposit deadline (the PayFast guarantee flow starts here); walk-ins are not', async () => {
    const w = await sunset();
    testClock.set(karachi('2026-11-02', '10:00'));
    const r = await ok(book(w, { quote: { channel: 'OTA' }, body: { source: 'OTA_BOOKING_COM', externalRef: 'BK-998877' } }), 201);
    expect(r.guarantee).toMatchObject({ type: 'NONE', atRisk: true, depositRequired: { amount: '12000.00' } });
    expect(new Date(r.guarantee.deadline).getTime()).toBe(karachi('2026-11-02', '10:00') + 24 * 3_600_000);
    const walk = await ok(book(w, { quote: { channel: 'WALKIN', arrival: '2026-11-05', departure: '2026-11-06' }, body: { source: 'WALK_IN' } }), 201);
    expect(walk.guarantee).toMatchObject({ atRisk: false, depositRequired: { amount: '0.00' } });
    const risky = await ok(call('GET', `/v1/properties/${w.pid}/reservations?atRisk=true`, O));
    expect(risky.items.map((x: any) => x.confirmationNo)).toEqual([r.confirmationNo]);
  });

  it('is idempotent: a retry returns the same reservation and takes the room once; a different request with the same key is refused', async () => {
    const w = await sunset();
    const opt = await quoteOpt(w, 'STD', 'BAR');
    const guestId = await newGuest();
    const body = { guestId, source: 'PHONE', lines: [{ quoteToken: opt.quoteToken }] };
    const key = `idem-${++n}-${Date.now()}`;
    const first = await call('POST', `/v1/properties/${w.pid}/reservations`, O, body, { 'idempotency-key': key });
    const again = await call('POST', `/v1/properties/${w.pid}/reservations`, O, body, { 'idempotency-key': key });
    expect(first.statusCode).toBe(201); expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id); expect(again.json().replayed).toBe(true);
    expect((await avail(w, 'STD', '2026-11-05')).reserved).toBe(1);
    const other = await call('POST', `/v1/properties/${w.pid}/reservations`, O, { ...body, notesGuest: 'different' }, { 'idempotency-key': key });
    expect(other.statusCode).toBe(422); expect(other.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    const missing = await call('POST', `/v1/properties/${w.pid}/reservations`, O, body);
    expect(missing.statusCode).toBe(400); expect(missing.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('creates the guest inside the booking transaction, and rolls the guest back if the booking fails', async () => {
    const w = await sunset();
    const opt = await quoteOpt(w, 'STD', 'BAR');
    const r = await ok(call('POST', `/v1/properties/${w.pid}/reservations`, O, { guest: guestBody({ fullName: 'Walk In Guest' }), source: 'WALK_IN', lines: [{ quoteToken: opt.quoteToken }] }, { 'idempotency-key': `g-${++n}-${Date.now()}` }), 201);
    expect(r.guest.fullName).toBe('Walk In Guest');
    const forged = await call('POST', `/v1/properties/${w.pid}/reservations`, O, { guest: guestBody({ fullName: 'Orphan Check' }), source: 'PHONE', lines: [{ quoteToken: opt.quoteToken.slice(0, -4) + 'AAAA' }] }, { 'idempotency-key': `g-${++n}-${Date.now()}` });
    expect(forged.statusCode).toBe(422);
    expect((await ok(call('GET', '/v1/guests/search?q=Orphan%20Check', O))).items).toEqual([]);
  });

  it('books several rooms on one reservation (a group of two Deluxe and one Executive) and keeps one set of counters', async () => {
    const w = await sunset();
    const [a, b, c] = [await quoteOpt(w, 'DLX', 'BAR'), await quoteOpt(w, 'DLX', 'BAR'), await quoteOpt(w, 'EXE', 'BAR')];
    const r = await ok(call('POST', `/v1/properties/${w.pid}/reservations`, O, { guestId: await newGuest(), source: 'PHONE', lines: [a, b, c].map((x) => ({ quoteToken: x.quoteToken })) }, { 'idempotency-key': `m-${++n}-${Date.now()}` }), 201);
    expect(r.lines).toHaveLength(3);
    expect(r.totalExTax.amount).toBe('104000.00');                                                       // 30,000 + 30,000 + 44,000
    expect((await avail(w, 'DLX', '2026-11-05')).reserved).toBe(2);
    expect((await avail(w, 'EXE', '2026-11-05')).reserved).toBe(1);
    expect(await issues(w)).toEqual([]);
  });

  it('refuses tampered, expired, foreign and stale quotes — the client never chooses the price', async () => {
    const w = await sunset(), w2 = await sunset();
    const opt = await quoteOpt(w, 'STD', 'BAR');
    const guestId = await newGuest();
    const post = (token: string, pid = w.pid) => call('POST', `/v1/properties/${pid}/reservations`, O, { guestId, source: 'PHONE', lines: [{ quoteToken: token }] }, { 'idempotency-key': `q-${++n}-${Date.now()}` });
    expect((await post(opt.quoteToken.slice(0, -4) + 'AAAA')).json().code).toBe('QUOTE_INVALID');
    const [body, sig] = opt.quoteToken.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), subtotalMinor: '100' })).toString('base64url');
    expect((await post(`${forged}.${sig}`)).json().code).toBe('QUOTE_INVALID');
    expect((await post(opt.quoteToken, w2.pid)).json().code).toBe('QUOTE_INVALID');                      // a quote for property A cannot book property B
    // rates change after the quote → the booking is refused with the new price, nothing is taken
    await call('POST', `/v1/properties/${w.pid}/rate-plans/${w.bar}/overrides`, O, { roomTypeId: w.rt.STD, from: '2026-11-05', to: '2026-11-06', amount: '12500' });
    const stale = await post(opt.quoteToken);
    expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe('PRICE_CHANGED'); expect(stale.json().newTotal.amount).toBe('27500.00');
    expect((await avail(w, 'STD', '2026-11-05')).reserved).toBe(0);
    // expiry
    const fresh = await quoteOpt(w, 'DLX', 'BAR');
    testClock.set(Date.now() + 16 * 60_000);
    expect((await post(fresh.quoteToken)).json().code).toBe('QUOTE_INVALID');
  });

  it('enforces the dual-price rule: a foreign guest cannot be booked on the local rate, and "do not rent" guests are blocked', async () => {
    const w = await sunset();
    const foreigner = await newGuest({ nationality: 'GB', phone: '+44 7700 900999' });
    const opt = await quoteOpt(w, 'STD', 'BAR');                                                          // local rate
    const r = await call('POST', `/v1/properties/${w.pid}/reservations`, O, { guestId: foreigner, source: 'PHONE', lines: [{ quoteToken: opt.quoteToken }] }, { 'idempotency-key': `r-${++n}-${Date.now()}` });
    expect(r.statusCode).toBe(422); expect(r.json().code).toBe('RESIDENCY_MISMATCH');
    const intl = await quoteOpt(w, 'STD', 'INTL', { residency: 'NON_RESIDENT' });
    await ok(call('POST', `/v1/properties/${w.pid}/reservations`, O, { guestId: foreigner, source: 'PHONE', lines: [{ quoteToken: intl.quoteToken }] }, { 'idempotency-key': `r-${++n}-${Date.now()}` }), 201);
    const blocked = await newGuest(); const g = (await call('GET', `/v1/guests/${blocked}`, O)).json();
    await call('PATCH', `/v1/guests/${blocked}`, O, { doNotRent: true, version: g.version });
    const b = await book(w, { guestId: blocked }); expect(b.statusCode).toBe(422); expect(b.json().code).toBe('GUEST_BLOCKED');
  });

  it('a discount above the user limit cannot be booked', async () => {
    const w = await sunset();
    const u = await addUser(T.tenantId, `lim${++n}@resv.test`); await assignRole(T.tenantId, u, 'front_desk_agent', 'PROPERTY', w.pid, { limits: { maxDiscountPct: 10 } });
    const lim = as(T.tenantId, u);
    const q = (await call('POST', `/v1/properties/${w.pid}/quotes`, lim, { arrival: '2026-11-05', departure: '2026-11-07', adults: 2, discountPct: 15 })).json();
    expect(q.options.find((o: any) => o.roomType.code === 'STD').quoteToken).toBeNull();
    const okq = await quoteOpt(w, 'STD', 'BAR', { discountPct: 10 }, lim);
    const r = await ok(call('POST', `/v1/properties/${w.pid}/reservations`, lim, { guestId: await newGuest({}, lim), source: 'PHONE', lines: [{ quoteToken: okq.quoteToken }] }, { 'idempotency-key': `d-${++n}-${Date.now()}` }), 201);
    expect(r.lines[0]).toMatchObject({ subtotal: { amount: '27000.00' }, discount: { pct: 10, amount: { amount: '2700.00' } }, total: { amount: '24300.00' } });
    expect(r.lines[0].nightPrices.reduce((a: number, x: any) => a + Number(x.total.replace(/,/g, '')), 0)).toBe(24300);          // the discount is split across nights exactly
  });
});

describe('concurrency: the last rooms', () => {
  it('12 simultaneous bookings for 3 Standard rooms: exactly 3 succeed, nobody is double-booked, counters stay exact', async () => {
    const w = await sunset();
    const opt = await quoteOpt(w, 'STD', 'BAR');
    const guests = await Promise.all(Array.from({ length: 12 }, () => newGuest()));
    const results = await Promise.all(guests.map((guestId, i) => call('POST', `/v1/properties/${w.pid}/reservations`, O, { guestId, source: 'PHONE', lines: [{ quoteToken: opt.quoteToken }] }, { 'idempotency-key': `race-${w.pid}-${i}` })));
    const won = results.filter((r) => r.statusCode === 201), lost = results.filter((r) => r.statusCode === 409);
    expect(won).toHaveLength(3); expect(lost).toHaveLength(9);
    expect(lost.every((r) => r.json().code === 'AVAILABILITY_CHANGED')).toBe(true);
    const nos = won.map((r) => r.json().confirmationNo);
    expect(new Set(nos).size).toBe(3);
    expect((await avail(w, 'STD', '2026-11-05')).reserved).toBe(3);
    expect((await avail(w, 'STD', '2026-11-06')).reserved).toBe(3);
    const rows = await adminDb.selectFrom('reservation').select('id').where('property_id', '=', w.pid).execute();
    expect(rows).toHaveLength(3);                                                                          // the 9 losers left no partial rows behind
    expect(await issues(w)).toEqual([]);
  });

  it('simultaneous retries of the SAME booking create it exactly once', async () => {
    const w = await sunset();
    const opt = await quoteOpt(w, 'STD', 'BAR'); const guestId = await newGuest();
    const key = `same-${w.pid}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => call('POST', `/v1/properties/${w.pid}/reservations`, O, { guestId, source: 'PHONE', lines: [{ quoteToken: opt.quoteToken }] }, { 'idempotency-key': key })));
    expect(results.every((r) => r.statusCode === 201 || r.statusCode === 200)).toBe(true);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect((await avail(w, 'STD', '2026-11-05')).reserved).toBe(1);
  });
});

describe('cancellation (72-hour rule), waiver, no-show, reinstatement', () => {
  it('cancels free of charge more than 72 hours before check-in and gives the room back', async () => {
    const w = await sunset();
    const r = await ok(book(w), 201);
    testClock.set(karachi('2026-11-02', '14:00'));                                                         // 72 h before Thu 14:00 check-in
    const c = await ok(call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/cancel`, O, { reason: 'Guest changed plans' }));
    expect(c).toMatchObject({ status: 'CANCELLED', penalty: { amount: '0.00' } });
    expect(c.reservation.lines[0].status).toBe('CANCELLED');
    expect((await avail(w, 'STD', '2026-11-05')).reserved).toBe(0);
    expect(c.reservation.history.map((h: any) => h.action)).toEqual(['CREATE', 'CANCEL']);
    const ev = (await adminDb.selectFrom('outbox_event').select('event_type').where('tenant_id', '=', T.tenantId).where('aggregate_id', '=', r.id).execute()).map((e) => e.event_type);
    expect(ev).toContain('ReservationCancelled');
    expect(await issues(w)).toEqual([]);
  });

  it('charges one night when cancelled inside 72 hours — measured to check-in time, not midnight — from the booking-time policy', async () => {
    const w = await sunset();
    const r = await ok(book(w), 201);
    // the hotel later makes the policy stricter; this booking keeps the rule it was sold under
    await call('PATCH', `/v1/properties/${w.pid}/rate-plans/${w.bar}`, O, { cancellationRule: { freeUntilHoursBefore: 240, feeType: 'PERCENT', feeValue: 10000 }, version: 2 });
    testClock.set(karachi('2026-11-02', '14:01'));                                                         // one minute inside the window
    const c = await ok(call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/cancel`, O, { reason: 'Late cancellation' }));
    expect(c.penalty.amount).toBe('12000.00');                                                             // first night (Thursday, weekday rate), not the new 100% rule
    expect(c.reservation.penalty).toMatchObject({ amount: { amount: '12000.00' }, reason: 'LATE_CANCELLATION', waived: false });
    expect((await avail(w, 'STD', '2026-11-05')).reserved).toBe(0);
  });

  it('a hold runs in half-hour steps, whole days, or until a date — and never past the day before arrival', async () => {
    const w = await sunset();
    const body = (hold: Record<string, unknown>) => ({ body: { hold } });
    expect((await book(w, body({ minutes: 45 }))).statusCode).toBe(400);                                  // not a half-hour step
    expect((await book(w, body({ minutes: 15 }))).statusCode).toBe(400);
    expect((await book(w, body({ days: 31 }))).statusCode).toBe(400);
    expect((await book(w, body({ days: 2, minutes: 30 }))).statusCode).toBe(400);                         // one way of saying it
    const d = await ok(book(w, body({ days: 3 })), 201);
    expect(new Date(d.optionExpiresAt).getTime() - testClock.now()).toBeGreaterThan(2.9 * 86_400_000);
    expect(new Date(d.optionExpiresAt).getTime() - testClock.now()).toBeLessThan(3.1 * 86_400_000);
    const u = await ok(book(w, body({ untilDate: '2026-11-03' })), 201);                                  // arrival is 2026-11-05
    expect(new Date(u.optionExpiresAt).toISOString()).toBe('2026-11-03T19:00:00.000Z');                   // midnight Karachi, end of the 3rd
    const late = await book(w, body({ untilDate: '2026-11-05' }));
    expect(late.statusCode).toBe(422);
    expect(late.json().code).toBe('HOLD_PAST_ARRIVAL');
    const past = await book(w, body({ untilDate: '2026-10-01' }));
    expect(past.json().code).toBe('HOLD_INVALID');
  });

  it('cancelling an unconfirmed option never carries a fee', async () => {
    const w = await sunset();
    const r = await ok(book(w, { body: { hold: { minutes: 120 } } }), 201);
    expect(r.status).toBe('OPTION');
    expect((await avail(w, 'STD', '2026-11-05')).held).toBe(1);
    testClock.set(karachi('2026-11-05', '08:00'));
    const c = await ok(call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/cancel`, O, { reason: 'Not needed' }));
    expect(c.penalty.amount).toBe('0.00');
    expect((await avail(w, 'STD', '2026-11-05')).held).toBe(0);
  });

  it('waiving the fee needs the waiver permission AND a fresh second factor, and the amount is still recorded', async () => {
    const w = await sunset();
    const mk = async () => { const r = await ok(book(w), 201); return r.id as string; };
    testClock.set(karachi('2026-11-04', '09:00'));                                                         // inside the window
    const fd = await addUser(T.tenantId, `fdw${++n}@resv.test`); await assignRole(T.tenantId, fd, 'front_desk_agent', 'PROPERTY', w.pid);
    const id1 = await mk();
    const noPerm = await call('POST', `/v1/properties/${w.pid}/reservations/${id1}/cancel`, as(T.tenantId, fd, { mfa: true }), { reason: 'Goodwill', waiveFee: true });
    expect(noPerm.statusCode).toBe(403); expect(noPerm.json().code).toBe('PERMISSION_DENIED');
    const noMfa = await call('POST', `/v1/properties/${w.pid}/reservations/${id1}/cancel`, O, { reason: 'Goodwill', waiveFee: true });
    expect(noMfa.statusCode).toBe(403); expect(noMfa.json().code).toBe('MFA_REQUIRED');
    expect((await call('GET', `/v1/properties/${w.pid}/reservations/${id1}`, O)).json().status).toBe('CONFIRMED');          // nothing happened
    const waived = await ok(call('POST', `/v1/properties/${w.pid}/reservations/${id1}/cancel`, OM, { reason: 'Corporate goodwill, approved by GM', waiveFee: true }));
    expect(waived.reservation.penalty).toMatchObject({ amount: { amount: '12000.00' }, waived: true });
    const audit = await adminDb.selectFrom('audit_log').select(['reason_code', 'after']).where('tenant_id', '=', T.tenantId).where('resource_id', '=', id1).where('action', '=', 'reservation.cancel').executeTakeFirstOrThrow();
    expect(audit.reason_code).toBe('FEE_WAIVED');
  });

  it('a cancelled booking cannot be cancelled again or checked in; the state machine says why', async () => {
    const w = await sunset();
    const r = await ok(book(w), 201);
    await ok(call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/cancel`, O, { reason: 'First cancel' }));
    const again = await call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/cancel`, O, { reason: 'Second cancel' });
    expect(again.statusCode).toBe(409);
    const noShow = await call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/no-show`, O, {});
    expect(noShow.statusCode).toBe(409);
    expect((await call('GET', `/v1/properties/${w.pid}/reservations/${r.id}`, O)).json().lines[0].allowedActions).toEqual(['REINSTATE']);
  });

  it('cancels one room of a multi-room reservation without touching the others', async () => {
    const w = await sunset();
    const [a, b] = [await quoteOpt(w, 'DLX', 'BAR'), await quoteOpt(w, 'STD', 'BAR')];
    const r = await ok(call('POST', `/v1/properties/${w.pid}/reservations`, O, { guestId: await newGuest(), source: 'PHONE', lines: [a, b].map((x) => ({ quoteToken: x.quoteToken })) }, { 'idempotency-key': `ml-${++n}-${Date.now()}` }), 201);
    const c = await ok(call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/cancel`, O, { reason: 'One room dropped', lineIds: [r.lines[0].id] }));
    expect(c.reservation.status).toBe('CONFIRMED');
    expect(c.reservation.lines.map((l: any) => l.status)).toEqual(['CANCELLED', 'CONFIRMED']);
    expect(c.reservation.totalExTax.amount).toBe('27000.00');                                              // only the live room counts
    expect((await avail(w, 'DLX', '2026-11-05')).reserved).toBe(0);
    expect((await avail(w, 'STD', '2026-11-05')).reserved).toBe(1);
    expect(await issues(w)).toEqual([]);
  });

  it('no-show: only from the arrival date, charges the no-show rule, releases the rooms; reinstating takes them back if still free', async () => {
    const w = await sunset();
    const r = await ok(book(w), 201);
    const early = await call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/no-show`, O, {});
    expect(early.statusCode).toBe(422); expect(early.json().code).toBe('TOO_EARLY');
    await adminDb.updateTable('property').set({ business_date: '2026-11-05' }).where('id', '=', w.pid).execute();              // the day has arrived (night audit comes later)
    const ns = await ok(call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/no-show`, O, { reason: 'Did not arrive by midnight' }));
    expect(ns).toMatchObject({ status: 'NO_SHOW', penalty: { amount: '12000.00' } });
    expect((await avail(w, 'STD', '2026-11-05')).reserved).toBe(0);
    const back = await ok(call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/reinstate`, O, { reason: 'Guest arrived late' }));
    expect(back.status).toBe('CONFIRMED'); expect(back.penalty.amount.amount).toBe('0.00');
    expect((await avail(w, 'STD', '2026-11-05')).reserved).toBe(1);
    expect(await issues(w)).toEqual([]);
  });

  it('reinstating is refused when the room has been sold in the meantime, and nothing changes', async () => {
    const w = await sunset();
    const r = await ok(book(w), 201);
    await ok(call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/cancel`, O, { reason: 'Cancelled' }));
    for (let i = 0; i < 3; i++) await ok(book(w), 201);                                                    // fill all three Standard rooms
    const re = await call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/reinstate`, O, { reason: 'Guest wants it back' });
    expect(re.statusCode).toBe(409); expect(re.json().code).toBe('AVAILABILITY_CHANGED');
    expect((await call('GET', `/v1/properties/${w.pid}/reservations/${r.id}`, O)).json().status).toBe('CANCELLED');
    expect(await issues(w)).toEqual([]);
  });

  it('reconfirming a booking is recorded (the unpaid-OTA follow-up)', async () => {
    const w = await sunset();
    const r = await ok(book(w, { quote: { channel: 'OTA' }, body: { source: 'OTA_BOOKING_COM' } }), 201);
    const c = await ok(call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/reconfirm`, O));
    expect(c.guarantee.reconfirmedAt).not.toBeNull();
    expect(c.history.map((h: any) => h.action)).toContain('RECONFIRMED');
  });
});

describe('options (holds)', () => {
  it('an option holds the room, confirming turns the hold into a sale, and an expired option releases itself', async () => {
    const w = await sunset();
    const r = await ok(book(w, { body: { hold: { minutes: 60 } } }), 201);
    expect(r).toMatchObject({ status: 'OPTION' }); expect(r.optionExpiresAt).toBeTruthy();
    expect(await avail(w, 'STD', '2026-11-05')).toMatchObject({ held: 1, reserved: 0 });
    const c = await ok(call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/confirm`, O));
    expect(c.status).toBe('CONFIRMED');
    expect(await avail(w, 'STD', '2026-11-05')).toMatchObject({ held: 0, reserved: 1 });
    expect(await issues(w)).toEqual([]);

    const r2 = await ok(book(w, { body: { hold: { minutes: 60 } } }), 201);
    testClock.set(Date.now() + 61 * 60_000);
    const svc = app.get(ReservationsService);
    const out = await runWithTenant({ tenantId: T.tenantId, actorId: T.ownerUserId }, () => svc.expireOptions(w.pid));
    expect(out.expired).toBe(1);
    const after = (await call('GET', `/v1/properties/${w.pid}/reservations/${r2.id}`, O)).json();
    expect(after.status).toBe('CANCELLED'); expect(after.history.map((h: any) => h.action)).toContain('EXPIRE');
    expect((await avail(w, 'STD', '2026-11-05')).held).toBe(0);
    expect((await call('POST', `/v1/properties/${w.pid}/reservations/${r2.id}/confirm`, O)).statusCode).toBe(409);       // too late
    expect(await issues(w)).toEqual([]);
  });

  it('a held room cannot be sold to someone else', async () => {
    const w = await sunset();
    for (let i = 0; i < 3; i++) await ok(book(w, { body: { hold: { minutes: 60 } } }), 201);
    const q = (await call('POST', `/v1/properties/${w.pid}/quotes`, O, { arrival: '2026-11-05', departure: '2026-11-07', adults: 2 })).json();
    expect(q.options.find((o: any) => o.roomType.code === 'STD')).toBeUndefined();                          // sold out for new quotes
  });
});

describe('changing a booking', () => {
  it('extends a stay: the new night is priced at today\'s rate, the nights already sold keep their price, inventory follows', async () => {
    const w = await sunset();
    const r = await ok(book(w), 201);                                                                      // Thu 12,000 + Fri 15,000
    await call('POST', `/v1/properties/${w.pid}/rate-plans/${w.bar}/overrides`, O, { roomTypeId: w.rt.STD, from: '2026-11-05', to: '2026-11-09', amount: '13000' });   // rates go up after the booking
    const line = r.lines[0];
    const m = await ok(call('PATCH', `/v1/properties/${w.pid}/reservations/${r.id}/rooms/${line.id}`, O, { departure: '2026-11-08', reason: 'Guest extended by a night', version: line.version }));
    expect(m.reservation.lines[0].nightPrices.map((x: any) => x.total)).toEqual(['12000.00', '15000.00', '13000.00']);
    expect(m.change).toMatchObject({ previousTotal: { amount: '27000.00' }, newTotal: { amount: '40000.00' }, difference: { amount: '13000.00' } });
    expect((await avail(w, 'STD', '2026-11-07')).reserved).toBe(1);
    expect(m.reservation.lines[0].depositDue.amount).toBe('12000.00');                                       // deposit rule from the original snapshot
    expect(m.reservation.history.map((h: any) => h.action)).toContain('MODIFY');
    expect(await issues(w)).toEqual([]);
  });

  it('shortens a stay and frees the nights; refuses an extension into a sold-out night and leaves everything untouched', async () => {
    const w = await sunset();
    const r = await ok(book(w, { quote: { departure: '2026-11-08' } }), 201);                              // Thu-Sat nights
    const line = r.lines[0];
    const s = await ok(call('PATCH', `/v1/properties/${w.pid}/reservations/${r.id}/rooms/${line.id}`, O, { departure: '2026-11-06', reason: 'Left early', version: line.version }));
    expect(s.change.newTotal.amount).toBe('12000.00');
    expect((await avail(w, 'STD', '2026-11-06')).reserved).toBe(0);
    // fill Saturday night completely, then try to extend into it
    for (let i = 0; i < 3; i++) await ok(book(w, { quote: { arrival: '2026-11-06', departure: '2026-11-07' } }), 201);
    const cur = s.reservation.lines[0];
    const fail = await call('PATCH', `/v1/properties/${w.pid}/reservations/${r.id}/rooms/${line.id}`, O, { departure: '2026-11-08', reason: 'Extend', version: cur.version });
    expect(fail.statusCode).toBe(409); expect(fail.json().code).toMatch(/AVAILABILITY_CHANGED|NOT_SELLABLE/);
    const after = (await call('GET', `/v1/properties/${w.pid}/reservations/${r.id}`, O)).json().lines[0];
    expect(after).toMatchObject({ departure: '2026-11-06', version: cur.version });
    expect(await issues(w)).toEqual([]);
  });

  it('upgrades the room type (all nights re-priced); a complimentary upgrade keeps the old rate but needs permission and a fresh second factor', async () => {
    const w = await sunset();
    const r = await ok(book(w), 201); const line = r.lines[0];
    const noPerm = await call('PATCH', `/v1/properties/${w.pid}/reservations/${r.id}/rooms/${line.id}`, O, { roomTypeId: w.rt.DLX, keepRate: true, reason: 'VIP upgrade', version: line.version });
    expect(noPerm.statusCode).toBe(403); expect(noPerm.json().code).toBe('MFA_REQUIRED');
    const comp = await ok(call('PATCH', `/v1/properties/${w.pid}/reservations/${r.id}/rooms/${line.id}`, OM, { roomTypeId: w.rt.DLX, keepRate: true, reason: 'VIP upgrade approved by GM', version: line.version }));
    expect(comp.reservation.lines[0]).toMatchObject({ roomType: { code: 'DLX' }, total: { amount: '27000.00' } });
    expect(comp.reservation.lines[0].nightPrices[0].source).toMatch(/^KEPT:/);
    expect(await avail(w, 'STD', '2026-11-05')).toMatchObject({ reserved: 0 });
    expect(await avail(w, 'DLX', '2026-11-05')).toMatchObject({ reserved: 1 });
    const r2 = await ok(book(w), 201); const l2 = r2.lines[0];
    const paid = await ok(call('PATCH', `/v1/properties/${w.pid}/reservations/${r2.id}/rooms/${l2.id}`, O, { roomTypeId: w.rt.EXE, reason: 'Paid upgrade', version: l2.version }));
    expect(paid.change).toMatchObject({ previousTotal: { amount: '27000.00' }, newTotal: { amount: '44000.00' }, difference: { amount: '17000.00' } });
    expect(await issues(w)).toEqual([]);
  });

  it('re-prices when occupancy changes, and rejects occupancy the room cannot hold', async () => {
    const w = await sunset();
    const r = await ok(book(w, { quote: { departure: '2026-11-06' } }), 201); const line = r.lines[0];
    const m = await ok(call('PATCH', `/v1/properties/${w.pid}/reservations/${r.id}/rooms/${line.id}`, O, { adults: 3, extraBeds: 1, reason: 'Third guest joins', version: line.version }));
    expect(m.change.newTotal.amount).toBe('15000.00');                                                       // 12,000 + 3,000 extra adult (BAR has no bed fee)
    const bad = await call('PATCH', `/v1/properties/${w.pid}/reservations/${r.id}/rooms/${line.id}`, O, { adults: 3, children: 2, reason: 'Too many', version: m.reservation.lines[0].version });
    expect(bad.statusCode).toBe(409); expect(bad.json().code).toBe('NOT_SELLABLE');
  });

  it('keeps the assigned room when the new dates are free, and refuses with a clear message when they are not', async () => {
    const w = await sunset();
    const a = await ok(book(w), 201), b = await ok(book(w, { quote: { arrival: '2026-11-07', departure: '2026-11-09' } }), 201);
    const rooms = (await call('GET', `/v1/properties/${w.pid}/available-rooms?roomTypeId=${w.rt.STD}&arrival=2026-11-05&departure=2026-11-07`, O)).json().items;
    const room101 = rooms.find((x: any) => x.number === '101');
    await ok(call('PUT', `/v1/properties/${w.pid}/reservations/${a.id}/rooms/${a.lines[0].id}/assignment`, O, { roomId: room101.id }));
    await ok(call('PUT', `/v1/properties/${w.pid}/reservations/${b.id}/rooms/${b.lines[0].id}/assignment`, O, { roomId: room101.id }));      // back-to-back in the same room is fine
    const fresh = (await call('GET', `/v1/properties/${w.pid}/reservations/${a.id}`, O)).json().lines[0];
    const blocked = await call('PATCH', `/v1/properties/${w.pid}/reservations/${a.id}/rooms/${fresh.id}`, O, { departure: '2026-11-08', reason: 'Extend', version: fresh.version });
    expect(blocked.statusCode).toBe(409); expect(blocked.json().code).toBe('ROOM_NOT_FREE_FOR_NEW_DATES');
    const unchanged = (await call('GET', `/v1/properties/${w.pid}/reservations/${a.id}`, O)).json().lines[0];
    expect(unchanged).toMatchObject({ departure: '2026-11-07', assignedRoom: { number: '101' } });             // rolled back completely
    expect((await avail(w, 'STD', '2026-11-07')).reserved).toBe(1);
    const shorter = await ok(call('PATCH', `/v1/properties/${w.pid}/reservations/${a.id}/rooms/${fresh.id}`, O, { departure: '2026-11-06', reason: 'Shorter', version: fresh.version }));
    expect(shorter.reservation.lines[0].assignedRoom.number).toBe('101');
    expect(await issues(w)).toEqual([]);
  });

  it('stale edits, unmodifiable lines and empty changes are refused', async () => {
    const w = await sunset();
    const r = await ok(book(w), 201); const line = r.lines[0];
    const url = `/v1/properties/${w.pid}/reservations/${r.id}/rooms/${line.id}`;
    expect((await call('PATCH', url, O, { departure: '2026-11-08', reason: 'x1y', version: line.version + 5 })).statusCode).toBe(412);
    expect((await call('PATCH', url, O, { reason: 'No change', version: line.version })).statusCode).toBe(422);
    expect((await call('PATCH', url, O, { departure: '2026-11-05', reason: 'Bad range', version: line.version })).statusCode).toBeGreaterThanOrEqual(400);
    await ok(call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/cancel`, O, { reason: 'Cancelled' }));
    const now = (await call('GET', `/v1/properties/${w.pid}/reservations/${r.id}`, O)).json().lines[0];
    expect((await call('PATCH', url, O, { departure: '2026-11-08', reason: 'After cancel', version: now.version })).json().code).toBe('NOT_MODIFIABLE');
  });
});

describe('physical room assignment', () => {
  it('lists only rooms that are free for the whole stay; assigns, moves and unassigns with history', async () => {
    const w = await sunset();
    const a = await ok(book(w), 201), b = await ok(book(w), 201);
    const free = async () => (await call('GET', `/v1/properties/${w.pid}/available-rooms?roomTypeId=${w.rt.STD}&arrival=2026-11-05&departure=2026-11-07`, O)).json().items.map((x: any) => x.number);
    expect(await free()).toEqual(['101', '102', '103']);
    const ids = Object.fromEntries((await call('GET', `/v1/properties/${w.pid}/rooms`, O)).json().items.map((x: any) => [x.number, x.id]));
    const asg = await ok(call('PUT', `/v1/properties/${w.pid}/reservations/${a.id}/rooms/${a.lines[0].id}/assignment`, O, { roomId: ids['101'] }));
    expect(asg.lines[0].assignedRoom.number).toBe('101');
    expect(await free()).toEqual(['102', '103']);
    const clash = await call('PUT', `/v1/properties/${w.pid}/reservations/${b.id}/rooms/${b.lines[0].id}/assignment`, O, { roomId: ids['101'] });
    expect(clash.statusCode).toBe(409); expect(clash.json().code).toBe('ROOM_NOT_FREE');
    const wrongType = await call('PUT', `/v1/properties/${w.pid}/reservations/${b.id}/rooms/${b.lines[0].id}/assignment`, O, { roomId: ids['201'] });
    expect(wrongType.statusCode).toBe(422); expect(wrongType.json().code).toBe('WRONG_ROOM_TYPE');
    const moved = await ok(call('PUT', `/v1/properties/${w.pid}/reservations/${a.id}/rooms/${a.lines[0].id}/assignment`, O, { roomId: ids['102'] }));
    expect(moved.lines[0].assignedRoom.number).toBe('102');
    expect(moved.lines[0].assignmentHistory.map((h: any) => [h.roomNumber, h.status])).toEqual([['101', 'ENDED'], ['102', 'ASSIGNED']]);
    expect(moved.history.map((h: any) => h.action)).toEqual(expect.arrayContaining(['ROOM_ASSIGNED', 'ROOM_MOVED']));
    expect(await free()).toEqual(['101', '103']);
    const un = await ok(call('DELETE', `/v1/properties/${w.pid}/reservations/${a.id}/rooms/${a.lines[0].id}/assignment`, O));
    expect(un.lines[0].assignedRoom).toBeNull();
    expect(await issues(w)).toEqual([]);
  });

  it('refuses a room that is out of order during the stay, and hides it from the free list', async () => {
    const w = await sunset();
    const a = await ok(book(w), 201);
    const ids = Object.fromEntries((await call('GET', `/v1/properties/${w.pid}/rooms`, O)).json().items.map((x: any) => [x.number, x.id]));
    await ok(call('POST', `/v1/properties/${w.pid}/room-blocks`, O, { roomId: ids['103'], type: 'OUT_OF_ORDER', startDate: '2026-11-06', endDate: '2026-11-08', reason: 'Water damage' }), 201);
    const free = (await call('GET', `/v1/properties/${w.pid}/available-rooms?roomTypeId=${w.rt.STD}&arrival=2026-11-05&departure=2026-11-07`, O)).json().items.map((x: any) => x.number);
    expect(free).toEqual(['101', '102']);
    const r = await call('PUT', `/v1/properties/${w.pid}/reservations/${a.id}/rooms/${a.lines[0].id}/assignment`, O, { roomId: ids['103'] });
    expect(r.statusCode).toBe(409); expect(r.json().code).toBe('ROOM_BLOCKED');
  });

  it('cancelling frees the assigned room immediately', async () => {
    const w = await sunset();
    const a = await ok(book(w), 201);
    const ids = Object.fromEntries((await call('GET', `/v1/properties/${w.pid}/rooms`, O)).json().items.map((x: any) => [x.number, x.id]));
    await ok(call('PUT', `/v1/properties/${w.pid}/reservations/${a.id}/rooms/${a.lines[0].id}/assignment`, O, { roomId: ids['101'] }));
    await ok(call('POST', `/v1/properties/${w.pid}/reservations/${a.id}/cancel`, O, { reason: 'Cancelled' }));
    const free = (await call('GET', `/v1/properties/${w.pid}/available-rooms?roomTypeId=${w.rt.STD}&arrival=2026-11-05&departure=2026-11-07`, O)).json().items.map((x: any) => x.number);
    expect(free).toEqual(['101', '102', '103']);
    expect(await issues(w)).toEqual([]);
  });
});

describe('arrivals, search and lists', () => {
  it('arrivals for a date, search by name / phone / confirmation / OTA reference, and cursor pagination', async () => {
    const w = await sunset();
    const g = await newGuest({ fullName: 'Hamza Qureshi', phone: '0300 5550101' });
    const r1 = await ok(book(w, { guestId: g, body: { externalRef: 'BK-77001' } }), 201);
    await ok(book(w, { quote: { arrival: '2026-11-06', departure: '2026-11-07' } }), 201);
    for (let i = 0; i < 2; i++) await ok(book(w, { room: 'DLX', quote: { arrival: '2026-11-05', departure: '2026-11-06' } }), 201);
    const arr = await ok(call('GET', `/v1/properties/${w.pid}/reservations?view=arrivals&date=2026-11-05`, O));
    expect(arr.items).toHaveLength(3);
    expect(arr.items.every((x: any) => x.arrival === '2026-11-05')).toBe(true);
    for (const q of ['hamza', '03005550101', '+92 300 5550101', r1.confirmationNo, 'BK-77001']) {
      const s = await ok(call('GET', `/v1/properties/${w.pid}/reservations?q=${encodeURIComponent(q)}`, O));
      expect(s.items.map((x: any) => x.confirmationNo), q).toContain(r1.confirmationNo);
    }
    const p1 = await ok(call('GET', `/v1/properties/${w.pid}/reservations?limit=2`, O));
    expect(p1.items).toHaveLength(2); expect(p1.nextCursor).toBeTruthy();
    const p2 = await ok(call('GET', `/v1/properties/${w.pid}/reservations?limit=2&cursor=${p1.nextCursor}`, O));
    expect(p2.items).toHaveLength(2); expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((x: any) => x.lineId)).size).toBe(4);
    expect((await call('GET', `/v1/properties/${w.pid}/reservations?cursor=garbage`, O)).statusCode).toBe(400);
    expect((await ok(call('GET', `/v1/properties/${w.pid}/reservations?view=in-house`, O))).items).toEqual([]);
  });
});

describe('integrity and isolation', () => {
  it('the history table is append-only, even for the provisioning role', async () => {
    const w = await sunset(); const r = await ok(book(w), 201);
    await expect(adminDb.updateTable('reservation_history').set({ reason: 'tampered' }).where('reservation_id', '=', r.id).execute()).rejects.toThrow(/append-only/);
    await expect(adminDb.deleteFrom('reservation_history').where('reservation_id', '=', r.id).execute()).rejects.toThrow(/append-only/);
  });
  it('the invariant checker catches counters that disagree with the bookings', async () => {
    const w = await sunset(); await ok(book(w), 201);
    expect(await issues(w)).toEqual([]);
    await adminDb.updateTable('inventory_day').set({ reserved: 2 }).where('property_id', '=', w.pid).where('business_date', '=', '2026-11-05').where('room_type_id', '=', w.rt.STD).execute();
    expect((await issues(w)).map((i) => i.kind)).toContain('RESERVED_MISMATCH');
  });
  it('another tenant cannot read, change, cancel or reuse the quote of this tenant\'s reservations', async () => {
    const w = await sunset(); const r = await ok(book(w), 201);
    const opt = await quoteOpt(w, 'DLX', 'BAR');
    const B = await provision(app, `resv-b${++n}`); const ob = as(B.tenantId, B.ownerUserId);
    expect((await call('GET', `/v1/properties/${w.pid}/reservations/${r.id}`, ob)).statusCode).toBe(404);
    expect((await call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/cancel`, ob, { reason: 'Hostile cancel' })).statusCode).toBe(404);
    expect((await call('GET', `/v1/guests/${r.guest.id}`, ob)).statusCode).toBe(404);
    const g = (await call('POST', '/v1/guests', ob, guestBody())).json().id;
    expect((await call('POST', `/v1/properties/${B.propertyIds[0]}/reservations`, ob, { guestId: g, source: 'PHONE', lines: [{ quoteToken: opt.quoteToken }] }, { 'idempotency-key': `iso-${++n}-${Date.now()}` })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await call('GET', `/v1/properties/${w.pid}/reservations/${r.id}`, O)).json().status).toBe('CONFIRMED');
  });
  it('a front-desk agent of another property cannot see or change this property\'s bookings', async () => {
    const w = await sunset(), other = await sunset();
    const r = await ok(book(w), 201);
    const fd = await addUser(T.tenantId, `fdo${++n}@resv.test`); await assignRole(T.tenantId, fd, 'front_desk_agent', 'PROPERTY', other.pid);
    expect((await call('GET', `/v1/properties/${w.pid}/reservations/${r.id}`, as(T.tenantId, fd))).statusCode).toBe(403);
    expect((await call('POST', `/v1/properties/${w.pid}/reservations/${r.id}/cancel`, as(T.tenantId, fd), { reason: 'Not mine' })).statusCode).toBe(403);
  });
});
