import { z } from 'zod';
import { money } from '../folio/schemas.js';
import { uuid } from '../property-setup/schemas.js';

const text = (max: number, min = 0) => z.string().trim().min(min).max(max);
const when = z.string().datetime({ offset: true }).optional();

export const DAMAGE_CATEGORIES = ['FURNITURE', 'FIXTURE', 'ELECTRONICS', 'LINEN', 'WALLS_FLOORS', 'APPLIANCE', 'KEYS', 'OTHER'] as const;
export const DamageCreate = z.object({
  reservationId: uuid.optional(), lineId: uuid.optional(), roomId: uuid.optional(),
  area: text(120, 2), category: z.enum(DAMAGE_CATEGORIES), severity: z.enum(['MINOR', 'MODERATE', 'MAJOR']), description: text(2000, 3),
  discoveredAt: when, estimatedCost: money.optional(),
}).strict();
export const DamageUpdate = z.object({
  area: text(120, 2).optional(), category: z.enum(DAMAGE_CATEGORIES).optional(), severity: z.enum(['MINOR', 'MODERATE', 'MAJOR']).optional(), description: text(2000, 3).optional(),
  estimatedCost: money.nullish(), actualCost: money.nullish(), internalNote: text(2000).nullish(),
}).strict();
export const DamageList = z.object({ status: z.string().max(200).optional(), q: z.string().max(80).optional(), from: z.string().optional(), to: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) });
export const Note = z.object({ note: text(1000, 2) }).strict();
export const Reason = z.object({ reason: text(500, 3) }).strict();
export const Verify = z.object({ note: text(500).optional(), actualCost: money.optional() }).strict();
export const GuestResponse = z.object({ response: z.enum(['ACKNOWLEDGED', 'DISPUTED']), note: text(500).optional() }).strict();
export const ApproveCharge = z.object({ amount: money, reason: text(300).optional() }).strict();
export const Waive = z.object({ amount: money.optional(), reason: text(300, 3) }).strict();
export const Resolve = z.object({ note: text(500, 3) }).strict();

export const CASE_TYPES = ['GUEST_COMPLAINT', 'SERVICE_FAILURE', 'SAFETY', 'SECURITY', 'MEDICAL', 'INTERNAL'] as const;
export const CaseCreate = z.object({
  type: z.enum(CASE_TYPES), category: text(60).optional(), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  confidential: z.boolean().default(false), reservationId: uuid.optional(), roomId: uuid.optional(), occurredAt: when,
  channel: z.enum(['IN_PERSON', 'PHONE', 'WHATSAPP', 'EMAIL', 'ONLINE_REVIEW', 'STAFF']).default('IN_PERSON'), reporterName: text(160).optional(),
  ownerId: uuid.optional(), description: text(3000, 3), immediateAction: text(1000).optional(),
}).strict();
export const CaseUpdate = z.object({
  category: text(60).nullish(), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(), ownerId: uuid.nullish(), description: text(3000, 3).optional(), immediateAction: text(1000).nullish(),
  rootCause: text(1000).nullish(), correctiveAction: text(1000).nullish(), preventiveAction: text(1000).nullish(), compensationNote: text(300).nullish(), compensation: money.nullish(),
  followupAt: when.nullable(), followupNote: text(500).nullish(), status: z.enum(['OPEN', 'IN_PROGRESS']).optional(),
}).strict();
export const CaseList = z.object({ status: z.string().max(200).optional(), type: z.string().max(200).optional(), q: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) });
