import { describe, expect, it } from 'vitest';
import { cancellationFee, calendarNight, noShowFee, priceStay } from './engine.js';
import type { PriceBook, RatePlanDef, Restriction, RoomTypeLimits, StayRequest } from './types.js';

const R = (rupees: number) => BigInt(rupees) * 100n;           // Rs → minor units
const STD = 'rt-std', DLX = 'rt-dlx', EXE = 'rt-exe';
const WEEKEND = [5, 6];                                         // Fri & Sat nights
// 2026-10-15 Thu · 16 Fri · 17 Sat · 18 Sun · 19 Mon

const basePlan = (o: Partial<RatePlanDef> = {}): RatePlanDef => ({
  id: 'p-bar', code: 'BAR', name: 'Best Available (local)', kind: 'BASE', mealPlan: 'ROOM_ONLY', audience: 'PUBLIC', residency: 'ANY',
  channels: ['DIRECT', 'PHONE', 'WALKIN', 'OTA', 'CORPORATE', 'AGENT'], companyIds: [], minLos: 1, maxLos: null, minAdvanceDays: 0, maxAdvanceDays: null,
  extraBedMinor: R(2000), extraAdultMealMinor: 0n, extraChildMealMinor: 0n, cancellationRule: null, noShowRule: null, depositRule: null,
  validFrom: null, validTo: null, status: 'ACTIVE', currency: 'PKR', ...o,
});
const book = (o: Partial<PriceBook> = {}): PriceBook => ({
  base: {
    [STD]: { amount: R(12000), weekendAmount: R(15000), extraAdult: R(3000), extraChild: R(1500) },
    [DLX]: { amount: R(15000), weekendAmount: null, extraAdult: R(3500), extraChild: R(1500) },
    [EXE]: { amount: R(20000), weekendAmount: R(24000), extraAdult: R(4000), extraChild: R(2000) },
  }, seasons: [], overrides: {}, ...o,
});
const limits: RoomTypeLimits = { maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 };
const stay = (o: Partial<StayRequest> = {}): StayRequest => ({
  roomTypeId: STD, arrival: '2026-10-19', departure: '2026-10-20', adults: 2, children: 0, extraBeds: 0, channel: 'DIRECT', residency: 'RESIDENT',
  companyId: null, today: '2026-10-10', weekendDays: WEEKEND, ...o,
});
const price = (o: { plan?: RatePlanDef; book?: PriceBook; restrictions?: Restriction[]; limits?: RoomTypeLimits; req?: Partial<StayRequest> } = {}) =>
  priceStay({ plan: o.plan ?? basePlan(), book: o.book ?? book(), restrictions: o.restrictions ?? [], limits: o.limits ?? limits, req: stay(o.req) });
const codes = (q: ReturnType<typeof price>) => q.reasons.map((r) => r.code);
const restr = (o: Partial<Restriction>): Restriction => ({ roomTypeId: null, start: '2026-01-01', end: '2027-01-01', closedToArrival: false, closedToDeparture: false, stopSell: false, ...o });

describe('base, weekend, season and override precedence', () => {
  it('prices weekday and weekend nights from the base rate; the departure date is not a night', () => {
    const q = price({ req: { arrival: '2026-10-15', departure: '2026-10-18' } });             // Thu, Fri, Sat nights
    expect(q.nights.map((n) => [n.date, n.source, n.roomMinor])).toEqual([
      ['2026-10-15', 'BASE', R(12000)], ['2026-10-16', 'WEEKEND', R(15000)], ['2026-10-17', 'WEEKEND', R(15000)]]);
    expect(q.subtotalMinor).toBe(R(42000));
    expect(q.sellable).toBe(true);
  });
  it('a room type without a weekend price uses its weekday price every night', () => {
    expect(price({ req: { roomTypeId: DLX, arrival: '2026-10-16', departure: '2026-10-18' } }).subtotalMinor).toBe(R(30000));
  });
  it('the weekend is configurable per property', () => {
    const q = price({ req: { arrival: '2026-10-18', departure: '2026-10-19', weekendDays: [7] } });   // Sunday night as weekend
    expect(q.nights[0]!.source).toBe('WEEKEND');
  });
  it('season beats base; override beats season; highest-priority season wins; season end is exclusive', () => {
    const b = book({
      seasons: [
        { id: 's1', name: 'Summer', start: '2026-10-01', end: '2026-12-01', priority: 0, values: { [STD]: { amount: R(14000), weekendAmount: null } } },
        { id: 's2', name: 'Eid', start: '2026-10-17', end: '2026-10-19', priority: 10, values: { [STD]: { amount: R(25000), weekendAmount: R(30000) } } },
      ],
      overrides: { [`${STD}|2026-10-16`]: R(9999) },
    });
    const q = price({ book: b, req: { arrival: '2026-10-15', departure: '2026-10-20' } });
    expect(q.nights.map((n) => [n.date, n.source, n.roomMinor])).toEqual([
      ['2026-10-15', 'SEASON:Summer', R(14000)],
      ['2026-10-16', 'OVERRIDE', R(9999)],
      ['2026-10-17', 'SEASON:Eid', R(30000)],              // Saturday inside Eid → Eid weekend price
      ['2026-10-18', 'SEASON:Eid', R(25000)],
      ['2026-10-19', 'SEASON:Summer', R(14000)],            // Eid ended (exclusive) → falls back to Summer
    ]);
  });
  it('a season that does not price this room type is ignored for it', () => {
    const b = book({ seasons: [{ id: 's', name: 'DlxOnly', start: '2026-10-01', end: '2026-12-01', priority: 5, values: { [DLX]: { amount: R(99), weekendAmount: null } } }] });
    expect(price({ book: b }).nights[0]!.source).toBe('BASE');
  });
});

describe('occupancy and extras', () => {
  it('base occupancy slots fill with adults first; extra adults, chargeable children, extra beds are added per night', () => {
    const q = price({ req: { adults: 3, children: 1, extraBeds: 1 } });                         // base 2 → 1 extra adult; no free slot → child charged
    expect(q.nights[0]).toMatchObject({ roomMinor: R(12000), extraAdultMinor: R(3000), extraChildMinor: R(1500), extraBedMinor: R(2000), totalMinor: R(18500) });
    expect(q.extrasTotalMinor).toBe(R(6500));
  });
  it('a child uses a free base-occupancy slot when only one adult travels', () => {
    expect(price({ req: { adults: 1, children: 1 } }).nights[0]!.extraChildMinor).toBe(0n);
    expect(price({ req: { adults: 1, children: 2 } }).nights[0]!.extraChildMinor).toBe(R(1500));
  });
  it('meal supplements apply to extra guests only when the plan includes meals', () => {
    const roomOnly = price({ req: { adults: 3 } });
    const bb = price({ plan: basePlan({ mealPlan: 'BREAKFAST', extraAdultMealMinor: R(800), extraChildMealMinor: R(400) }), req: { adults: 3, children: 1 } });
    expect(roomOnly.nights[0]!.mealMinor).toBe(0n);
    expect(bb.nights[0]!.mealMinor).toBe(R(800) + R(400));
  });
  it('an extra bed lets the room take one more person, and the price includes it', () => {
    const tight: RoomTypeLimits = { maxAdults: 2, maxChildren: 1, maxOccupancy: 3, baseOccupancy: 2 };
    expect(codes(price({ limits: tight, req: { adults: 2, children: 2 } }))).toEqual(['OCCUPANCY_EXCEEDED']);          // four in a room made for three
    const withBed = price({ limits: tight, req: { adults: 2, children: 2, extraBeds: 1 } });
    expect(withBed.sellable).toBe(true);
    expect(price({ limits: tight, req: { adults: 2, children: 2, extraBeds: 1 } }).subtotalMinor > price({ limits: tight, req: { adults: 2, children: 1 } }).subtotalMinor).toBe(true);
    expect(codes(price({ limits: tight, req: { adults: 3, children: 1, extraBeds: 1 } }))).toEqual(['OCCUPANCY_EXCEEDED']);   // a bed is not a third adult place
    expect(codes(price({ limits: tight, req: { adults: 2, children: 3, extraBeds: 1 } }))).toEqual(['OCCUPANCY_EXCEEDED']);   // nor two more children
  });
  it('rejects occupancy beyond the room type but still reports the price', () => {
    const q = price({ req: { adults: 3, children: 2 } });                                       // 5 > maxOccupancy 4
    expect(q.sellable).toBe(false); expect(codes(q)).toEqual(['OCCUPANCY_EXCEEDED']); expect(q.subtotalMinor > 0n).toBe(true);
    expect(codes(price({ req: { adults: 0 } }))).toContain('OCCUPANCY_EXCEEDED');
  });
});

describe('derived plans (dual pricing)', () => {
  const intl = (o: Partial<RatePlanDef> = {}) => basePlan({ id: 'p-intl', code: 'INTL', name: 'International', kind: 'DERIVED', residency: 'NON_RESIDENT',
    derive: { type: 'PERCENT', value: 2500n, roundToMinor: 10000n }, ...o });
  it('derives from the parent price and rounds to the chosen step (Rs 100)', () => {
    const q = price({ plan: intl(), req: { residency: 'NON_RESIDENT' } });                      // 12,000 + 25% = 15,000
    expect(q.nights[0]).toMatchObject({ roomMinor: R(15000) });
    const odd = price({ plan: intl(), book: book({ overrides: { [`${STD}|2026-10-19`]: R(12345) } }), req: { residency: 'NON_RESIDENT' } });
    expect(odd.nights[0]!.roomMinor).toBe(R(15400));                                            // 15,431.25 → nearest Rs 100
    expect(odd.nights[0]!.source).toContain('DERIVED');
  });
  it('supports fixed and negative adjustments, never below zero', () => {
    expect(price({ plan: intl({ derive: { type: 'FIXED', value: R(-2000), roundToMinor: 100n } }), req: { residency: 'NON_RESIDENT' } }).nights[0]!.roomMinor).toBe(R(10000));
    expect(price({ plan: intl({ derive: { type: 'FIXED', value: R(-50000), roundToMinor: 100n } }), req: { residency: 'NON_RESIDENT' } }).nights[0]!.roomMinor).toBe(0n);
  });
  it('percentage derivation also scales extra-person prices', () => {
    const q = price({ plan: intl(), req: { residency: 'NON_RESIDENT', adults: 3 } });
    expect(q.nights[0]!.extraAdultMinor).toBe(R(3800));           // 3,000 + 25% = 3,750 → rounded to the Rs 100 step
  });
  it('a resident cannot buy the non-resident rate and vice versa', () => {
    expect(codes(price({ plan: intl() }))).toContain('RESIDENCY_MISMATCH');
    expect(codes(price({ plan: basePlan({ residency: 'RESIDENT' }), req: { residency: 'NON_RESIDENT' } }))).toContain('RESIDENCY_MISMATCH');
  });
});

describe('eligibility', () => {
  it('channel, company, activity and validity windows', () => {
    expect(codes(price({ plan: basePlan({ channels: ['DIRECT'] }), req: { channel: 'OTA' } }))).toEqual(['CHANNEL_NOT_ALLOWED']);
    const corp = basePlan({ audience: 'CORPORATE', companyIds: ['co-1'] });
    expect(codes(price({ plan: corp }))).toEqual(['COMPANY_REQUIRED']);
    expect(codes(price({ plan: corp, req: { companyId: 'co-2' } }))).toEqual(['COMPANY_REQUIRED']);
    expect(price({ plan: corp, req: { companyId: 'co-1' } }).sellable).toBe(true);
    expect(codes(price({ plan: basePlan({ status: 'INACTIVE' }) }))).toEqual(['PLAN_INACTIVE']);
    expect(codes(price({ plan: basePlan({ validTo: '2026-10-18' }), req: { arrival: '2026-10-18', departure: '2026-10-20' } }))).toEqual(['OUTSIDE_VALIDITY']); // night of the 19th is outside
    expect(price({ plan: basePlan({ validTo: '2026-10-18' }), req: { arrival: '2026-10-17', departure: '2026-10-19' } }).sellable).toBe(true);                // last night = 18th (inclusive)
  });
  it('no price for a room type makes the plan unsellable for it', () => {
    const b = book(); delete b.base[STD];
    const q = price({ book: b });
    expect(codes(q)).toEqual(['NO_PRICE']); expect(q.nights).toHaveLength(0);
  });
});

describe('restrictions', () => {
  const arrive = (o: Partial<StayRequest>) => ({ arrival: '2026-10-19', departure: '2026-10-21', ...o });
  it('min/max length of stay (applies by arrival date) and plan defaults', () => {
    expect(codes(price({ restrictions: [restr({ minLos: 3 })], req: arrive({}) }))).toEqual(['MIN_LOS']);
    expect(price({ restrictions: [restr({ minLos: 2 })], req: arrive({}) }).sellable).toBe(true);
    expect(codes(price({ restrictions: [restr({ maxLos: 1 })], req: arrive({}) }))).toEqual(['MAX_LOS']);
    expect(codes(price({ plan: basePlan({ minLos: 3 }), req: arrive({}) }))).toEqual(['MIN_LOS']);
  });
  it('closed to arrival blocks only the arrival date; closed to departure only the departure date', () => {
    const cta = restr({ start: '2026-10-19', end: '2026-10-20', closedToArrival: true });
    expect(codes(price({ restrictions: [cta], req: arrive({}) }))).toEqual(['CLOSED_TO_ARRIVAL']);
    expect(price({ restrictions: [cta], req: arrive({ arrival: '2026-10-18', departure: '2026-10-21' }) }).sellable).toBe(true);   // staying through is fine
    const ctd = restr({ start: '2026-10-21', end: '2026-10-22', closedToDeparture: true });
    expect(codes(price({ restrictions: [ctd], req: arrive({}) }))).toEqual(['CLOSED_TO_DEPARTURE']);
    expect(price({ restrictions: [ctd], req: arrive({ departure: '2026-10-20' }) }).sellable).toBe(true);
  });
  it('stop-sell blocks any stay that includes a night in the range, but not one that departs on its first day', () => {
    const stop = restr({ start: '2026-10-20', end: '2026-10-22', stopSell: true });
    expect(codes(price({ restrictions: [stop], req: arrive({}) }))).toEqual(['STOP_SELL']);
    expect(price({ restrictions: [stop], req: arrive({ arrival: '2026-10-18', departure: '2026-10-20' }) }).sellable).toBe(true);
  });
  it('restrictions for another room type are ignored; overlapping rows combine to the strictest', () => {
    expect(price({ restrictions: [restr({ roomTypeId: DLX, stopSell: true })] }).sellable).toBe(true);
    expect(codes(price({ restrictions: [restr({ roomTypeId: STD, minLos: 2 }), restr({ minLos: 4 })], req: arrive({}) }))).toEqual(['MIN_LOS']);
    expect(codes(price({ restrictions: [restr({ maxLos: 5 }), restr({ maxLos: 1 })], req: arrive({}) }))).toEqual(['MAX_LOS']);
  });
  it('advance-purchase windows use the hotel business date', () => {
    expect(codes(price({ plan: basePlan({ minAdvanceDays: 14 }), req: { today: '2026-10-10' } }))).toEqual(['BOOK_TOO_LATE']);       // arrives in 9 days
    expect(price({ plan: basePlan({ minAdvanceDays: 9 }), req: { today: '2026-10-10' } }).sellable).toBe(true);
    expect(codes(price({ plan: basePlan({ maxAdvanceDays: 5 }), req: { today: '2026-10-10' } }))).toEqual(['BOOK_TOO_EARLY']);
    expect(codes(price({ restrictions: [restr({ minAdvanceDays: 30 })] }))).toEqual(['BOOK_TOO_LATE']);
  });
});

describe('deposit and policy snapshot', () => {
  const q = (rule: RatePlanDef['depositRule'], extra: Partial<StayRequest> = {}) => price({ plan: basePlan({ depositRule: rule }), req: { arrival: '2026-10-15', departure: '2026-10-18', ...extra } });
  it('computes the deposit from first nights, a percentage, or a fixed amount (capped at the total)', () => {
    expect(q({ type: 'NIGHTS', value: 1 }).depositDueMinor).toBe(R(12000));
    expect(q({ type: 'NIGHTS', value: 2 }).depositDueMinor).toBe(R(27000));
    expect(q({ type: 'NIGHTS', value: 10 }).depositDueMinor).toBe(R(42000));
    expect(q({ type: 'PERCENT', value: 3000 }).depositDueMinor).toBe(R(12600));
    expect(q({ type: 'FIXED', value: Number(R(5000)) }).depositDueMinor).toBe(R(5000));
    expect(q({ type: 'FIXED', value: Number(R(999999)) }).depositDueMinor).toBe(R(42000));
    expect(q(null).depositDueMinor).toBe(0n);
  });
  it('carries the cancellation / no-show / deposit rules with the quote', () => {
    const cancellationRule = { freeUntilHoursBefore: 72, feeType: 'NIGHTS' as const, feeValue: 1 };
    expect(price({ plan: basePlan({ cancellationRule }) }).policy.cancellationRule).toEqual(cancellationRule);
  });
});

describe('cancellation and no-show fees (the 72-hour rule)', () => {
  const quote = price({ plan: basePlan({ cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 } }),
    req: { arrival: '2026-10-15', departure: '2026-10-18' } });                                 // Thu 12,000 + Fri 15,000 + Sat 15,000
  it('is free at or beyond 72 hours, and one night inside it', () => {
    expect(cancellationFee(quote, 200)).toBe(0n);
    expect(cancellationFee(quote, 72)).toBe(0n);
    expect(cancellationFee(quote, 71.9)).toBe(R(12000));
    expect(cancellationFee(quote, 0)).toBe(R(12000));
    expect(cancellationFee(quote, -5)).toBe(R(12000));
  });
  it('supports percentage and fixed fees, never exceeding the booking total', () => {
    const mk = (feeType: 'PERCENT' | 'FIXED' | 'NIGHTS', feeValue: number) => ({ ...quote, policy: { ...quote.policy, cancellationRule: { freeUntilHoursBefore: 48, feeType, feeValue } } });
    expect(cancellationFee(mk('PERCENT', 5000), 10)).toBe(R(21000));
    expect(cancellationFee(mk('FIXED', Number(R(999999))), 10)).toBe(R(42000));
    expect(cancellationFee(mk('NIGHTS', 99), 10)).toBe(R(42000));
  });
  it('no rule means free cancellation; no-show fee comes from its own rule', () => {
    expect(cancellationFee(price(), 0)).toBe(0n);
    expect(noShowFee(quote)).toBe(R(12000));
    expect(noShowFee(price())).toBe(0n);
  });
  it('uses the snapshot taken at booking, so changing the plan later does not change an existing quote', () => {
    const snap = structuredClone({ nights: quote.nights, subtotalMinor: quote.subtotalMinor, policy: quote.policy }, { transfer: [] } as never);
    const later = basePlan({ cancellationRule: { freeUntilHoursBefore: 0, feeType: 'NIGHTS', feeValue: 0 } });
    expect(later.cancellationRule!.freeUntilHoursBefore).toBe(0);
    expect(cancellationFee(snap as never, 10)).toBe(R(12000));
  });
});

describe('invariants (randomised)', () => {
  it('totals always add up, are never negative, and the departure night is never priced', () => {
    let seed = 99; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 400; i++) {
      const start = 15 + rnd(20), len = 1 + rnd(7);
      const arrival = new Date(Date.UTC(2026, 9, start)).toISOString().slice(0, 10), departure = new Date(Date.UTC(2026, 9, start + len)).toISOString().slice(0, 10);
      const b = book({ overrides: { [`${STD}|${arrival}`]: R(1000 + rnd(30000)) } });
      const q = price({ book: b, plan: basePlan({ extraAdultMealMinor: R(rnd(900)), mealPlan: rnd(2) ? 'BREAKFAST' : 'ROOM_ONLY' }),
        req: { arrival, departure, adults: 1 + rnd(3), children: rnd(3), extraBeds: rnd(3) } });
      expect(q.nights).toHaveLength(len);
      expect(q.nights.every((n) => n.date >= arrival && n.date < departure)).toBe(true);
      expect(q.nights.reduce((a, n) => a + n.totalMinor, 0n)).toBe(q.subtotalMinor);
      expect(q.roomTotalMinor + q.extrasTotalMinor).toBe(q.subtotalMinor);
      expect(q.nights.every((n) => n.totalMinor >= 0n)).toBe(true);
    }
  });
});

describe('calendar helper', () => {
  it('returns a nightly price with its source, including derived plans', () => {
    expect(calendarNight(basePlan(), book(), STD, '2026-10-16', WEEKEND)).toEqual({ amount: R(15000), source: 'WEEKEND' });
    expect(calendarNight(basePlan({ kind: 'DERIVED', derive: { type: 'PERCENT', value: 1000n, roundToMinor: 100n } }), book(), STD, '2026-10-19', WEEKEND)!.amount).toBe(R(13200));
    expect(calendarNight(basePlan(), book(), 'unknown', '2026-10-19', WEEKEND)).toBeNull();
  });
});
