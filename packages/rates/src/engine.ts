import { addDays, diffDays, isoWeekday, nightsOf } from '@hos/domain-types';
import type { BaseRate, DepositRule, NightPrice, PriceBook, Quote, RatePlanDef, Reason, Restriction, RoomTypeLimits, StayRequest } from './types.js';

const ZERO = 0n;
const key = (rt: string, d: string) => `${rt}|${d}`;
const covers = (r: { start: string; end: string }, d: string) => r.start <= d && d < r.end;

export function isWeekendNight(date: string, weekendDays: readonly number[]): boolean { return weekendDays.includes(isoWeekday(date)); }

/** Rounds to the nearest multiple of `step` (half up). Prices never go negative. */
function roundTo(v: bigint, step: bigint): bigint {
  if (v <= ZERO) return ZERO;
  if (step <= 1n) return v;
  return ((v + step / 2n) / step) * step;
}

/**
 * Precedence for one night of a BASE price book (highest first):
 *   explicit date override  >  seasonal price (highest priority season)  >  weekend/weekday price from the base rate.
 * Returns null when no price exists for the room type (the plan is then not sellable for that night).
 */
export function resolveBaseNight(book: PriceBook, roomTypeId: string, date: string, weekendDays: readonly number[]): { amount: bigint; source: string; rate: BaseRate } | null {
  const rate = book.base[roomTypeId];
  const weekend = isWeekendNight(date, weekendDays);
  const ov = book.overrides[key(roomTypeId, date)];
  if (ov !== undefined) return { amount: ov, source: 'OVERRIDE', rate: rate ?? { amount: ov, weekendAmount: null, extraAdult: ZERO, extraChild: ZERO } };
  const season = book.seasons.filter((s) => covers(s, date) && s.values[roomTypeId]).sort((a, b) => b.priority - a.priority || (a.start < b.start ? 1 : -1))[0];
  if (season) {
    const v = season.values[roomTypeId]!;
    const amt = weekend && v.weekendAmount !== null ? v.weekendAmount : v.amount;
    return { amount: amt, source: `SEASON:${season.name}`, rate: rate ?? { amount: amt, weekendAmount: null, extraAdult: ZERO, extraChild: ZERO } };
  }
  if (!rate) return null;
  return weekend && rate.weekendAmount !== null ? { amount: rate.weekendAmount, source: 'WEEKEND', rate } : { amount: rate.amount, source: 'BASE', rate };
}

function applyDerive(plan: RatePlanDef, v: bigint): bigint {
  const d = plan.derive;
  if (!d) return v;
  const out = d.type === 'PERCENT' ? (v * (10000n + d.value)) / 10000n : v + d.value;
  return roundTo(out, d.roundToMinor);
}

function combineRestrictions(rows: Restriction[], plan: RatePlanDef, roomTypeId: string, nights: string[], arrival: string, departure: string) {
  const forType = rows.filter((r) => r.roomTypeId === null || r.roomTypeId === roomTypeId);
  const atArrival = forType.filter((r) => covers(r, arrival));
  const minLos = Math.max(plan.minLos, ...atArrival.map((r) => r.minLos ?? 1));
  const maxLosCandidates = [plan.maxLos, ...atArrival.map((r) => r.maxLos ?? null)].filter((x): x is number => x !== null);
  const minAdv = Math.max(plan.minAdvanceDays, ...atArrival.map((r) => r.minAdvanceDays ?? 0));
  const maxAdvCandidates = [plan.maxAdvanceDays, ...atArrival.map((r) => r.maxAdvanceDays ?? null)].filter((x): x is number => x !== null);
  return {
    minLos, maxLos: maxLosCandidates.length ? Math.min(...maxLosCandidates) : null,
    minAdvance: minAdv, maxAdvance: maxAdvCandidates.length ? Math.min(...maxAdvCandidates) : null,
    cta: atArrival.some((r) => r.closedToArrival),
    ctd: forType.some((r) => covers(r, departure) && r.closedToDeparture),
    stopSellNights: nights.filter((n) => forType.some((r) => covers(r, n) && r.stopSell)),
  };
}

export function depositFor(rule: DepositRule | null, nights: NightPrice[], total: bigint): bigint {
  if (!rule || total <= ZERO) return ZERO;
  let v: bigint;
  if (rule.type === 'NIGHTS') v = nights.slice(0, Math.max(0, rule.value)).reduce((a, n) => a + n.totalMinor, ZERO);
  else if (rule.type === 'PERCENT') v = (total * BigInt(rule.value) + 5000n) / 10000n;
  else v = BigInt(rule.value);
  return v > total ? total : v < ZERO ? ZERO : v;
}

/** Prices one stay on one plan for one room type and evaluates every eligibility rule, returning reasons instead of throwing. */
export function priceStay(args: {
  plan: RatePlanDef; book: PriceBook; restrictions: Restriction[]; limits: RoomTypeLimits; req: StayRequest;
}): Quote {
  const { plan, book, restrictions, limits, req } = args;
  const reasons: Reason[] = [];
  const bad = (code: Reason['code'], message: string) => reasons.push({ code, message });
  const nightDates = nightsOf(req.arrival, req.departure);

  if (plan.status !== 'ACTIVE') bad('PLAN_INACTIVE', 'This rate plan is not active');
  if (nightDates.some((d) => (plan.validFrom && d < plan.validFrom) || (plan.validTo && d > plan.validTo))) bad('OUTSIDE_VALIDITY', 'The stay falls outside this rate plan\'s validity dates');
  if (!plan.channels.includes(req.channel)) bad('CHANNEL_NOT_ALLOWED', `Not sold through ${req.channel}`);
  if (plan.residency !== 'ANY' && plan.residency !== req.residency) bad('RESIDENCY_MISMATCH', plan.residency === 'RESIDENT' ? 'Rate is for resident (local) guests' : 'Rate is for non-resident (foreign) guests');
  if (plan.audience !== 'PUBLIC' && !(req.companyId && plan.companyIds.includes(req.companyId))) bad('COMPANY_REQUIRED', 'This rate is available only to the contracted company or agent');
  // An extra bed is how a room takes one more person than its usual limit, so each one raises the room's capacity (for children as well as the total) by one.
  if (req.adults < 1 || req.adults > limits.maxAdults || req.children > limits.maxChildren + req.extraBeds || req.adults + req.children > limits.maxOccupancy + req.extraBeds) {
    bad('OCCUPANCY_EXCEEDED', `Room type allows up to ${limits.maxAdults} adults, ${limits.maxChildren} children and ${limits.maxOccupancy} guests in total, and one more person for each extra bed`);
  }

  const rc = combineRestrictions(restrictions, plan, req.roomTypeId, nightDates, req.arrival, req.departure);
  const los = nightDates.length;
  if (los < rc.minLos) bad('MIN_LOS', `Minimum stay is ${rc.minLos} night(s)`);
  if (rc.maxLos !== null && los > rc.maxLos) bad('MAX_LOS', `Maximum stay is ${rc.maxLos} night(s)`);
  if (rc.cta) bad('CLOSED_TO_ARRIVAL', 'Arrivals are closed on this date');
  if (rc.ctd) bad('CLOSED_TO_DEPARTURE', 'Departures are closed on this date');
  if (rc.stopSellNights.length) bad('STOP_SELL', `Sales are stopped for: ${rc.stopSellNights.join(', ')}`);
  const lead = diffDays(req.arrival, req.today);
  if (lead < rc.minAdvance) bad('BOOK_TOO_LATE', `Must be booked at least ${rc.minAdvance} day(s) before arrival`);
  if (rc.maxAdvance !== null && lead > rc.maxAdvance) bad('BOOK_TOO_EARLY', `Cannot be booked more than ${rc.maxAdvance} day(s) ahead`);

  // occupancy: base-occupancy slots fill with adults first, then children
  const extraAdults = Math.max(0, req.adults - limits.baseOccupancy);
  const freeSlots = Math.max(0, limits.baseOccupancy - req.adults);
  const chargeableChildren = Math.max(0, req.children - freeSlots);
  const mealed = plan.mealPlan !== 'ROOM_ONLY';

  const nights: NightPrice[] = [];
  let missing = false;
  for (const date of nightDates) {
    const r = resolveBaseNight(book, req.roomTypeId, date, req.weekendDays);
    if (!r) { missing = true; continue; }
    const derived = plan.kind === 'DERIVED';
    const room = derived ? applyDerive(plan, r.amount) : r.amount;
    const exA = derived && plan.derive!.type === 'PERCENT' ? applyDerive(plan, r.rate.extraAdult) : r.rate.extraAdult;
    const exC = derived && plan.derive!.type === 'PERCENT' ? applyDerive(plan, r.rate.extraChild) : r.rate.extraChild;
    const extraAdultMinor = BigInt(extraAdults) * exA;
    const extraChildMinor = BigInt(chargeableChildren) * exC;
    const extraBedMinor = BigInt(req.extraBeds) * plan.extraBedMinor;
    const mealMinor = mealed ? BigInt(extraAdults) * plan.extraAdultMealMinor + BigInt(chargeableChildren) * plan.extraChildMealMinor : ZERO;
    nights.push({ date, source: derived ? `DERIVED(${plan.derive!.type === 'PERCENT' ? `${Number(plan.derive!.value) / 100}%` : 'FIXED'}) ← ${r.source}` : r.source,
      roomMinor: room, extraAdultMinor, extraChildMinor, extraBedMinor, mealMinor, totalMinor: room + extraAdultMinor + extraChildMinor + extraBedMinor + mealMinor });
  }
  if (missing) bad('NO_PRICE', 'No price is set for one or more nights');

  const roomTotal = nights.reduce((a, n) => a + n.roomMinor, ZERO);
  const subtotal = nights.reduce((a, n) => a + n.totalMinor, ZERO);
  return {
    sellable: reasons.length === 0, reasons, planId: plan.id, planCode: plan.code, planName: plan.name, mealPlan: plan.mealPlan, currency: plan.currency, roomTypeId: req.roomTypeId,
    nights, roomTotalMinor: roomTotal, extrasTotalMinor: subtotal - roomTotal, subtotalMinor: subtotal,
    depositDueMinor: depositFor(plan.depositRule, nights, subtotal),
    policy: { cancellationRule: plan.cancellationRule, noShowRule: plan.noShowRule, depositRule: plan.depositRule },
  };
}

type FeeRule = { feeType: 'NIGHTS' | 'PERCENT' | 'FIXED'; feeValue: number };
function feeFrom(rule: FeeRule, nights: NightPrice[], subtotal: bigint): bigint {
  let v: bigint;
  if (rule.feeType === 'NIGHTS') v = nights.slice(0, Math.max(0, rule.feeValue)).reduce((a, n) => a + n.totalMinor, ZERO);
  else if (rule.feeType === 'PERCENT') v = (subtotal * BigInt(rule.feeValue) + 5000n) / 10000n;
  else v = BigInt(rule.feeValue);
  return v > subtotal ? subtotal : v < ZERO ? ZERO : v;
}

/**
 * Cancellation fee from the policy snapshot taken at booking time (NOT today's policy).
 * `hoursBeforeArrival` is measured to the property's check-in time on the arrival date.
 * Example house rule: free until 72 h before arrival, then one night.
 */
export function cancellationFee(snapshot: Pick<Quote, 'nights' | 'subtotalMinor' | 'policy'>, hoursBeforeArrival: number): bigint {
  const rule = snapshot.policy.cancellationRule;
  if (!rule || hoursBeforeArrival >= rule.freeUntilHoursBefore) return ZERO;
  return feeFrom(rule, snapshot.nights, snapshot.subtotalMinor);
}

export function noShowFee(snapshot: Pick<Quote, 'nights' | 'subtotalMinor' | 'policy'>): bigint {
  const rule = snapshot.policy.noShowRule;
  return rule ? feeFrom(rule, snapshot.nights, snapshot.subtotalMinor) : ZERO;
}

/** Per-night price on a plan for the rate calendar (no stay context, base occupancy). Null = no price. */
export function calendarNight(plan: RatePlanDef, book: PriceBook, roomTypeId: string, date: string, weekendDays: readonly number[]): { amount: bigint; source: string } | null {
  const r = resolveBaseNight(book, roomTypeId, date, weekendDays);
  if (!r) return null;
  return plan.kind === 'DERIVED' ? { amount: applyDerive(plan, r.amount), source: `DERIVED ← ${r.source}` } : { amount: r.amount, source: r.source };
}

export { addDays };
