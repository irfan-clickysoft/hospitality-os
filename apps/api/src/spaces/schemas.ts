import { z } from 'zod';
import { money } from '../folio/schemas.js';
import { uuid } from '../property-setup/schemas.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const rate = money.nullish();

export const CreateSpace = z.object({
  name: z.string().trim().min(2).max(120), nameUr: z.string().trim().max(120).nullish(), capacity: z.number().int().min(1).max(2000).nullish(),
  bufferMinutes: z.number().int().min(0).max(240).default(30), hourly: rate, halfDay: rate, fullDay: rate,
});
export const UpdateSpace = CreateSpace.partial().extend({ active: z.boolean().optional(), version: z.number().int() });

export const CreateBooking = z.object({
  spaceId: uuid, eventName: z.string().trim().min(2).max(160), hostName: z.string().trim().min(2).max(160), hostPhone: z.string().trim().max(30).nullish(), attendees: z.number().int().min(1).max(2000).nullish(),
  date, startTime: time, endTime: time, pricing: z.enum(['HOURLY', 'HALF_DAY', 'FULL_DAY']),
  /** STAY: a charge on a staying guest's bill (give the reservation). SEPARATE: the hire gets a bill of its own — for someone who is not staying with us. */
  billTo: z.enum(['STAY', 'SEPARATE']), reservationId: uuid.nullish(), companyId: uuid.nullish(), note: z.string().trim().max(300).nullish(),
}).superRefine((v, ctx) => {
  if (v.billTo === 'STAY' && !v.reservationId) ctx.addIssue({ code: 'custom', path: ['reservationId'], message: 'Choose the stay to charge' });
  if (v.billTo === 'SEPARATE' && v.reservationId) ctx.addIssue({ code: 'custom', path: ['reservationId'], message: 'A separate bill is not linked to a stay' });
  if (v.billTo === 'STAY' && v.companyId) ctx.addIssue({ code: 'custom', path: ['companyId'], message: 'A company can only be noted on a separate bill' });
});
export const UpdateBooking = z.object({
  eventName: z.string().trim().min(2).max(160).optional(), hostName: z.string().trim().min(2).max(160).optional(), hostPhone: z.string().trim().max(30).nullish(), attendees: z.number().int().min(1).max(2000).nullish(), note: z.string().trim().max(300).nullish(),
  date: date.optional(), startTime: time.optional(), endTime: time.optional(), pricing: z.enum(['HOURLY', 'HALF_DAY', 'FULL_DAY']).optional(), version: z.number().int(),
});
export const Cancel = z.object({ reason: z.string().trim().min(3).max(300) });
export const CalendarQuery = z.object({ from: date.optional(), to: date.optional(), spaceId: uuid.optional(), status: z.enum(['BOOKED', 'COMPLETED', 'CANCELLED', 'ALL']).default('ALL') });
export const SpacesQuery = z.object({ all: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') });
