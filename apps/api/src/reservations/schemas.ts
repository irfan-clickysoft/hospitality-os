import { z } from 'zod';
import { businessDate, uuid } from '../property-setup/schemas.js';
import { CreateGuest } from '../guests/schemas.js';

export const SOURCES = ['WALK_IN', 'PHONE', 'WHATSAPP', 'WEBSITE', 'OTA_BOOKING_COM', 'OTA_OTHER', 'CORPORATE', 'TRAVEL_AGENT', 'CRS', 'OTHER'] as const;
const text = (n: number) => z.string().max(n).nullish();

export const MAX_HOLD_DAYS = 30;
export const CreateReservation = z.object({
  guestId: uuid.optional(),
  guest: CreateGuest.optional(),
  lines: z.array(z.object({ quoteToken: z.string().min(40).max(4000) })).min(1).max(10),
  source: z.enum(SOURCES),
  marketSegment: z.string().max(40).nullish(), externalRef: z.string().max(80).nullish(), companyId: uuid.nullish(),
  /** Hold the rooms as an OPTION (no payment yet) for half-hour steps, whole days, or until the end of a date — never past the arrival day. Omit to confirm now. */
  hold: z.object({
    minutes: z.number().int().min(30).max(4320).refine((m) => m % 30 === 0, 'Holds run in half-hour steps').optional(),
    days: z.number().int().min(1).max(MAX_HOLD_DAYS).optional(),
    untilDate: businessDate.optional(),
  }).strict().refine((h) => [h.minutes, h.days, h.untilDate].filter((x) => x !== undefined).length === 1, 'Give the hold as half-hours, days, or a date — one of them').optional(),
  /** A manager's approval (with a reason) for a booking that a compliance rule holds for approval. */
  complianceApproval: z.object({ reason: z.string().trim().min(3).max(300) }).optional(),
  notesInternal: text(2000), notesGuest: text(2000), specialRequests: text(2000),
}).refine((v) => (v.guestId ? 1 : 0) + (v.guest ? 1 : 0) === 1, { message: 'provide either guestId or guest' });

export const UpdateReservation = z.object({ notesInternal: text(2000), notesGuest: text(2000), specialRequests: text(2000), externalRef: text(80), marketSegment: text(40), version: z.number().int() });
export const ModifyLine = z.object({
  arrival: businessDate.optional(), departure: businessDate.optional(), roomTypeId: uuid.optional(),
  adults: z.number().int().min(1).max(20).optional(), children: z.number().int().min(0).max(20).optional(), extraBeds: z.number().int().min(0).max(5).optional(),
  /** Keep the originally quoted nightly prices (e.g. a complimentary upgrade). Needs the rate-override permission. */
  keepRate: z.boolean().default(false), reason: z.string().min(3).max(300), version: z.number().int(),
});
export const CancelReservation = z.object({ reason: z.string().min(3).max(300), waiveFee: z.boolean().default(false), lineIds: z.array(uuid).max(10).optional() });
export const NoShow = z.object({ reason: z.string().min(3).max(300).default('Guest did not arrive'), waiveFee: z.boolean().default(false) });
export const Reinstate = z.object({ reason: z.string().min(3).max(300) });
export const Confirm = z.object({ reason: z.string().max(300).nullish() });
export const AssignRoom = z.object({ roomId: uuid });
export const AvailableRoomsQuery = z.object({ roomTypeId: uuid, arrival: businessDate, departure: businessDate });
export const ListQuery = z.object({
  status: z.enum(['OPTION', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW']).optional(), view: z.enum(['arrivals', 'departures', 'in-house']).optional(), date: businessDate.optional(),
  arrivalFrom: businessDate.optional(), arrivalTo: businessDate.optional(), q: z.string().max(80).optional(), source: z.enum(SOURCES).optional(), atRisk: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(200).optional(),
});
