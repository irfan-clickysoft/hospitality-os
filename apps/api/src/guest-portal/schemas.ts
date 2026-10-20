import { z } from 'zod';
import { businessDate, uuid } from '../property-setup/schemas.js';

export const KINDS = ['AIRPORT_PICKUP', 'AIRPORT_DROP', 'GROUND_FLOOR', 'WHEELCHAIR', 'EARLY_CHECKIN', 'LATE_CHECKOUT', 'EXTRA_BED', 'OTHER'] as const;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** What a guest may send from their booking page. Nothing here is a price or a promise: the hotel answers each request. */
export const GuestRequest = z.object({
  kind: z.enum(KINDS),
  neededOn: businessDate.optional(), neededTime: time.optional(),
  flightNo: z.string().trim().min(2).max(20).optional(), passengers: z.number().int().min(1).max(20).optional(),
  note: z.string().trim().max(500).optional(),
}).strict().refine((r) => r.kind !== 'OTHER' || (r.note?.length ?? 0) >= 3, { message: 'Tell us what you need', path: ['note'] })
  .refine((r) => !['AIRPORT_PICKUP', 'AIRPORT_DROP'].includes(r.kind) || (r.neededOn && r.neededTime), { message: 'Give the date and time', path: ['neededOn'] });

export const HandleRequest = z.object({ status: z.enum(['ACKNOWLEDGED', 'DONE', 'DECLINED']), staffNote: z.string().trim().max(300).optional() }).strict();
export const ListRequests = z.object({ status: z.enum(['OPEN', 'ALL']).default('OPEN'), reservationId: uuid.optional() });
