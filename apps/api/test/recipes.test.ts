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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'recipes'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@recipes.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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


const sid = (w: W, name: string, unit: string, cost: string, costPer: string) => ok(call('POST', R(w, 'stock-items'), O, { name, unit, cost, costPer }), 201);
const content = (lines: unknown[], o: Record<string, unknown> = {}) => ({ yieldQty: 2, yieldUnit: 'portion', steps: ['Heat the oil', 'Cook the chicken', 'Add gravy and finish'], equipment: ['Karahi'], cookingMethod: 'Wok, high flame', temperature: '220 °C', cookMinutes: 25, plating: 'In a copper karahi with julienne ginger', foodSafety: 'Chicken to 75 °C at the core', lines, ...o });

async function kitchen() {
  const w = await sunset(); const s = await shop(w);
  const chicken = await sid(w, 'Chicken', 'g', '600', 'kg'); const tomato = await sid(w, 'Tomato', 'g', '200', 'kg'); const oil = await sid(w, 'Cooking oil', 'ml', '500', 'l');
  for (const [i, q] of [[chicken, 5000], [tomato, 3000], [oil, 2000]] as const) await ok(call('POST', R(w, `stock-items/${i.id}/movements`), O, { kind: 'RECEIVE', qty: q }));
  const gravy = (await ok(call('POST', R(w, 'recipes'), O, { name: 'Karahi gravy', kind: 'SUB_RECIPE' }), 201));
  await ok(call('PUT', R(w, `recipe-versions/${gravy.versionId}`), O, content([{ stockItemId: tomato.id, qty: 500, wastePct: 20 }, { stockItemId: oil.id, qty: 100 }], { yieldQty: 1000, yieldUnit: 'g' })));
  await ok(call('POST', R(w, `recipe-versions/${gravy.versionId}/approve`), O));
  const menuItem = await dish(w, s.cat, { name: 'Chicken Karahi', price: '1850' });
  const karahi = await ok(call('POST', R(w, 'recipes'), O, { name: 'Chicken Karahi', kind: 'DISH', menuItemId: menuItem.id }), 201);
  await ok(call('PUT', R(w, `recipe-versions/${karahi.versionId}`), O, content([{ stockItemId: chicken.id, qty: 0.6, unit: 'kg' }, { subRecipeId: gravy.id, qty: 200 }])));
  return { w, s, chicken, tomato, oil, gravy, karahi, menuItem };
}

describe('recipes and stock', () => {
  it('costs a dish through its sub-recipe, with waste and unit conversion, against the menu price', async () => {
    const k = await kitchen();
    const c = await ok(call('GET', R(k.w, `recipe-versions/${k.karahi.versionId}/cost`), O));
    expect(c.batch.amount).toBe('395.00'); expect(c.perUnit.amount).toBe('197.50'); expect(c.price.amount).toBe('1850.00'); expect(c.foodCostPct).toBe(10.7); expect(c.margin.amount).toBe('1652.50');
    expect(c.missingCosts).toEqual([]);
    const list = (await ok(call('GET', R(k.w, 'recipes'), O))).items;
    expect(list.find((r: any) => r.name === 'Karahi gravy')).toMatchObject({ approvedVersion: 1, costPerUnit: { amount: '0.18' } });         // 17.5 paisa a gram, shown to the paisa
    expect(list.find((r: any) => r.name === 'Chicken Karahi')).toMatchObject({ approvedVersion: null, hasDraft: true, dish: 'Chicken Karahi' });
  });

  it('a draft needs approval by someone allowed to approve; an approved version cannot be edited, a new one is a copy, and the old one is kept', async () => {
    const k = await kitchen(); const cook = await staff(k.w, 'kitchen_cook'); const chef = await staff(k.w, 'head_chef');
    await code(call('POST', R(k.w, `recipe-versions/${k.karahi.versionId}/approve`), cook.h), 403, 'PERMISSION_DENIED');
    await ok(call('POST', R(k.w, `recipe-versions/${k.karahi.versionId}/approve`), chef.h));
    await code(call('PUT', R(k.w, `recipe-versions/${k.karahi.versionId}`), O, content([{ stockItemId: k.chicken.id, qty: 1 }])), 409, 'NOT_A_DRAFT');
    const v2 = await ok(call('POST', R(k.w, `recipes/${k.karahi.id}/versions`), O), 201);
    await code(call('POST', R(k.w, `recipes/${k.karahi.id}/versions`), O), 409, 'DRAFT_EXISTS');
    const d = await ok(call('GET', R(k.w, `recipes/${k.karahi.id}`), O));
    expect(d.version).toMatchObject({ id: v2.id, versionNo: 2, status: 'DRAFT' }); expect(d.version.lines).toHaveLength(2);       // copied from version 1
    await ok(call('PUT', R(k.w, `recipe-versions/${v2.id}`), O, content([{ stockItemId: k.chicken.id, qty: 700, unit: 'g' }, { subRecipeId: k.gravy.id, qty: 200 }], { changeNote: 'More chicken' })));
    await ok(call('POST', R(k.w, `recipe-versions/${v2.id}/approve`), OM));
    const after = await ok(call('GET', R(k.w, `recipes/${k.karahi.id}`), O));
    expect(after.versions.map((v: any) => [v.versionNo, v.status])).toEqual([[2, 'APPROVED'], [1, 'RETIRED']]);
    const card = await ok(call('GET', R(k.w, `menu-items/${k.menuItem.id}/recipe-card`), (await staff(k.w, 'kitchen_support')).h));
    expect(card).toMatchObject({ available: true, versionNo: 2, steps: ['Heat the oil', 'Cook the chicken', 'Add gravy and finish'], equipment: ['Karahi'], foodSafety: 'Chicken to 75 °C at the core' });
    expect(JSON.stringify(card)).not.toContain('cost');
    expect((await ok(call('GET', R(k.w, `menu-items/${(await dish(k.w, k.s.cat)).id}/recipe-card`), O))).available).toBe(false);
  });

  it('refuses an empty recipe, a recipe that uses itself, and a unit that does not fit', async () => {
    const k = await kitchen();
    const empty = await ok(call('POST', R(k.w, 'recipes'), O, { name: 'Empty', kind: 'DISH' }), 201);
    await code(call('POST', R(k.w, `recipe-versions/${empty.versionId}/approve`), O), 422, 'RECIPE_EMPTY');
    await code(call('PUT', R(k.w, `recipe-versions/${k.karahi.versionId}`), O, content([{ stockItemId: k.oil.id, qty: 1, unit: 'kg' }])), 422, 'UNIT_MISMATCH');
    const a = await ok(call('POST', R(k.w, 'recipes'), O, { name: 'Masala A', kind: 'SUB_RECIPE' }), 201); const b = await ok(call('POST', R(k.w, 'recipes'), O, { name: 'Masala B', kind: 'SUB_RECIPE' }), 201);
    await ok(call('PUT', R(k.w, `recipe-versions/${b.versionId}`), O, content([{ stockItemId: k.tomato.id, qty: 100 }], { yieldQty: 500, yieldUnit: 'g' })));
    await ok(call('POST', R(k.w, `recipe-versions/${b.versionId}/approve`), O));
    await ok(call('PUT', R(k.w, `recipe-versions/${a.versionId}`), O, content([{ subRecipeId: b.id, qty: 100 }], { yieldQty: 500, yieldUnit: 'g' })));
    await ok(call('POST', R(k.w, `recipe-versions/${a.versionId}/approve`), O));
    const b2 = await ok(call('POST', R(k.w, `recipes/${b.id}/versions`), O), 201);
    await code(call('PUT', R(k.w, `recipe-versions/${b2.id}`), O, content([{ subRecipeId: a.id, qty: 50 }], { yieldQty: 500, yieldUnit: 'g' })), 422, 'RECIPE_LOOP');
    await code(call('POST', R(k.w, 'recipes'), O, { name: 'Second karahi', kind: 'DISH', menuItemId: k.menuItem.id }), 409, 'DUPLICATE');
  });

  it('delivering an order takes the food out of stock by the approved recipe, once, and less what the guest left out; every change is a movement', async () => {
    const k = await kitchen(); const { stay } = await inHouse(k.w);
    const stockOf = async (id: string) => (await ok(call('GET', R(k.w, 'stock-items'), O))).items.find((x: any) => x.id === id);
    await ok(call('POST', R(k.w, `recipe-versions/${k.karahi.versionId}/approve`), O));
    const o = await (await order(k.w, stay, [{ menuItemId: k.menuItem.id, quantity: 1 }])).json();
    expect((await stockOf(k.chicken.id)).onHand).toBe(5000);                                // nothing leaves the store until the food is handed over
    await ok(call('POST', R(k.w, `fnb/orders/${o.id}/deliver`), O));
    expect((await stockOf(k.chicken.id)).onHand).toBe(4700);                                // 600 g for 2 portions → 300 g for 1
    expect((await stockOf(k.tomato.id)).onHand).toBeCloseTo(3000 - 625 * 0.1, 3);          // 100 g of the 1000 g gravy batch, 625 g tomato per batch
    expect((await stockOf(k.oil.id)).onHand).toBeCloseTo(2000 - 10, 3);
    const mv = (await ok(call('GET', R(k.w, `stock-items/${k.chicken.id}/movements`), O))).items;
    expect(mv.map((m: any) => [m.kind, m.qty])).toEqual([['SALE', -300], ['RECEIVE', 5000]]);
    await ok(call('POST', R(k.w, `stock-items/${k.chicken.id}/movements`), O, { kind: 'WASTE', qty: 0.2, unit: 'kg', note: 'Dropped tray' }));
    await code(call('POST', R(k.w, `stock-items/${k.chicken.id}/movements`), O, { kind: 'ADJUST', counted: 4500 }), 400, 'VALIDATION_FAILED');       // a reason is needed
    await ok(call('POST', R(k.w, `stock-items/${k.chicken.id}/movements`), O, { kind: 'ADJUST', counted: 4000, note: 'Stock take' }));
    expect((await stockOf(k.chicken.id)).onHand).toBe(4000);
    await ok(call('PATCH', R(k.w, `stock-items/${k.chicken.id}`), O, { reorderLevel: 4500, version: (await stockOf(k.chicken.id)).version }));
    expect((await stockOf(k.chicken.id)).low).toBe(true);
  });
});
