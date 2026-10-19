import { z } from 'zod';
import { businessDate, uuid } from '../property-setup/schemas.js';

/** Money on the wire is a decimal string ("12500.00"), never a float. */
export const money = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'amount like 12500 or 12500.00');
const channel = z.enum(['DIRECT', 'PHONE', 'WALKIN', 'OTA', 'CORPORATE', 'AGENT']);
const hoursRule = z.object({ freeUntilHoursBefore: z.number().int().min(0).max(24 * 60), feeType: z.enum(['NIGHTS', 'PERCENT', 'FIXED']), feeValue: z.number().int().min(0).max(10_000_000) });
const noShow = z.object({ feeType: z.enum(['NIGHTS', 'PERCENT', 'FIXED']), feeValue: z.number().int().min(0).max(10_000_000) });
const deposit = z.object({ type: z.enum(['NIGHTS', 'PERCENT', 'FIXED']), value: z.number().int().min(0).max(10_000_000), dueWithinHours: z.number().int().min(1).max(24 * 30).optional() });

const planBase = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{2,24}$/), name: z.string().min(2).max(80), description: z.string().max(1000).nullish(),
  mealPlan: z.enum(['ROOM_ONLY', 'BREAKFAST', 'HALF_BOARD', 'FULL_BOARD']).default('ROOM_ONLY'),
  audience: z.enum(['PUBLIC', 'CORPORATE', 'AGENT']).default('PUBLIC'), residency: z.enum(['ANY', 'RESIDENT', 'NON_RESIDENT']).default('ANY'),
  channels: z.array(channel).min(1).default(['DIRECT', 'PHONE', 'WALKIN', 'OTA', 'CORPORATE', 'AGENT']), companyIds: z.array(uuid).max(500).default([]),
  minLos: z.number().int().min(1).max(365).default(1), maxLos: z.number().int().min(1).max(365).nullish(),
  minAdvanceDays: z.number().int().min(0).max(730).default(0), maxAdvanceDays: z.number().int().min(0).max(730).nullish(),
  extraBed: money.default('0'), extraAdultMeal: money.default('0'), extraChildMeal: money.default('0'),
  cancellationRule: hoursRule.nullish(), noShowRule: noShow.nullish(), depositRule: deposit.nullish(),
  validFrom: businessDate.nullish(), validTo: businessDate.nullish(), sortOrder: z.number().int().default(0),
  derive: z.discriminatedUnion('type', [
    z.object({ parentPlanId: uuid, type: z.literal('PERCENT'), value: z.number().int().min(-9000).max(100000), roundTo: money.default('1') }),   // basis points: 2500 = +25%
    z.object({ parentPlanId: uuid, type: z.literal('FIXED'), value: z.string().regex(/^-?\d{1,9}(\.\d{1,2})?$/), roundTo: money.default('1') }),
  ]).nullish(),
});
export const CreatePlan = planBase.refine((v) => !v.maxLos || v.maxLos >= v.minLos, 'maxLos must be ≥ minLos')
  .refine((v) => !v.validFrom || !v.validTo || v.validTo >= v.validFrom, 'validTo must be on/after validFrom')
  ;
export const UpdatePlan = planBase.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional(), version: z.number().int() });

export const SetBaseRates = z.object({ items: z.array(z.object({
  roomTypeId: uuid, amount: money, weekendAmount: money.nullish(), extraAdult: money.default('0'), extraChild: money.default('0'),
})).min(1).max(100) });
export const CreateSeason = z.object({
  name: z.string().min(2).max(60), startDate: businessDate, endDate: businessDate, priority: z.number().int().min(0).max(100).default(0),
  values: z.array(z.object({ roomTypeId: uuid, amount: money, weekendAmount: money.nullish() })).min(1).max(100),
}).refine((v) => v.endDate > v.startDate, 'endDate must be after startDate');
export const SetOverrides = z.object({
  roomTypeId: uuid, from: businessDate, to: businessDate /* exclusive */, amount: money, dryRun: z.boolean().default(false), confirmWarnings: z.boolean().default(false),
}).refine((v) => v.to > v.from, 'to must be after from');
export const CreateRestriction = z.object({
  roomTypeId: uuid.nullish(), startDate: businessDate, endDate: businessDate, minLos: z.number().int().min(1).max(365).nullish(), maxLos: z.number().int().min(1).max(365).nullish(),
  closedToArrival: z.boolean().default(false), closedToDeparture: z.boolean().default(false), stopSell: z.boolean().default(false),
  minAdvanceDays: z.number().int().min(0).max(730).nullish(), maxAdvanceDays: z.number().int().min(0).max(730).nullish(), note: z.string().max(200).nullish(),
}).refine((v) => v.endDate > v.startDate, 'endDate must be after startDate')
  .refine((v) => v.minLos || v.maxLos || v.closedToArrival || v.closedToDeparture || v.stopSell || v.minAdvanceDays || v.maxAdvanceDays, 'a restriction must restrict something');
export const CalendarQuery = z.object({ planId: uuid, from: businessDate, to: businessDate });
export const QuoteRequest = z.object({
  arrival: businessDate, departure: businessDate, adults: z.number().int().min(1).max(20), children: z.number().int().min(0).max(20).default(0), extraBeds: z.number().int().min(0).max(5).default(0),
  channel: channel.default('DIRECT'), residency: z.enum(['RESIDENT', 'NON_RESIDENT']).default('RESIDENT'), companyId: uuid.nullish(),
  roomTypeId: uuid.nullish(), discountPct: z.number().min(0).max(100).default(0), includeUnavailable: z.boolean().default(false),
}).refine((v) => v.departure > v.arrival, 'departure must be after arrival');
