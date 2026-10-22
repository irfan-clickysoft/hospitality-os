import { z } from 'zod';
import { money } from '../folio/schemas.js';
import { CreateGuest } from '../guests/schemas.js';
import { businessDate, uuid } from '../property-setup/schemas.js';

export const Occupant = z.object({
  fullName: z.string().trim().min(2).max(160),
  isPrimary: z.boolean().default(false),
  ageGroup: z.enum(['ADULT', 'CHILD']).default('ADULT'),
  idType: z.enum(['CNIC', 'NICOP', 'PASSPORT', 'DRIVING_LICENSE', 'OTHER']),
  idNumber: z.string().min(1).max(40),
  nationality: z.string().regex(/^[A-Za-z]{2}$/, 'two-letter country code like PK').transform((v) => v.toUpperCase()).nullish(),
  idExpiry: businessDate.nullish(),
});
export const Occupants = z.array(Occupant).min(1).max(12);

export const CheckIn = z.object({
  roomId: uuid.optional(),
  occupants: Occupants,
  /** Put the guest in a room that is not marked clean. Needs the override permission and a fresh second factor. */
  allowNotReady: z.boolean().default(false),
  complianceApproval: z.object({ reason: z.string().trim().min(3).max(300) }).optional(),
});
/** How a same-day early departure is charged: by the property's short-stay rule, a whole night, or an amount the desk chooses (zero waives it; needs the override-rate permission and a reason). */
export const ShortStay = z.object({ mode: z.enum(['RULE', 'FULL_NIGHT', 'CUSTOM']), amount: money.optional(), reason: z.string().trim().min(3).max(300).optional() })
  .refine((v) => v.mode !== 'CUSTOM' || (v.amount !== undefined && !!v.reason), { message: 'Give the amount and the reason', path: ['amount'] });
export const CheckOut = z.object({
  shortStay: ShortStay.optional(),
  reason: z.string().min(3).max(300).optional(),
  /** Let the guest leave with an unpaid or overpaid folio. Needs the checkout-with-balance permission and a fresh second factor. */
  balanceReason: z.string().min(3).max(300).optional(),
});
export const UndoCheckIn = z.object({ reason: z.string().min(3).max(300) });
export const MoveRoom = z.object({ roomId: uuid, reason: z.string().min(3).max(300), allowNotReady: z.boolean().default(false) });
export const WalkIn = z.object({
  guestId: uuid.optional(), guest: CreateGuest.optional(),
  roomTypeId: uuid, nights: z.number().int().min(1).max(60).default(1),
  adults: z.number().int().min(1).max(20).default(2), children: z.number().int().min(0).max(20).default(0), extraBeds: z.number().int().min(0).max(5).default(0),
  ratePlanId: uuid.optional(), companyId: uuid.nullish(), roomId: uuid.optional(),
  occupants: Occupants, allowNotReady: z.boolean().default(false), complianceApproval: z.object({ reason: z.string().trim().min(3).max(300) }).optional(),
  notesInternal: z.string().max(2000).nullish(), specialRequests: z.string().max(2000).nullish(),
}).refine((v) => (v.guestId ? 1 : 0) + (v.guest ? 1 : 0) === 1, { message: 'provide either guestId or guest' });
export const HousekeepingStatus = z.object({ status: z.enum(['CLEAN', 'DIRTY', 'INSPECTED']) });
export const RackQuery = z.object({ from: businessDate.optional(), days: z.coerce.number().int().min(1).max(62).default(14) });
export const OccupantsQuery = z.object({ reveal: z.enum(['true', 'false']).default('false') });
