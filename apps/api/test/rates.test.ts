import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { withTenant } from '@hos/db';
import { InventoryService } from '../src/inventory/inventory.service.js';
import { QuoteSigner } from '../src/rates/quote-signer.js';
import { runWithTenant } from '../src/tenancy/tenant-context.js';
import { addUser, adminDb, appDb, as, assignRole, createTestApp, provision } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
let O: Record<string, string>;
const OPEN = '2026-11-01';                       // Sunday. 2026-11-05 Thu · 06 Fri · 07 Sat · 08 Sun · 09 Mon
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown) =>
  app.inject({ method, url, headers, payload: body as object | undefined });

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'rates'); O = as(T.tenantId, T.ownerUserId); });
afterAll(async () => { await app.close(); });

/** A live property shaped like Boulevard (3 types × 3 rooms) with BAR, INTL and CORP plans priced like the design examples. */
async function sunset(code: string, o: { cancellation?: boolean } = {}) {
  const p = await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code, name: `Sunset ${code}` });
  const propertyId = p.json().id as string;
  const rt: Record<string, string> = {};
  for (const [c, n] of [['STD', 'Standard'], ['DLX', 'Deluxe'], ['EXE', 'Executive']] as const) {
    rt[c] = (await call('POST', `/v1/properties/${propertyId}/room-types`, O, { code: c, name: n, maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id;
  }
  const start = { STD: 101, DLX: 201, EXE: 301 };
  for (const c of ['STD', 'DLX', 'EXE'] as const) await call('POST', `/v1/properties/${propertyId}/rooms/bulk`, O, { roomTypeId: rt[c], from: start[c], to: start[c] + 2 });
  expect((await call('POST', `/v1/properties/${propertyId}/go-live`, O, { openingBusinessDate: OPEN })).statusCode).toBe(200);

  const bar = await call('POST', `/v1/properties/${propertyId}/rate-plans`, O, {
    code: 'BAR', name: 'Best Available Rate (local)', residency: 'RESIDENT', extraBed: '2000',
    ...(o.cancellation === false ? {} : { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } }),
  });
  expect(bar.statusCode, bar.body).toBe(201);
  const barId = bar.json().id as string;
  const rates = await call('PUT', `/v1/properties/${propertyId}/rate-plans/${barId}/base-rates`, O, { items: [
    { roomTypeId: rt.STD, amount: '12000', weekendAmount: '15000', extraAdult: '3000', extraChild: '1500' },
    { roomTypeId: rt.DLX, amount: '15000', extraAdult: '3500', extraChild: '1500' },
    { roomTypeId: rt.EXE, amount: '20000', weekendAmount: '24000', extraAdult: '4000', extraChild: '2000' }] });
  expect(rates.statusCode, rates.body).toBe(200);
  const intl = await call('POST', `/v1/properties/${propertyId}/rate-plans`, O, { code: 'INTL', name: 'International guests', residency: 'NON_RESIDENT', derive: { parentPlanId: barId, type: 'PERCENT', value: 2500, roundTo: '100' } });
  expect(intl.statusCode, intl.body).toBe(201);
  return { propertyId, rt, barId, intlId: intl.json().id as string };
}
const quote = (propertyId: string, body: Record<string, unknown>, headers = O) =>
  call('POST', `/v1/properties/${propertyId}/quotes`, headers, { arrival: '2026-11-05', departure: '2026-11-07', adults: 2, ...body });
const pick = (q: any, room: string, plan: string) => q.options.find((o: any) => o.roomType.code === room && o.plan.code === plan);

describe('rate plans and prices', () => {
  it('builds BAR / INTL and shows weekday vs weekend prices with their source in the calendar', async () => {
    const { propertyId, barId, intlId } = await sunset('R1');
    const cal = (await call('GET', `/v1/properties/${propertyId}/rate-calendar?planId=${barId}&from=2026-11-05&to=2026-11-09`, O)).json();
    const std = cal.roomTypes.find((r: any) => r.code === 'STD');
    expect(std.nights.map((n: any) => [n.date, n.price, n.source])).toEqual([
      ['2026-11-05', '12000.00', 'BASE'], ['2026-11-06', '15000.00', 'WEEKEND'], ['2026-11-07', '15000.00', 'WEEKEND'], ['2026-11-08', '12000.00', 'BASE']]);
    expect(std.nights[0].available).toBe(3);
    expect(cal.weekendDays).toEqual([5, 6]);
    const intl = (await call('GET', `/v1/properties/${propertyId}/rate-calendar?planId=${intlId}&from=2026-11-05&to=2026-11-07`, O)).json();
    expect(intl.roomTypes.find((r: any) => r.code === 'STD').nights.map((n: any) => n.price)).toEqual(['15000.00', '18800.00']);    // +25%, rounded to Rs 100
    const plan = (await call('GET', `/v1/properties/${propertyId}/rate-plans/${barId}`, O)).json();
    expect(plan.baseRates).toHaveLength(3);
    expect(plan.cancellationRule).toMatchObject({ freeUntilHoursBefore: 72 });
  });

  it('the weekend is configurable per property', async () => {
    const { propertyId, barId } = await sunset('R2');
    const cur = (await call('GET', `/v1/properties/${propertyId}`, O)).json();
    expect((await call('PATCH', `/v1/properties/${propertyId}`, O, { weekendDays: [4, 5], version: cur.version })).statusCode).toBe(200);          // Thu+Fri nights
    const cal = (await call('GET', `/v1/properties/${propertyId}/rate-calendar?planId=${barId}&from=2026-11-05&to=2026-11-08`, O)).json();
    expect(cal.roomTypes.find((r: any) => r.code === 'STD').nights.map((n: any) => n.price)).toEqual(['15000.00', '15000.00', '12000.00']);
  });

  it('seasons beat the base rate, an override beats a season, and deleting a season restores the base rate', async () => {
    const { propertyId, barId, rt } = await sunset('R3');
    const s = await call('POST', `/v1/properties/${propertyId}/rate-plans/${barId}/seasons`, O, { name: 'Eid', startDate: '2026-11-05', endDate: '2026-11-08', priority: 5,
      values: [{ roomTypeId: rt.STD, amount: '20000', weekendAmount: '25000' }] });
    expect(s.statusCode, s.body).toBe(201);
    let cal = (await call('GET', `/v1/properties/${propertyId}/rate-calendar?planId=${barId}&from=2026-11-05&to=2026-11-09`, O)).json().roomTypes.find((r: any) => r.code === 'STD').nights;
    expect(cal.map((n: any) => [n.price, n.source])).toEqual([['20000.00', 'SEASON:Eid'], ['25000.00', 'SEASON:Eid'], ['25000.00', 'SEASON:Eid'], ['12000.00', 'BASE']]);
    const ov = await call('POST', `/v1/properties/${propertyId}/rate-plans/${barId}/overrides`, O, { roomTypeId: rt.STD, from: '2026-11-06', to: '2026-11-07', amount: '22000' });
    expect(ov.statusCode, ov.body).toBe(200);
    cal = (await call('GET', `/v1/properties/${propertyId}/rate-calendar?planId=${barId}&from=2026-11-05&to=2026-11-07`, O)).json().roomTypes.find((r: any) => r.code === 'STD').nights;
    expect(cal[1]).toMatchObject({ price: '22000.00', source: 'OVERRIDE' });
    await call('DELETE', `/v1/properties/${propertyId}/rate-plans/${barId}/seasons/${s.json().id}`, O);
    cal = (await call('GET', `/v1/properties/${propertyId}/rate-calendar?planId=${barId}&from=2026-11-05&to=2026-11-07`, O)).json().roomTypes.find((r: any) => r.code === 'STD').nights;
    expect(cal.map((n: any) => n.price)).toEqual(['12000.00', '22000.00']);
  });

  it('bulk price edits: dry-run preview, big changes need confirmation, then they apply', async () => {
    const { propertyId, barId, rt } = await sunset('R4');
    const url = `/v1/properties/${propertyId}/rate-plans/${barId}/overrides`;
    const body = { roomTypeId: rt.DLX, from: '2026-12-20', to: '2026-12-24', amount: '30000' };            // 15,000 → 30,000 = +100%
    const dry = (await call('POST', url, O, { ...body, dryRun: true })).json();
    expect(dry).toMatchObject({ applied: false, nights: 4, warningCount: 4 });
    expect(dry.preview[0]).toMatchObject({ date: '2026-12-20', current: '15000.00', new: '30000.00' });
    const refused = await call('POST', url, O, body);
    expect(refused.statusCode).toBe(409); expect(refused.json().code).toBe('CONFIRMATION_REQUIRED');
    const cal0 = (await call('GET', `/v1/properties/${propertyId}/rate-calendar?planId=${barId}&from=2026-12-20&to=2026-12-21`, O)).json();
    expect(cal0.roomTypes.find((r: any) => r.code === 'DLX').nights[0].price).toBe('15000.00');            // nothing applied
    const ok = await call('POST', url, O, { ...body, confirmWarnings: true });
    expect(ok.json().applied).toBe(true);
    const small = await call('POST', url, O, { roomTypeId: rt.DLX, from: '2026-12-26', to: '2026-12-27', amount: '16000' });          // +6.7% → no confirmation needed
    expect(small.statusCode).toBe(200);
    expect((await call('POST', url, O, { roomTypeId: rt.DLX, from: '2026-12-26', to: '2026-12-27', amount: '0' })).json().code).toBe('PRICE_INVALID');
  });

  it('rejects nonsense with clear errors', async () => {
    const { propertyId, barId, intlId, rt } = await sunset('R5');
    const post = (path: string, body: unknown) => call('POST', `/v1/properties/${propertyId}${path}`, O, body);
    expect((await post('/rate-plans', { code: 'BAR', name: 'Duplicate' })).json().code).toBe('DUPLICATE');
    expect((await post('/rate-plans', { code: 'CH', name: 'Chain', derive: { parentPlanId: intlId, type: 'PERCENT', value: 1000, roundTo: '1' } })).json().code).toBe('DERIVE_DEPTH');
    expect((await post('/rate-plans', { code: 'BADP', name: 'Bad', derive: { parentPlanId: barId, type: 'PERCENT', value: '10.5', roundTo: '1' } })).statusCode).toBe(400);
    expect((await post('/rate-plans', { code: 'X1', name: 'Bad money', extraBed: '12.345' })).statusCode).toBe(400);
    expect((await call('PUT', `/v1/properties/${propertyId}/rate-plans/${barId}/base-rates`, O, { items: [{ roomTypeId: rt.STD, amount: '12000', weekendAmount: '3000' }] })).json().code).toBe('PRICE_SUSPICIOUS');
    expect((await call('PUT', `/v1/properties/${propertyId}/rate-plans/${intlId}/base-rates`, O, { items: [{ roomTypeId: rt.STD, amount: '1' }] })).json().code).toBe('DERIVED_PLAN');
    expect((await post(`/rate-plans/${barId}/restrictions`, { startDate: '2026-11-01', endDate: '2026-11-05' })).statusCode).toBe(400);               // restricts nothing
    expect((await call('PATCH', `/v1/properties/${propertyId}/rate-plans/${barId}`, O, { name: 'Stale', version: 999 })).statusCode).toBe(412);
  });
});

describe('quotes: availability + price + eligibility in one call', () => {
  it('prices a Thu→Sat stay for a local guest; INTL is hidden unless asked for; totals exclude tax', async () => {
    const { propertyId } = await sunset('Q1');
    const q = (await quote(propertyId, {})).json();
    expect(q).toMatchObject({ nights: 2, currency: 'PKR' });
    const std = pick(q, 'STD', 'BAR');
    expect(std).toMatchObject({ sellable: true, bookable: true, roomsLeft: 3, subtotal: { amount: '27000.00' }, totalExTax: { amount: '27000.00' } });   // 12,000 Thu + 15,000 Fri
    expect(std.nights.map((n: any) => n.total)).toEqual(['12000.00', '15000.00']);
    expect(std.taxNote).toMatch(/exclude tax/i);
    expect(pick(q, 'DLX', 'BAR').subtotal.amount).toBe('30000.00');
    expect(pick(q, 'EXE', 'BAR').subtotal.amount).toBe('44000.00');
    expect(pick(q, 'STD', 'INTL')).toBeUndefined();
    const all = (await quote(propertyId, { includeUnavailable: true })).json();
    expect(pick(all, 'STD', 'INTL')).toMatchObject({ sellable: false, bookable: false, quoteToken: null });
    expect(pick(all, 'STD', 'INTL').reasons[0].code).toBe('RESIDENCY_MISMATCH');
  });

  it('a non-resident sees the international rate and not the local one', async () => {
    const { propertyId } = await sunset('Q2');
    const q = (await quote(propertyId, { residency: 'NON_RESIDENT' })).json();
    expect(pick(q, 'STD', 'INTL').subtotal.amount).toBe('33800.00');                                           // 15,000 + 18,800
    expect(pick(q, 'STD', 'BAR')).toBeUndefined();
  });

  it('extra guests, children and extra beds are priced per night', async () => {
    const { propertyId } = await sunset('Q3');
    const q = (await quote(propertyId, { adults: 3, children: 1, extraBeds: 1, departure: '2026-11-06' })).json();     // one Thursday night
    expect(pick(q, 'STD', 'BAR').nights[0]).toMatchObject({ room: '12000.00', extras: '6500.00', total: '18500.00' }); // +3000 adult +1500 child +2000 bed
    const tooMany = (await quote(propertyId, { adults: 3, children: 2, includeUnavailable: true })).json();
    expect(pick(tooMany, 'STD', 'BAR').reasons.map((r: any) => r.code)).toContain('OCCUPANCY_EXCEEDED');
  });

  it('returns a signed, tamper-proof, expiring quote token that carries the deposit', async () => {
    const { propertyId, barId } = await sunset('Q4');
    const std = pick((await quote(propertyId, {})).json(), 'STD', 'BAR');
    expect(std.depositDue.amount).toBe('12000.00');                                                            // first night
    const signer = app.get(QuoteSigner);
    const claims = await runWithTenant({ tenantId: T.tenantId, actorId: T.ownerUserId }, async () => signer.verify(std.quoteToken));
    expect(claims).toMatchObject({ planId: barId, subtotalMinor: '2700000', depositDueMinor: '1200000', arrival: '2026-11-05', departure: '2026-11-07', propertyId });
    const [body, sig] = std.quoteToken.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, subtotalMinor: '100' })).toString('base64url');
    await runWithTenant({ tenantId: T.tenantId, actorId: T.ownerUserId }, async () => {
      expect(() => signer.verify(`${forged}.${sig}`)).toThrow(/invalid or has expired/);
      expect(() => signer.verify(`${body}.AAAA`)).toThrow();
      expect(() => signer.verify(std.quoteToken, Date.now() + 16 * 60_000)).toThrow(/invalid or has expired/);
    });
    const other = await provision(app, 'rates-other');
    await runWithTenant({ tenantId: other.tenantId, actorId: other.ownerUserId }, async () => { expect(() => signer.verify(std.quoteToken)).toThrow(); });   // another tenant cannot use it
  });

  it('sold-out room types drop out of the default list and show roomsLeft = 0 when asked for', async () => {
    const { propertyId, rt } = await sunset('Q5');
    const inv = app.get(InventoryService);
    await runWithTenant({ tenantId: T.tenantId, actorId: T.ownerUserId }, () => withTenant(appDb, T.tenantId, (trx) =>
      inv.reserve(trx, { propertyId, roomTypeId: rt.STD!, arrival: '2026-11-06', departure: '2026-11-07', rooms: 3 })));
    const q = (await quote(propertyId, {})).json();
    expect(pick(q, 'STD', 'BAR')).toBeUndefined();
    expect(pick(q, 'DLX', 'BAR')).toBeDefined();
    const all = (await quote(propertyId, { includeUnavailable: true })).json();
    expect(pick(all, 'STD', 'BAR')).toMatchObject({ roomsLeft: 0, bookable: false, quoteToken: null });
    expect(pick(all, 'STD', 'BAR').reasons.map((r: any) => r.code)).toContain('SOLD_OUT');
    const oneNight = (await quote(propertyId, { departure: '2026-11-06' })).json();                           // Thursday only: still free
    expect(pick(oneNight, 'STD', 'BAR').roomsLeft).toBe(3);
  });

  it('restrictions hide plans with clear reasons (stop-sell, closed to arrival, minimum stay)', async () => {
    const { propertyId, barId, rt } = await sunset('Q6');
    const r = (b: object) => call('POST', `/v1/properties/${propertyId}/rate-plans/${barId}/restrictions`, O, b);
    const stop = await r({ roomTypeId: rt.EXE, startDate: '2026-11-06', endDate: '2026-11-07', stopSell: true });
    await r({ roomTypeId: rt.DLX, startDate: '2026-11-05', endDate: '2026-11-06', closedToArrival: true });
    await r({ startDate: '2026-11-01', endDate: '2026-11-30', roomTypeId: rt.STD, minLos: 3 });
    const q = (await quote(propertyId, { includeUnavailable: true })).json();
    expect(pick(q, 'EXE', 'BAR').reasons.map((x: any) => x.code)).toEqual(['STOP_SELL']);
    expect(pick(q, 'DLX', 'BAR').reasons.map((x: any) => x.code)).toEqual(['CLOSED_TO_ARRIVAL']);
    expect(pick(q, 'STD', 'BAR').reasons.map((x: any) => x.code)).toEqual(['MIN_LOS']);
    await call('DELETE', `/v1/properties/${propertyId}/rate-plans/${barId}/restrictions/${stop.json().id}`, O);
    expect(pick((await quote(propertyId, {})).json(), 'EXE', 'BAR')).toBeDefined();
  });

  it('corporate rates are only offered to the contracted company', async () => {
    const { propertyId, barId } = await sunset('Q7');
    const company = (await call('POST', '/v1/companies', O, { name: 'ACME Q7' })).json().id as string;
    const other = (await call('POST', '/v1/companies', O, { name: 'Other Q7' })).json().id as string;
    const corp = await call('POST', `/v1/properties/${propertyId}/rate-plans`, O, { code: 'CORP-ACME', name: 'ACME corporate', audience: 'CORPORATE', companyIds: [company],
      derive: { parentPlanId: barId, type: 'PERCENT', value: -1500, roundTo: '100' }, channels: ['CORPORATE', 'PHONE', 'DIRECT'] });
    expect(corp.statusCode, corp.body).toBe(201);
    expect(pick((await quote(propertyId, {})).json(), 'STD', 'CORP-ACME')).toBeUndefined();
    const q = (await quote(propertyId, { companyId: company })).json();
    expect(pick(q, 'STD', 'CORP-ACME').subtotal.amount).toBe('23000.00');                                     // 12,000 → 10,200; 15,000 → 12,750 → rounded to the Rs 100 step = 12,800
    expect(pick(await quote(propertyId, { companyId: other }).then((r) => r.json()), 'STD', 'CORP-ACME')).toBeUndefined();
    const ghost = await quote(propertyId, { companyId: crypto.randomUUID() });
    expect(ghost.statusCode).toBe(422); expect(ghost.json().code).toBe('COMPANY_NOT_FOUND');
  });

  it('discounts: within the user\'s limit is applied; above it needs approval and yields no bookable token', async () => {
    const { propertyId } = await sunset('Q8');
    const u = await addUser(T.tenantId, 'limited@rates.test');
    await assignRole(T.tenantId, u, 'front_desk_agent', 'PROPERTY', propertyId, { limits: { maxDiscountPct: 10 } });
    const lim = as(T.tenantId, u);
    const ok = pick((await quote(propertyId, { discountPct: 10 }, lim)).json(), 'STD', 'BAR');
    expect(ok).toMatchObject({ bookable: true, totalExTax: { amount: '24300.00' }, discount: { pct: 10, amount: '2700.00', status: 'APPLIED' } });
    const over = pick((await quote(propertyId, { discountPct: 15 }, lim)).json(), 'STD', 'BAR');
    expect(over).toMatchObject({ bookable: false, quoteToken: null, discount: { status: 'APPROVAL_REQUIRED' } });
    const owner = pick((await quote(propertyId, { discountPct: 15 })).json(), 'STD', 'BAR');
    expect(owner).toMatchObject({ bookable: true, discount: { status: 'APPLIED' } });                          // owner has no limit
  });

  it('refuses quotes in the past, outside permission, and for other tenants', async () => {
    const { propertyId } = await sunset('Q9');
    expect((await quote(propertyId, { arrival: '2026-10-30', departure: '2026-11-02' })).json().code).toBe('DATE_IN_PAST');
    expect((await quote(propertyId, { departure: '2026-11-05' })).statusCode).toBe(400);                        // departure not after arrival
    const hk = await addUser(T.tenantId, 'hk@rates.test'); await assignRole(T.tenantId, hk, 'housekeeper', 'PROPERTY', propertyId);
    expect((await quote(propertyId, {}, as(T.tenantId, hk))).statusCode).toBe(403);
    const B = await provision(app, 'rates-b');
    expect((await quote(propertyId, {}, as(B.tenantId, B.ownerUserId))).statusCode).toBe(404);
  });
});

describe('who may touch rates, and the trail they leave', () => {
  it('front desk can read plans and the calendar but cannot change prices; a property GM can', async () => {
    const { propertyId, barId, rt } = await sunset('PX1');
    const fd = await addUser(T.tenantId, 'fd@rates.test'); await assignRole(T.tenantId, fd, 'front_desk_agent', 'PROPERTY', propertyId);
    const gm = await addUser(T.tenantId, 'gm@rates.test'); await assignRole(T.tenantId, gm, 'general_manager', 'PROPERTY', propertyId);
    expect((await call('GET', `/v1/properties/${propertyId}/rate-plans`, as(T.tenantId, fd))).statusCode).toBe(200);
    expect((await call('GET', `/v1/properties/${propertyId}/rate-calendar?planId=${barId}&from=2026-11-05&to=2026-11-06`, as(T.tenantId, fd))).statusCode).toBe(200);
    expect((await call('POST', `/v1/properties/${propertyId}/rate-plans/${barId}/overrides`, as(T.tenantId, fd), { roomTypeId: rt.STD, from: '2026-11-05', to: '2026-11-06', amount: '12500' })).statusCode).toBe(403);
    expect((await call('POST', `/v1/properties/${propertyId}/rate-plans/${barId}/overrides`, as(T.tenantId, gm), { roomTypeId: rt.STD, from: '2026-11-05', to: '2026-11-06', amount: '12500' })).statusCode).toBe(200);
  });
  it('every price change is audited with before/after and emits a RateChanged event', async () => {
    const { propertyId, barId, rt } = await sunset('PX2');
    await call('POST', `/v1/properties/${propertyId}/rate-plans/${barId}/overrides`, O, { roomTypeId: rt.STD, from: '2026-11-05', to: '2026-11-07', amount: '13000' });
    const rows = await adminDb.selectFrom('audit_log').select(['action', 'before', 'after', 'actor_id']).where('tenant_id', '=', T.tenantId).where('property_id', '=', propertyId).execute();
    const actions = rows.map((r) => r.action);
    for (const a of ['rate_plan.create', 'rate.base_set', 'rate.override_set']) expect(actions, a).toContain(a);
    const ov = rows.find((r) => r.action === 'rate.override_set')!;
    expect(JSON.stringify(ov.before)).toContain('12000.00');                                                  // what the price was
    expect(JSON.stringify(ov.after)).toContain('13000');                                                      // what it became
    expect(ov.actor_id).toBe(T.ownerUserId);
    const ev = await adminDb.selectFrom('outbox_event').select('event_type').where('tenant_id', '=', T.tenantId).where('property_id', '=', propertyId).execute();
    expect(ev.map((e) => e.event_type)).toContain('RateChanged');
  });
});
