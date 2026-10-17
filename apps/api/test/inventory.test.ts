import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createDb, withTenant } from '@hos/db';
import { addDays } from '@hos/domain-types';
import { AvailabilityError, HorizonError, InventoryService, OversellError } from '../src/inventory/inventory.service.js';
import { runWithTenant } from '../src/tenancy/tenant-context.js';
import { URLS } from './env.js';
import { adminDb, createTestApp, provision } from './harness.js';

const pool = createDb(URLS.app, 30);
let app: NestFastifyApplication;
let inv: InventoryService;
const D0 = '2026-11-01';

beforeAll(async () => { app = await createTestApp(); inv = app.get(InventoryService); });
afterAll(async () => { await app.close(); await pool.destroy(); });

/** A fresh tenant + property with one room type of `rooms` rooms and `days` days of inventory. */
async function world(slug: string, rooms = 3, days = 10) {
  const T = await provision(app, slug);
  const propertyId = T.propertyIds[0];
  const rt = await adminDb.insertInto('room_type').values({ tenant_id: T.tenantId, property_id: propertyId, code: 'DLX', name: 'Deluxe', max_adults: 2, max_occupancy: 3 }).returning('id').executeTakeFirstOrThrow();
  const roomIds: string[] = [];
  for (let i = 0; i < rooms; i++) {
    roomIds.push((await adminDb.insertInto('room').values({ tenant_id: T.tenantId, property_id: propertyId, room_type_id: rt.id, number: String(201 + i) }).returning('id').executeTakeFirstOrThrow()).id);
  }
  const run = <R>(fn: (trx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<R>) =>
    runWithTenant({ tenantId: T.tenantId, actorId: T.ownerUserId }, () => withTenant(pool, T.tenantId, fn));
  await run((trx) => inv.ensureHorizon(trx, propertyId, D0, addDays(D0, days)));
  const night = (d: string) => adminDb.selectFrom('inventory_day').selectAll().where('tenant_id', '=', T.tenantId).where('room_type_id', '=', rt.id).where('business_date', '=', d).executeTakeFirstOrThrow();
  return { T, propertyId, roomTypeId: rt.id, roomIds, run, night, days };
}

describe('horizon', () => {
  it('creates one row per night per room type, with physical = active rooms; idempotent', async () => {
    const w = await world('inv-h1', 3, 10);
    expect((await w.night(D0)).physical).toBe(3);
    const again = await w.run((trx) => inv.ensureHorizon(trx, w.propertyId, D0, addDays(D0, 10)));
    expect(again).toBe(0);
    const extended = await w.run((trx) => inv.ensureHorizon(trx, w.propertyId, D0, addDays(D0, 15)));
    expect(extended).toBe(5);
  });
  it('reserving outside the open horizon is refused, not silently ignored', async () => {
    const w = await world('inv-h2', 3, 5);
    await expect(w.run((trx) => inv.reserve(trx, { propertyId: w.propertyId, roomTypeId: w.roomTypeId, arrival: addDays(D0, 3), departure: addDays(D0, 8) }))).rejects.toBeInstanceOf(HorizonError);
  });
});

describe('reserve / release', () => {
  it('takes one unit per night of [arrival, departure) — the departure date is not a night', async () => {
    const w = await world('inv-r1');
    await w.run((trx) => inv.reserve(trx, { propertyId: w.propertyId, roomTypeId: w.roomTypeId, arrival: '2026-11-02', departure: '2026-11-05' }));
    expect((await w.night('2026-11-01')).reserved).toBe(0);
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-04']) expect((await w.night(d)).reserved).toBe(1);
    expect((await w.night('2026-11-05')).reserved).toBe(0);
    await w.run((trx) => inv.release(trx, { propertyId: w.propertyId, roomTypeId: w.roomTypeId, arrival: '2026-11-02', departure: '2026-11-05' }));
    expect((await w.night('2026-11-03')).reserved).toBe(0);
  });
  it('refuses when any night is full, naming the dates, and leaves NO partial change', async () => {
    const w = await world('inv-r2', 2);
    const a = { propertyId: w.propertyId, roomTypeId: w.roomTypeId };
    await w.run((trx) => inv.reserve(trx, { ...a, arrival: '2026-11-04', departure: '2026-11-05', rooms: 2 })); // night 4 full
    const err = await w.run((trx) => inv.reserve(trx, { ...a, arrival: '2026-11-02', departure: '2026-11-06' })).catch((e) => e);
    expect(err).toBeInstanceOf(AvailabilityError);
    expect((err as AvailabilityError).soldOutDates).toEqual(['2026-11-04']);
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-05']) expect((await w.night(d)).reserved, d).toBe(0);
  });
  it('releasing more than was reserved is an error, never a negative counter', async () => {
    const w = await world('inv-r3');
    await expect(w.run((trx) => inv.release(trx, { propertyId: w.propertyId, roomTypeId: w.roomTypeId, arrival: D0, departure: addDays(D0, 1) }))).rejects.toMatchObject({ status: 500 });
  });
  it('holds count against availability just like reservations', async () => {
    const w = await world('inv-r4', 1);
    const a = { propertyId: w.propertyId, roomTypeId: w.roomTypeId, arrival: D0, departure: addDays(D0, 2) };
    await w.run((trx) => inv.hold(trx, a));
    await expect(w.run((trx) => inv.reserve(trx, a))).rejects.toBeInstanceOf(AvailabilityError);
    await w.run((trx) => inv.releaseHold(trx, a));
    await w.run((trx) => inv.reserve(trx, a));
  });
  it('overbooking limit permits exactly that many extra units, per date', async () => {
    const w = await world('inv-r5', 2);
    const a = { propertyId: w.propertyId, roomTypeId: w.roomTypeId };
    await w.run((trx) => inv.setOverbookLimit(trx, { ...a, from: '2026-11-03', to: '2026-11-04', limit: 1 }));
    await w.run((trx) => inv.reserve(trx, { ...a, arrival: '2026-11-03', departure: '2026-11-04', rooms: 3 }));            // 2 rooms + 1 overbook
    await expect(w.run((trx) => inv.reserve(trx, { ...a, arrival: '2026-11-03', departure: '2026-11-04' }))).rejects.toBeInstanceOf(AvailabilityError);
    await expect(w.run((trx) => inv.reserve(trx, { ...a, arrival: '2026-11-02', departure: '2026-11-03', rooms: 3 }))).rejects.toBeInstanceOf(AvailabilityError); // other date: limit 0
  });
});

describe('concurrency (the double-booking tests)', () => {
  it('25 simultaneous bookings for the last 3 rooms: exactly 3 succeed, 22 get a clean conflict', async () => {
    const w = await world('inv-c1', 3);
    const results = await Promise.allSettled(Array.from({ length: 25 }, () =>
      w.run((trx) => inv.reserve(trx, { propertyId: w.propertyId, roomTypeId: w.roomTypeId, arrival: '2026-11-03', departure: '2026-11-04' }))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.every((r) => r.reason instanceof AvailabilityError)).toBe(true);
    expect((await w.night('2026-11-03')).reserved).toBe(3);
  });
  it('overlapping multi-night stays under load: never oversold, never deadlocked, counters equal the successful nights', async () => {
    const w = await world('inv-c2', 4, 8);
    let seed = 7; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const attempts = Array.from({ length: 80 }, () => { const s = rnd(6), len = 1 + rnd(Math.min(4, 8 - s)); return { arrival: addDays(D0, s), departure: addDays(D0, s + len), len }; });
    const results = await Promise.allSettled(attempts.map((a) => w.run((trx) => inv.reserve(trx, { propertyId: w.propertyId, roomTypeId: w.roomTypeId, arrival: a.arrival, departure: a.departure }))));
    const unexpected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected' && !(r.reason instanceof AvailabilityError));
    expect(unexpected.map((u) => String(u.reason))).toEqual([]);
    const okNights = attempts.filter((_, i) => results[i]!.status === 'fulfilled').reduce((n, a) => n + a.len, 0);
    const rows = await adminDb.selectFrom('inventory_day').select(['reserved', 'physical']).where('tenant_id', '=', w.T.tenantId).execute();
    expect(rows.every((r) => r.reserved <= r.physical)).toBe(true);
    expect(rows.reduce((n, r) => n + r.reserved, 0)).toBe(okNights);
  });
  it('book and cancel storms leave the counters exactly where they started', async () => {
    const w = await world('inv-c3', 5);
    const a = { propertyId: w.propertyId, roomTypeId: w.roomTypeId, arrival: '2026-11-02', departure: '2026-11-04' };
    await Promise.all(Array.from({ length: 5 }, () => w.run((trx) => inv.reserve(trx, a))));
    await Promise.all(Array.from({ length: 5 }, () => w.run((trx) => inv.release(trx, a))));
    expect((await w.night('2026-11-02')).reserved).toBe(0);
    expect((await w.night('2026-11-03')).reserved).toBe(0);
  });
});

describe('blocks (out of order) and capacity changes', () => {
  it('an out-of-order unit reduces what can be sold', async () => {
    const w = await world('inv-b1', 2);
    const a = { propertyId: w.propertyId, roomTypeId: w.roomTypeId };
    await w.run((trx) => inv.applyBlock(trx, { ...a, type: 'OUT_OF_ORDER', from: '2026-11-02', to: '2026-11-04', delta: 1 }));
    await w.run((trx) => inv.reserve(trx, { ...a, arrival: '2026-11-02', departure: '2026-11-03' }));
    await expect(w.run((trx) => inv.reserve(trx, { ...a, arrival: '2026-11-02', departure: '2026-11-03' }))).rejects.toBeInstanceOf(AvailabilityError);
    await w.run((trx) => inv.applyBlock(trx, { ...a, type: 'OUT_OF_ORDER', from: '2026-11-02', to: '2026-11-04', delta: -1 }));
    await w.run((trx) => inv.reserve(trx, { ...a, arrival: '2026-11-02', departure: '2026-11-03' }));
  });
  it('a block that would oversell existing bookings is refused unless explicitly allowed — and reports the dates', async () => {
    const w = await world('inv-b2', 1);
    const a = { propertyId: w.propertyId, roomTypeId: w.roomTypeId };
    await w.run((trx) => inv.reserve(trx, { ...a, arrival: '2026-11-03', departure: '2026-11-05' }));
    const err = await w.run((trx) => inv.applyBlock(trx, { ...a, type: 'OUT_OF_ORDER', from: '2026-11-02', to: '2026-11-06', delta: 1 })).catch((e) => e);
    expect(err).toBeInstanceOf(OversellError);
    expect(err.dates).toEqual(['2026-11-03', '2026-11-04']);
    expect((await w.night('2026-11-03')).out_of_order).toBe(0); // rolled back
    const ok = await w.run((trx) => inv.applyBlock(trx, { ...a, type: 'OUT_OF_ORDER', from: '2026-11-02', to: '2026-11-06', delta: 1, allowOversell: true }));
    expect(ok.oversoldDates).toEqual(['2026-11-03', '2026-11-04']);
  });
  it('retiring a room is refused while it would leave reservations without a room', async () => {
    const w = await world('inv-b3', 2);
    const a = { propertyId: w.propertyId, roomTypeId: w.roomTypeId };
    await w.run((trx) => inv.reserve(trx, { ...a, arrival: '2026-11-03', departure: '2026-11-04', rooms: 2 }));
    await adminDb.updateTable('room').set({ status: 'INACTIVE' }).where('id', '=', w.roomIds[0]!).execute();
    await expect(w.run((trx) => inv.recomputePhysical(trx, w.propertyId, w.roomTypeId, D0))).rejects.toBeInstanceOf(OversellError);
  });
  it('capacity changes flow into availability', async () => {
    const w = await world('inv-b4', 2);
    await adminDb.insertInto('room').values({ tenant_id: w.T.tenantId, property_id: w.propertyId, room_type_id: w.roomTypeId, number: '299' }).execute();
    await w.run((trx) => inv.recomputePhysical(trx, w.propertyId, w.roomTypeId, D0));
    expect((await w.night('2026-11-05')).physical).toBe(3);
  });
});

describe('invariant checker', () => {
  it('is clean on a healthy property and flags tampering, gaps and oversells', async () => {
    const w = await world('inv-i1', 3, 6);
    expect(await w.run((trx) => inv.checkInvariants(trx, w.propertyId))).toEqual([]);
    await adminDb.updateTable('inventory_day').set({ physical: 5 }).where('tenant_id', '=', w.T.tenantId).where('business_date', '=', '2026-11-02').execute();
    await adminDb.updateTable('inventory_day').set({ out_of_order: 1 }).where('tenant_id', '=', w.T.tenantId).where('business_date', '=', '2026-11-03').execute();
    await adminDb.deleteFrom('inventory_day').where('tenant_id', '=', w.T.tenantId).where('business_date', '=', '2026-11-04').execute();
    const kinds = (await w.run((trx) => inv.checkInvariants(trx, w.propertyId))).map((i) => i.kind).sort();
    expect(kinds).toEqual(['BLOCK_MISMATCH', 'GAP', 'PHYSICAL_MISMATCH']);
  });
});

describe('database-level protection (independent of application logic)', () => {
  it('a room can never be assigned to two overlapping stays; back-to-back stays and ended stays are fine', async () => {
    const w = await world('inv-d1', 2);
    const room = w.roomIds[0]!;
    const ins = (range: string, status: 'ASSIGNED' | 'IN_HOUSE' | 'ENDED' = 'ASSIGNED', roomId = room) =>
      adminDb.insertInto('room_assignment').values({ tenant_id: w.T.tenantId, property_id: w.propertyId, room_id: roomId, assignment_ref: crypto.randomUUID(), stay_range: range, status }).execute();
    await ins('[2026-11-10,2026-11-13)');
    await expect(ins('[2026-11-12,2026-11-14)')).rejects.toThrow(/conflicting key|exclusion/i);
    await expect(ins('[2026-11-09,2026-11-11)', 'IN_HOUSE')).rejects.toThrow(/conflicting key|exclusion/i);
    await ins('[2026-11-13,2026-11-15)');                       // same-day turnover: departs 13th, next arrives 13th
    await ins('[2026-11-11,2026-11-12)', 'ENDED');              // ended stays do not block
    await ins('[2026-11-10,2026-11-13)', 'ASSIGNED', w.roomIds[1]!); // different room, same dates
  });
  it('overlapping active blocks on one room are rejected; cancelled blocks do not block', async () => {
    const w = await world('inv-d2', 1);
    const ins = (s: string, e: string, cancelled = false) => adminDb.insertInto('room_block').values({
      tenant_id: w.T.tenantId, property_id: w.propertyId, room_id: w.roomIds[0]!, block_type: 'OUT_OF_ORDER', start_date: s, end_date: e, reason: 'AC repair',
      cancelled_at: cancelled ? new Date() : null }).execute();
    await ins('2026-11-02', '2026-11-05');
    await expect(ins('2026-11-04', '2026-11-06')).rejects.toThrow(/conflicting key|exclusion/i);
    await ins('2026-11-05', '2026-11-07');
    await ins('2026-11-03', '2026-11-04', true);
  });
  it('counter columns cannot go negative', async () => {
    const w = await world('inv-d3', 1);
    await expect(adminDb.updateTable('inventory_day').set({ reserved: -1 }).where('tenant_id', '=', w.T.tenantId).execute()).rejects.toThrow(/check constraint/i);
  });
});
