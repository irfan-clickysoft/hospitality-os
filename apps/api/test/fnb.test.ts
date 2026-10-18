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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'fnb'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@fnb.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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


const F = (w: W, tail: string) => u(w, `fnb/${tail}`);
async function inHouse(w: W) {
  at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
  const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' }); await checkIn(w, b, '101');
  const stay = (await ok(call('GET', F(w, 'in-house'), O))).items.find((x: any) => x.room === '101');
  return { b, stay };
}
const item = (w: W, o: Record<string, unknown> = {}) => ok(call('POST', F(w, 'menu'), O, { category: 'Mains', name: `Dish ${++n}`, price: '800', ...o }), 201);
const bal = async (w: W, b: { id: string }) => (await ok(call('GET', u(w, `reservations/${b.id}/folio`), O))).folio.balance.amount as string;

describe('kitchen and room service', () => {
  it('a menu per property: items have a price and an Urdu name, can be switched off, and are unique; only managers of the kitchen change it', async () => {
    const w = await sunset(); const cook = await staff(w, 'kitchen_support'); const chef = await staff(w, 'kitchen_cook');
    const karahi = await item(w, { name: 'Chicken karahi', nameUr: 'چکن کڑاہی', price: '1800' });
    expect(karahi).toMatchObject({ price: { amount: '1800.00' }, nameUr: 'چکن کڑاہی', active: true });
    await code(call('POST', F(w, 'menu'), cook.h, { category: 'Mains', name: 'Sneaky', price: '1' }), 403, 'PERMISSION_DENIED');
    await code(call('POST', F(w, 'menu'), chef.h, { category: 'Mains', name: 'chicken KARAHI', price: '1' }), 409, 'DUPLICATE');
    const tea = await item(w, { category: 'Drinks', name: 'Doodh patti', price: '150' });
    expect(await ok(call('PATCH', F(w, `menu/${tea.id}`), chef.h, { price: '180', version: tea.version }))).toMatchObject({ price: { amount: '180.00' }, version: tea.version + 1 });
    await code(call('PATCH', F(w, `menu/${tea.id}`), chef.h, { price: '1', version: tea.version }), 412, 'VERSION_CONFLICT');
    await ok(call('PATCH', F(w, `menu/${tea.id}`), chef.h, { active: false, version: tea.version + 1 }));
    expect((await ok(call('GET', F(w, 'menu'), cook.h))).items.map((x: any) => x.name)).toEqual(['Chicken karahi']);
    expect((await ok(call('GET', F(w, 'menu?all=true'), chef.h))).items).toHaveLength(2);
  });

  it('an order for a guest in the house goes through the kitchen; the bill is charged item by item when it is delivered (not before), once', async () => {
    const w = await sunset(); const { b, stay } = await inHouse(w);
    const karahi = await item(w, { name: 'Karahi', price: '1800' }); const naan = await item(w, { category: 'Bread', name: 'Naan', price: '60' }); const free = await item(w, { category: 'Bread', name: 'Complimentary dates', price: '0' });
    const chef = await staff(w, 'kitchen_cook'); const waiter = await staff(w, 'kitchen_support');
    const order = await ok(call('POST', F(w, 'orders'), O, { reservationRoomId: stay.reservationRoomId, note: 'No chillies', lines: [{ menuItemId: karahi.id, quantity: 1 }, { menuItemId: naan.id, quantity: 4, note: 'hot' }, { menuItemId: free.id, quantity: 1 }] }), 201);
    expect(order).toMatchObject({ status: 'NEW', room: '101', total: { amount: '2040.00' }, number: expect.stringMatching(/-FB00001$/) });
    expect(order.lines.map((l: any) => [l.name, l.quantity, l.total.amount])).toEqual(expect.arrayContaining([['Karahi', 1, '1800.00'], ['Naan', 4, '240.00']]));
    expect(await bal(w, b)).toBe('0.00');                                                              // nothing is charged yet
    // changing the menu afterwards does not change an order already taken
    const k0 = await ok(call('GET', F(w, 'menu?all=true'), O)); const kv = k0.items.find((x: any) => x.name === 'Karahi');
    await ok(call('PATCH', F(w, `menu/${kv.id}`), O, { price: '2500', version: kv.version }));
    expect((await ok(call('GET', F(w, 'orders'), chef.h))).items[0].total.amount).toBe('2040.00');
    await code(call('POST', F(w, `orders/${order.id}/deliver`), waiter.h, {}), 409, 'NOT_READY');          // the kitchen has not finished
    await code(call('POST', F(w, `orders/${order.id}/prepare`), waiter.h, {}), 403, 'PERMISSION_DENIED');
    expect(await ok(call('POST', F(w, `orders/${order.id}/prepare`), chef.h, {}))).toMatchObject({ status: 'PREPARING' });
    await code(call('POST', F(w, `orders/${order.id}/prepare`), chef.h, {}), 409, 'WRONG_STATE');
    expect(await ok(call('POST', F(w, `orders/${order.id}/ready`), chef.h, {}))).toMatchObject({ status: 'READY' });
    const done = await ok(call('POST', F(w, `orders/${order.id}/deliver`), waiter.h, {}));
    expect(done).toMatchObject({ status: 'DELIVERED', businessDate: '2026-11-05' }); expect(done.lines.filter((l: any) => l.posted)).toHaveLength(2);   // the free item has nothing to post
    expect(await bal(w, b)).toBe('2040.00');
    const f = await ok(call('GET', u(w, `reservations/${b.id}/folio`), O));
    const fnb = f.postings.filter((p: any) => p.txnCode === 'FNB');
    expect(fnb.map((p: any) => p.amount.amount).sort()).toEqual(['1800.00', '240.00']); expect(fnb[0].description).toContain('-FB00001 ·');
    await code(call('POST', F(w, `orders/${order.id}/deliver`), waiter.h, {}), 409, 'WRONG_STATE');          // never charged twice
    await code(call('POST', F(w, `orders/${order.id}/cancel`), O, { reason: 'Guest changed mind' }), 409, 'ALREADY_DELIVERED');
    expect(await bal(w, b)).toBe('2040.00');
    expect((await ok(call('GET', F(w, 'orders'), chef.h))).items).toHaveLength(0);                           // the open queue is empty
    expect((await ok(call('GET', F(w, 'orders?status=DELIVERED'), chef.h))).items).toHaveLength(1);
    expect((await ok(call('GET', F(w, `reservations/${b.id}/orders`), O))).items).toHaveLength(1);
    expect((await ok(call('GET', u(w, 'folio-check'), O))).ok).toBe(true);
  });

  it('only guests in the house can order; unavailable items are refused; a cancelled order is never charged; a manager can deliver straight from the kitchen queue; a closed bill refuses delivery', async () => {
    const w = await sunset(); const { b, stay } = await inHouse(w);
    const dish = await item(w, { price: '500' }); const gone = await item(w, { price: '100' });
    await ok(call('PATCH', F(w, `menu/${gone.id}`), O, { active: false, version: gone.version }));
    const arriving = await book(w, { arrival: '2026-11-06', departure: '2026-11-07' });
    const arrivingLine = (await ok(call('GET', u(w, `reservations/${arriving.id}`), O))).lines[0].id;
    await code(call('POST', F(w, 'orders'), O, { reservationRoomId: arrivingLine, lines: [{ menuItemId: dish.id }] }), 422, 'NOT_IN_HOUSE');
    await code(call('POST', F(w, 'orders'), O, { reservationRoomId: stay.reservationRoomId, lines: [{ menuItemId: gone.id }] }), 422, 'MENU_ITEM_UNAVAILABLE');
    await code(call('POST', F(w, 'orders'), O, { reservationRoomId: stay.reservationRoomId, lines: [{ menuItemId: '11111111-1111-4111-8111-111111111111' }] }), 422, 'MENU_ITEM_INVALID');
    await code(call('POST', F(w, 'orders'), O, { reservationRoomId: stay.reservationRoomId, lines: [] }), 400, 'VALIDATION_FAILED');
    const o1 = await ok(call('POST', F(w, 'orders'), O, { reservationRoomId: stay.reservationRoomId, lines: [{ menuItemId: dish.id, quantity: 2 }] }), 201);
    await code(call('POST', F(w, `orders/${o1.id}/cancel`), O, { reason: 'x' }), 400, 'VALIDATION_FAILED');
    expect(await ok(call('POST', F(w, `orders/${o1.id}/cancel`), O, { reason: 'Guest not in the room' }))).toMatchObject({ status: 'CANCELLED', cancelReason: 'Guest not in the room' });
    await code(call('POST', F(w, `orders/${o1.id}/ready`), O, {}), 409, 'WRONG_STATE'); expect(await bal(w, b)).toBe('0.00');
    const o2 = await ok(call('POST', F(w, 'orders'), O, { reservationRoomId: stay.reservationRoomId, lines: [{ menuItemId: dish.id }] }), 201);
    expect(await ok(call('POST', F(w, `orders/${o2.id}/deliver`), O, {}))).toMatchObject({ status: 'DELIVERED' });          // the owner (fnb.manage) may deliver from NEW
    expect(await bal(w, b)).toBe('500.00');
    // a closed bill refuses new orders
    const o3 = await ok(call('POST', F(w, 'orders'), O, { reservationRoomId: stay.reservationRoomId, lines: [{ menuItemId: dish.id }] }), 201);
    await adminDb.updateTable('folio').set({ status: 'CLOSED' }).where('reservation_id', '=', b.id).execute();
    await code(call('POST', F(w, `orders/${o3.id}/deliver`), O, {}), 409, 'FOLIO_NOT_OPEN');
    await code(call('POST', F(w, 'orders'), O, { reservationRoomId: stay.reservationRoomId, lines: [{ menuItemId: dish.id }] }), 409, 'FOLIO_NOT_OPEN');
    const clerk = await staff(w, 'cashier');
    await code(call('GET', F(w, 'orders'), clerk.h), 403, 'PERMISSION_DENIED');
  });
});
