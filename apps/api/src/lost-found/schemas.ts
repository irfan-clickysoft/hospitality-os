import { z } from 'zod';
import { businessDate, uuid } from '../property-setup/schemas.js';

export const CATEGORIES = ['DOCUMENT', 'ELECTRONICS', 'JEWELLERY', 'CLOTHING', 'BAG', 'KEYS', 'MONEY', 'MEDICINE', 'OTHER'] as const;
const note = z.string().trim().min(3).max(300);

export const Create = z.object({
  item: z.string().trim().min(2).max(200), category: z.enum(CATEGORIES).default('OTHER'), description: z.string().trim().max(500).optional(),
  roomId: uuid.optional(), location: z.string().trim().max(120).optional(), storageLocation: z.string().trim().max(120).optional(),
  /** When it was found; the time of the report if left out. */
  foundAt: z.string().datetime().optional(), highValue: z.boolean().default(false),
  guestId: uuid.optional(), reservationId: uuid.optional(),
});
export const Update = z.object({
  item: z.string().trim().min(2).max(200).optional(), category: z.enum(CATEGORIES).optional(), description: z.string().trim().max(500).nullable().optional(), location: z.string().trim().max(120).nullable().optional(),
  storageLocation: z.string().trim().max(120).nullable().optional(), highValue: z.boolean().optional(), guestId: uuid.nullable().optional(), reservationId: uuid.nullable().optional(), disposeAfter: businessDate.optional(), version: z.number().int(),
}).strict();
export const Contact = z.object({ channel: z.enum(['WHATSAPP', 'PHONE', 'EMAIL', 'OTHER']).default('WHATSAPP'), note: z.string().trim().max(300).optional() });
/** Handing it back: to whom, how, and how we were sure it is theirs. */
export const Return = z.object({
  receiverName: z.string().trim().min(2).max(120), receiverIdNote: z.string().trim().max(80).optional(), method: z.enum(['HAND_OVER', 'REPRESENTATIVE', 'COURIER']).default('HAND_OVER'),
  courierRef: z.string().trim().max(80).optional(), verified: note,
}).refine((v) => v.method !== 'COURIER' || !!v.courierRef, { message: 'Enter the courier tracking number', path: ['courierRef'] })
  .refine((v) => v.method === 'COURIER' || !!v.receiverIdNote, { message: 'Note the ID shown by the person collecting (type and last digits)', path: ['receiverIdNote'] });
export const Dispose = z.object({ reason: note, early: z.boolean().default(false) });
export const Reopen = z.object({ reason: note });
export const AddNote = z.object({ note });
export const ListQuery = z.object({ status: z.enum(['OPEN', 'FOUND', 'OWNER_CONTACTED', 'RETURNED', 'DISPOSED', 'ALL']).default('OPEN'), q: z.string().trim().max(80).optional(), roomId: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
export const SuggestQuery = z.object({ roomId: uuid, date: businessDate.optional() });
