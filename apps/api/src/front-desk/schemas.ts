import { z } from 'zod';
import { money } from '../folio/schemas.js';
import { DOCUMENT_KEYS, GUEST_TYPES } from '../registration/rules.js';
import { CreateGuest } from '../guests/schemas.js';
import { businessDate, uuid } from '../property-setup/schemas.js';

export const Occupant = z.object({
  fullName: z.string().trim().min(2).max(160),
  isPrimary: z.boolean().default(false),
  ageGroup: z.enum(['ADULT', 'CHILD']).default('ADULT'),
  /** Children, and family members covered by one ID, may have none. The main guest's is required (checked with the booking, not here). */
  idType: z.enum(['CNIC', 'NICOP', 'PASSPORT', 'DRIVING_LICENSE', 'OTHER']).nullish(),
  idNumber: z.string().trim().max(40).nullish(),
  nationality: z.string().regex(/^[A-Za-z]{2}$/, 'two-letter country code like PK').transform((v) => v.toUpperCase()).nullish(),
  idExpiry: businessDate.nullish(),
  /** The kind of guest, which decides the documents asked for; worked out from the card if not given. */
  guestType: z.enum(GUEST_TYPES).nullish(),
  /** For each document: seen, or not available with the reason. */
  documents: z.partialRecord(z.enum(DOCUMENT_KEYS), z.object({ state: z.enum(['SEEN', 'NOT_AVAILABLE']), note: z.string().trim().max(200).nullish() })).default({}),
  /** The foreign-guest record kept under the Foreigners Act. */
  foreign: z.object({
    passportIssuePlace: z.string().trim().max(120).nullish(), visaType: z.string().trim().max(80).nullish(), stayExpiry: businessDate.nullish(), entryDate: businessDate.nullish(), entryPort: z.string().trim().max(120).nullish(),
    localAddress: z.string().trim().max(300).nullish(), nextDestination: z.string().trim().max(160).nullish(), froInstruction: z.boolean().nullish(), formCRef: z.string().trim().max(80).nullish(),
    residentialPermitRef: z.string().trim().max(80).nullish(), remarks: z.string().trim().max(500).nullish(),
  }).nullish(),
  /** Which other person on the card is this child's accompanying adult (their position in the list, from 0). */
  guardianIndex: z.number().int().min(0).max(11).nullish(),
  /** How a companion is related to the main guest (spouse, child, friend…). */
  relationship: z.string().trim().max(40).nullish(),
});
export const Occupants = z.array(Occupant.refine((o) => !!o.idNumber === !!o.idType, { message: 'Give both the type and the number of the ID, or neither', path: ['idNumber'] })).min(1).max(12);

export const CheckIn = z.object({
  roomId: uuid.optional(),
  occupants: Occupants,
  purposeOfVisit: z.string().trim().max(80).nullish(),
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
  occupants: Occupants, purposeOfVisit: z.string().trim().max(80).nullish(), allowNotReady: z.boolean().default(false), complianceApproval: z.object({ reason: z.string().trim().min(3).max(300) }).optional(),
  notesInternal: z.string().max(2000).nullish(), specialRequests: z.string().max(2000).nullish(),
}).refine((v) => (v.guestId ? 1 : 0) + (v.guest ? 1 : 0) === 1, { message: 'provide either guestId or guest' });
export const HousekeepingStatus = z.object({ status: z.enum(['CLEAN', 'DIRTY', 'INSPECTED']) });
export const RackQuery = z.object({ from: businessDate.optional(), days: z.coerce.number().int().min(1).max(62).default(14) });
export const OccupantsQuery = z.object({ reveal: z.enum(['true', 'false']).default('false') });

/** The guest's signature drawn on screen: a small PNG as a data address. */
export const SignCard = z.object({ name: z.string().trim().min(2).max(160), accepted: z.literal(true), signature: z.string().max(250_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'a PNG picture') }).strict();
