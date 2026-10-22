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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'menu'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@menu.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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


const R = (w: W, tail: string) => u(w, tail);
async function inHouse(w: W) {
  at('2026-11-05', '13:00'); await setBd(w, '2026-11-05');
  const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' }); await checkIn(w, b, '101');
  const stay = (await ok(call('GET', R(w, 'fnb/in-house'), O))).items.find((x: any) => x.room === '101');
  return { b, stay };
}
async function shop(w: W) {
  const outlet = (await ok(call('POST', R(w, 'outlets'), O, { name: 'Terrace', kind: 'RESTAURANT' }), 201)).id as string;
  const menu = (await ok(call('POST', R(w, `outlets/${outlet}/menus`), O, { name: 'All day' }), 201)).id as string;
  const cat = (await ok(call('POST', R(w, `menus/${menu}/categories`), O, { name: 'Mains' }), 201)).id as string;
  return { outlet, menu, cat };
}
const dish = (w: W, cat: string, o: Record<string, unknown> = {}) => ok(call('POST', R(w, 'menu-items'), O, { categoryId: cat, name: `Dish ${++n}`, price: '1850', ...o }), 201);
const order = (w: W, stay: any, lines: unknown[]) => call('POST', R(w, 'fnb/orders'), O, { reservationRoomId: stay.reservationRoomId, lines });

describe('outlets and menus', () => {
  it('a property gets a room-service outlet from its older flat menu, and an item carries every field of the spec', async () => {
    const w = await sunset();
    await ok(call('POST', R(w, 'fnb/menu'), O, { category: 'Mains', name: 'Old dish', price: '500' }), 201);
    const outlets = (await ok(call('GET', R(w, 'outlets'), O))).items;
    expect(outlets.map((o: any) => o.name)).toContain('Room service');
    const rs = outlets.find((o: any) => o.name === 'Room service');
    const tree = await ok(call('GET', R(w, `outlets/${rs.id}/menu`), O));
    expect(tree.menus[0].categories[0].items[0].name).toBe('Old dish');

    const s = await shop(w);
    const d = await dish(w, s.cat, { name: 'Chicken Karahi', shortDescription: 'Wok-tossed with tomato and green chilli', price: '1850', serves: 2, prepMinMinutes: 35, prepMaxMinutes: 45, dietary: ['HALAL'], spiceLevel: 2, allergensContain: ['DAIRY'], allergensMay: ['NUTS'], ingredients: ['chicken', 'tomato', 'ginger'], removableIngredients: ['ginger'], calories: 640, proteinG: 48, cuisine: 'Pakistani', temperature: 'HOT', pairings: 'Naan' });
    const full = await ok(call('GET', R(w, `menu-items/${d.id}`), O));
    expect(full).toMatchObject({ name: 'Chicken Karahi', price: expect.objectContaining({ amount: '1850.00' }), serves: 2, prepMinMinutes: 35, prepMaxMinutes: 45, dietary: ['HALAL'], spiceLevel: 2, allergensContain: ['DAIRY'], allergensMay: ['NUTS'], removableIngredients: ['ginger'], calories: 640, orderable: true });
    const card = (await ok(call('GET', R(w, `outlets/${s.outlet}/menu`), O))).menus[0].categories[0].items[0];
    expect(card).toMatchObject({ name: 'Chicken Karahi', serves: 2, prepMinMinutes: 35, prepMaxMinutes: 45, dietary: ['HALAL'], spiceLevel: 2, orderable: true });
  });

  it('refuses contradictory item details', async () => {
    const w = await sunset(); const s = await shop(w);
    await code(call('POST', R(w, 'menu-items'), O, { categoryId: s.cat, name: 'Bad prep', price: '100', prepMinMinutes: 50, prepMaxMinutes: 40 }), 400, 'VALIDATION_FAILED');
    await code(call('POST', R(w, 'menu-items'), O, { categoryId: s.cat, name: 'Bad limit', price: '100', availability: 'LIMITED' }), 400, 'VALIDATION_FAILED');
    await code(call('POST', R(w, 'menu-items'), O, { categoryId: s.cat, name: 'Bad remove', price: '100', ingredients: ['rice'], removableIngredients: ['salt'] }), 400, 'VALIDATION_FAILED');
    await code(call('POST', R(w, 'menu-items'), O, { categoryId: s.cat, name: 'Bad disc', price: '100', discountedPrice: '200' }), 422, 'VALIDATION_FAILED');
  });

  it('only fnb.manage changes the menu; fnb.order reads it', async () => {
    const w = await sunset(); const s = await shop(w);
    const fd = await staff(w, 'kitchen_support');
    await ok(call('GET', R(w, `outlets/${s.outlet}/menu`), fd.h));
    expect((await call('POST', R(w, 'outlets'), fd.h, { name: 'Nope' })).statusCode).toBe(403);
  });

  it('an order uses the size price, adds option prices, keeps removals, and enforces the rules', async () => {
    const w = await sunset(); const s = await shop(w); const { stay } = await inHouse(w);
    const d = await dish(w, s.cat, { name: 'Biryani', price: '900', ingredients: ['rice', 'onion'], removableIngredients: ['onion'], minQuantity: 1, maxQuantity: 3 });
    const half = (await ok(call('POST', R(w, `menu-items/${d.id}/variants`), O, { name: 'Half', price: '600' }), 201)).id;
    const full = (await ok(call('POST', R(w, `menu-items/${d.id}/variants`), O, { name: 'Full', price: '1100' }), 201)).id;
    const g = (await ok(call('POST', R(w, 'modifier-groups'), O, { name: 'Raita', minSelect: 0, maxSelect: 1 }), 201)).id;
    const raita = (await ok(call('POST', R(w, `modifier-groups/${g}/options`), O, { name: 'Extra raita', priceDelta: '100' }), 201)).id;
    await ok(call('PUT', R(w, `menu-items/${d.id}/modifier-groups`), O, { groupIds: [g] }));

    await code(order(w, stay, [{ menuItemId: d.id }]), 422, 'VARIANT_REQUIRED');
    await code(order(w, stay, [{ menuItemId: d.id, variantId: full, removed: ['rice'] }]), 422, 'CANNOT_REMOVE');
    await code(order(w, stay, [{ menuItemId: d.id, variantId: full, quantity: 4 }]), 422, 'QUANTITY_TOO_HIGH');
    const x = await (await order(w, stay, [{ menuItemId: d.id, variantId: full, quantity: 2, modifierOptionIds: [raita], removed: ['onion'] }])).json();
    expect(x.total.amount).toBe('2400.00');                                               // (1100 + 100) × 2
    expect(x.lines[0]).toMatchObject({ variant: 'Full', removed: ['onion'], modifiers: [{ name: 'Extra raita' }] });
    expect(half).toBeTruthy();
  });

  it('a limited dish is counted down, refused when gone, and restored when the order is cancelled', async () => {
    const w = await sunset(); const s = await shop(w); const { stay } = await inHouse(w);
    const d = await dish(w, s.cat, { name: 'Nihari', availability: 'LIMITED', limitedQuantity: 2 });
    const a = await (await order(w, stay, [{ menuItemId: d.id, quantity: 2 }])).json();
    expect(a.lines[0].quantity).toBe(2);
    await code(order(w, stay, [{ menuItemId: d.id }]), 422, 'ITEM_NOT_ORDERABLE');
    await ok(call('POST', R(w, `fnb/orders/${a.id}/cancel`), O, { reason: 'Guest changed mind' }));
    expect((await ok(call('GET', R(w, `menu-items/${d.id}`), O))).limitedQuantity).toBe(2);
    await ok(call('PATCH', R(w, `menu-items/${d.id}`), O, { availability: 'SOLD_OUT', version: (await ok(call('GET', R(w, `menu-items/${d.id}`), O))).version }));
    await code(order(w, stay, [{ menuItemId: d.id }]), 422, 'ITEM_NOT_ORDERABLE');
  });

  it('a menu is only served on its days and hours, and a closed outlet refuses orders', async () => {
    const w = await sunset(); const s = await shop(w); const { stay } = await inHouse(w);       // 13:00 on 2026-11-05 (Thursday)
    const lunch = (await ok(call('POST', R(w, `outlets/${s.outlet}/menus`), O, { name: 'Breakfast', availableFrom: '07:00', availableTo: '11:00' }), 201)).id;
    const cat = (await ok(call('POST', R(w, `menus/${lunch}/categories`), O, { name: 'Eggs' }), 201)).id;
    const omelette = await dish(w, cat, { name: 'Omelette', price: '400' });
    await code(order(w, stay, [{ menuItemId: omelette.id }]), 422, 'ITEM_NOT_ORDERABLE');
    at('2026-11-05', '08:00');
    await ok(order(w, stay, [{ menuItemId: omelette.id }]), 201);
    await ok(call('PATCH', R(w, `outlets/${s.outlet}`), O, { status: 'INACTIVE' }));
    await code(order(w, stay, [{ menuItemId: omelette.id }]), 422, 'ITEM_NOT_ORDERABLE');
  });
});
