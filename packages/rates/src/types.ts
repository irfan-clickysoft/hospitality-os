/** Plain data the engine needs. The API layer loads these from the database; the engine never touches I/O. All money is bigint minor units. */
export type Residency = 'ANY' | 'RESIDENT' | 'NON_RESIDENT';
export type Channel = 'DIRECT' | 'PHONE' | 'WALKIN' | 'OTA' | 'CORPORATE' | 'AGENT';
export type MealPlan = 'ROOM_ONLY' | 'BREAKFAST' | 'HALF_BOARD' | 'FULL_BOARD';

export interface CancellationRule { freeUntilHoursBefore: number; feeType: 'NIGHTS' | 'PERCENT' | 'FIXED'; feeValue: number }
export interface NoShowRule { feeType: 'NIGHTS' | 'PERCENT' | 'FIXED'; feeValue: number }
export interface DepositRule { type: 'NIGHTS' | 'PERCENT' | 'FIXED'; value: number; dueWithinHours?: number }

export interface RatePlanDef {
  id: string; code: string; name: string; kind: 'BASE' | 'DERIVED';
  derive?: { type: 'PERCENT' | 'FIXED'; value: bigint; roundToMinor: bigint };   // PERCENT: basis points; FIXED: minor units
  mealPlan: MealPlan; audience: 'PUBLIC' | 'CORPORATE' | 'AGENT'; residency: Residency; channels: Channel[]; companyIds: string[];
  minLos: number; maxLos: number | null; minAdvanceDays: number; maxAdvanceDays: number | null;
  extraBedMinor: bigint; extraAdultMealMinor: bigint; extraChildMealMinor: bigint;
  cancellationRule: CancellationRule | null; noShowRule: NoShowRule | null; depositRule: DepositRule | null;
  validFrom: string | null; validTo: string | null; status: 'ACTIVE' | 'INACTIVE'; currency: string;
}

export interface BaseRate { amount: bigint; weekendAmount: bigint | null; extraAdult: bigint; extraChild: bigint }
export interface Season { id: string; name: string; start: string; end: string /* exclusive */; priority: number; values: Record<string, { amount: bigint; weekendAmount: bigint | null }> }
/** The price book of a BASE plan (a DERIVED plan is priced from its parent's book). */
export interface PriceBook { base: Record<string, BaseRate>; seasons: Season[]; overrides: Record<string, bigint> /* `${roomTypeId}|${date}` */ }

export interface Restriction {
  roomTypeId: string | null; start: string; end: string /* exclusive */;
  minLos?: number | null; maxLos?: number | null; closedToArrival: boolean; closedToDeparture: boolean; stopSell: boolean;
  minAdvanceDays?: number | null; maxAdvanceDays?: number | null;
}
export interface RoomTypeLimits { maxAdults: number; maxChildren: number; maxOccupancy: number; baseOccupancy: number }

export interface StayRequest {
  roomTypeId: string; arrival: string; departure: string; adults: number; children: number; extraBeds: number;
  channel: Channel; residency: 'RESIDENT' | 'NON_RESIDENT'; companyId?: string | null;
  /** Hotel business date "today" (property time zone) — used for advance-purchase windows. */
  today: string; weekendDays: number[];
}

export type ReasonCode =
  | 'PLAN_INACTIVE' | 'OUTSIDE_VALIDITY' | 'CHANNEL_NOT_ALLOWED' | 'RESIDENCY_MISMATCH' | 'COMPANY_REQUIRED' | 'OCCUPANCY_EXCEEDED'
  | 'NO_PRICE' | 'MIN_LOS' | 'MAX_LOS' | 'CLOSED_TO_ARRIVAL' | 'CLOSED_TO_DEPARTURE' | 'STOP_SELL' | 'BOOK_TOO_LATE' | 'BOOK_TOO_EARLY';
export interface Reason { code: ReasonCode; message: string }

export interface NightPrice {
  date: string; source: string; roomMinor: bigint; extraAdultMinor: bigint; extraChildMinor: bigint; extraBedMinor: bigint; mealMinor: bigint; totalMinor: bigint;
}
export interface Quote {
  sellable: boolean; reasons: Reason[];
  planId: string; planCode: string; planName: string; mealPlan: MealPlan; currency: string; roomTypeId: string;
  nights: NightPrice[]; roomTotalMinor: bigint; extrasTotalMinor: bigint;
  /** Excludes tax: taxes are computed by the tax engine at quote/invoice time (quotes show amounts without tax, as per house convention). */
  subtotalMinor: bigint; depositDueMinor: bigint;
  policy: { cancellationRule: CancellationRule | null; noShowRule: NoShowRule | null; depositRule: DepositRule | null };
}
