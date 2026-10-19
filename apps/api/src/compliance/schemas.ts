import { z } from 'zod';
import { businessDate, uuid } from '../property-setup/schemas.js';

const iso2 = z.string().regex(/^[A-Za-z]{2}$/, 'two-letter country code like PK').transform((v) => v.toUpperCase());
export const ACTIONS = ['INFO', 'WARN', 'REQUIRE_APPROVAL', 'REQUIRE_TASK', 'REQUIRE_DOCUMENT', 'BLOCK_BOOKING'] as const;
export const ID_TYPES = ['CNIC', 'NICOP', 'PASSPORT', 'DRIVING_LICENSE', 'OTHER'] as const;
export const Conditions = z.object({
  nationalities: z.array(iso2).max(60).optional(), excludeNationalities: z.array(iso2).max(60).optional(), residency: z.enum(['RESIDENT', 'NON_RESIDENT']).optional(),
  propertyIds: z.array(uuid).max(50).optional(), minGuests: z.number().int().min(1).max(50).optional(), minNights: z.number().int().min(1).max(365).optional(),
}).strict();
const Base = z.object({
  name: z.string().trim().min(3).max(120), description: z.string().trim().max(500).nullish(), stages: z.array(z.enum(['BOOKING', 'CHECK_IN'])).min(1), conditions: Conditions.default({}),
  action: z.enum(ACTIONS), message: z.string().trim().min(3).max(500), messageUr: z.string().trim().max(500).nullish(), documentTypes: z.array(z.enum(ID_TYPES)).default([]),
  taskTitle: z.string().trim().max(160).nullish(), reasonCode: z.string().trim().max(40).nullish(), effectiveFrom: businessDate.nullish(), effectiveTo: businessDate.nullish(),
});
const check = (v: z.infer<typeof Base>) => (v.action !== 'REQUIRE_DOCUMENT' || v.documentTypes.length > 0) && (v.action !== 'REQUIRE_TASK' || !!v.taskTitle?.trim()) && (!v.effectiveFrom || !v.effectiveTo || v.effectiveTo >= v.effectiveFrom);
export const CreateRule = Base.refine(check, { message: 'A document rule needs the accepted ID types; a task rule needs a task title; the end date cannot be before the start' });
export const UpdateRule = Base.partial().extend({ version: z.number().int() });
export const SetStatus = z.object({ status: z.enum(['ACTIVE', 'DISABLED']), version: z.number().int() });
export const Approval = z.object({ reason: z.string().trim().min(3).max(300) });
export const Check = z.object({ propertyId: uuid, stage: z.enum(['BOOKING', 'CHECK_IN']).default('BOOKING'), nationality: iso2.nullish(), residency: z.enum(['RESIDENT', 'NON_RESIDENT']).optional(), guests: z.number().int().min(1).max(50).default(1), nights: z.number().int().min(1).max(365).default(1) });
export const CompleteTask = z.object({ note: z.string().trim().max(300).nullish() });
export const TaskQuery = z.object({ status: z.enum(['OPEN', 'DONE']).default('OPEN') });
