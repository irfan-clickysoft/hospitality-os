import { z } from 'zod';
import { isBusinessDate } from '@hos/domain-types';

export const uuid = z.string().uuid();
export const businessDate = z.string().refine(isBusinessDate, 'must be a valid YYYY-MM-DD date');
const tz = z.string().min(3).max(60).refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'unknown time zone');

export const CreateProperty = z.object({
  legalEntityId: uuid, brandId: uuid.nullish(), code: z.string().regex(/^[A-Za-z0-9_-]{2,20}$/), name: z.string().min(2).max(120),
  timezone: tz.default('Asia/Karachi'), currency: z.string().regex(/^[A-Z]{3}$/).default('PKR'), openingBusinessDate: businessDate.optional(),
});
export const ShortStayRule = z.object({ tiers: z.array(z.object({ upToHours: z.number().int().min(1).max(23), percent: z.number().int().min(0).max(100) })).min(1).max(6) })
  .refine((v) => v.tiers.every((t, i) => i === 0 || (t.upToHours > v.tiers[i - 1]!.upToHours && t.percent >= v.tiers[i - 1]!.percent)), { message: 'Each step must be a longer stay and a larger share than the one before', path: ['tiers'] });
export const UpdateProperty = z.object({
  shortStayRule: ShortStayRule.nullable().optional(), name: z.string().min(2).max(120).optional(), timezone: tz.optional(), brandId: uuid.nullish(), weekendDays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  registrationStrict: z.boolean().optional(), nicopAloneOk: z.boolean().optional(),
  city: z.string().trim().min(2).max(80).nullable().optional(), mapsUrl: z.string().trim().max(500).regex(/^https:\/\//, 'Use the full https:// link from Google Maps').nullable().optional(),
  terms: z.string().trim().max(8000).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(), phone: z.string().trim().max(40).nullable().optional(), receiptFooter: z.string().trim().max(300).nullable().optional(), brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour like #1d4e5f').nullable().optional(),
  checkInTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), checkOutTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), version: z.number().int() });
export const GoLive = z.object({ openingBusinessDate: businessDate.optional() });

export const CreateBuilding = z.object({ name: z.string().min(1).max(80) });
export const CreateFloor = z.object({ name: z.string().min(1).max(80), buildingId: uuid.nullish(), sortOrder: z.number().int().min(-20).max(200).default(0) });

const roomTypeBase = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/), name: z.string().min(2).max(80), description: z.string().max(2000).nullish(),
  maxAdults: z.number().int().min(1).max(20), maxChildren: z.number().int().min(0).max(20).default(0),
  maxOccupancy: z.number().int().min(1).max(30), baseOccupancy: z.number().int().min(1).max(30).default(2),
  bedConfig: z.string().max(120).nullish(), sizeSqm: z.number().positive().max(10000).nullish(), defaultOverbookLimit: z.number().int().min(0).max(50).default(0),
  sortOrder: z.number().int().default(0),
});
export const CreateRoomType = roomTypeBase.refine((v) => v.baseOccupancy <= v.maxOccupancy, { message: 'baseOccupancy cannot exceed maxOccupancy' });
export const UpdateRoomType = roomTypeBase.partial().extend({ status: z.enum(['ACTIVE', 'ARCHIVED']).optional(), version: z.number().int() });

const roomNumber = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 -]{0,11}$/, 'room number: 1–12 letters, digits, space or dash');
export const CreateRoom = z.object({
  roomTypeId: uuid, number: roomNumber, floorId: uuid.nullish(), capacityOverride: z.number().int().min(1).max(30).nullish(), bedConfig: z.string().max(120).nullish(),
  smoking: z.boolean().default(false), accessible: z.boolean().default(false), connectingRoomId: uuid.nullish(), notes: z.string().max(1000).nullish(),
});
export const BulkRooms = z.object({
  roomTypeId: uuid, floorId: uuid.nullish(), from: z.number().int().min(0).max(99999), to: z.number().int().min(0).max(99999),
  prefix: z.string().max(4).regex(/^[A-Za-z0-9-]*$/).default(''), smoking: z.boolean().default(false), accessible: z.boolean().default(false),
}).refine((v) => v.to >= v.from && v.to - v.from < 200, { message: 'range must be ascending and at most 200 rooms' });
export const UpdateRoom = z.object({
  number: roomNumber.optional(), roomTypeId: uuid.optional(), floorId: uuid.nullish(), capacityOverride: z.number().int().min(1).max(30).nullish(), bedConfig: z.string().max(120).nullish(),
  smoking: z.boolean().optional(), accessible: z.boolean().optional(), connectingRoomId: uuid.nullish(), notes: z.string().max(1000).nullish(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(), version: z.number().int(),
});

export const CreateAmenity = z.object({ code: z.string().regex(/^[a-z0-9_]{2,40}$/), nameEn: z.string().min(2).max(80), nameUr: z.string().max(80).nullish(), category: z.string().max(40).default('GENERAL') });
export const SetAmenities = z.object({ amenityIds: z.array(uuid).max(60) });

export const CreateBlock = z.object({
  roomId: uuid, type: z.enum(['OUT_OF_ORDER', 'OUT_OF_SERVICE']), startDate: businessDate, endDate: businessDate,
  reason: z.string().min(3).max(300), ticketRef: z.string().max(60).nullish(), acknowledgeOversell: z.boolean().default(false),
});
export const EndBlock = z.object({ endDate: businessDate });
export const SetOverbook = z.object({ from: businessDate, to: businessDate, limit: z.number().int().min(0).max(50) });
export const AvailabilityQuery = z.object({ from: businessDate, to: businessDate });
