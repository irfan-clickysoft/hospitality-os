import { z } from 'zod';
import { money } from '../folio/schemas.js';
import { businessDate, uuid } from '../property-setup/schemas.js';

const note = z.string().trim().min(3).max(300);
export const CATEGORIES = ['PLUMBING', 'ELECTRICAL', 'AC', 'FURNITURE', 'APPLIANCE', 'CLEANLINESS', 'SAFETY', 'OTHER'] as const;
export const CreateOrder = z.object({
  title: z.string().trim().min(3).max(160), description: z.string().trim().max(2000).nullish(), category: z.enum(CATEGORIES), priority: z.number().int().min(1).max(4).default(3),
  roomId: uuid.nullish(), area: z.string().trim().max(80).nullish(), issueId: uuid.nullish(), dueDate: businessDate.nullish(), assignedTo: uuid.nullish(),
  /** The room cannot be sold while this is open: takes it out of order for these dates (the end date is the day it is expected back). */
  outOfOrder: z.object({ startDate: businessDate, endDate: businessDate, type: z.enum(['OUT_OF_ORDER', 'OUT_OF_SERVICE']).default('OUT_OF_ORDER'), acknowledgeOversell: z.boolean().default(false) }).optional(),
}).refine((v) => !v.outOfOrder || !!v.roomId, { message: 'Choose the room to take out of order', path: ['roomId'] });
export const Assign = z.object({ assignedTo: uuid, dueDate: businessDate.nullish() });
export const Wait = z.object({ reason: note });
export const Done = z.object({ note, cost: money.optional(), vendor: z.string().trim().max(120).nullish() });
export const Verify = z.object({ note: z.string().trim().max(300).nullish() });
export const Reopen = z.object({ reason: note });
export const Cancel = z.object({ reason: note });
export const AddNote = z.object({ note });
export const ListQuery = z.object({ status: z.enum(['OPEN', 'ACTIVE', 'DONE', 'ALL']).default('ACTIVE'), mine: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'), roomId: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
