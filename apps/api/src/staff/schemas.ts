import { z } from 'zod';
import { uuid } from '../property-setup/schemas.js';

export const CreateUser = z.object({ email: z.string().trim().toLowerCase().email().max(254), fullName: z.string().trim().min(2).max(120), locale: z.enum(['en', 'ur']).default('en') });
const Limits = z.object({ max_discount_pct: z.number().min(0).max(100).optional(), max_refund_minor: z.number().int().min(0).optional(), max_payment_minor: z.number().int().min(0).optional() }).strict();
export const AssignRole = z.object({
  roleKey: z.string().trim().min(2).max(60), scopeType: z.enum(['TENANT', 'PROPERTY']), scopeId: uuid.nullish(), validTo: z.string().datetime().nullish(), limits: Limits.default({}),
}).refine((v) => (v.scopeType === 'TENANT') === !v.scopeId, { message: 'A property role needs the property; a tenant-wide role must not have one', path: ['scopeId'] });
export const AssignRoles = z.object({
  roleKeys: z.array(z.string().trim().min(2).max(60)).min(1).max(12), scopeType: z.enum(['TENANT', 'PROPERTY']), scopeId: uuid.nullish(), validTo: z.string().datetime().nullish(), limits: Limits.default({}),
}).refine((v) => (v.scopeType === 'TENANT') === !v.scopeId, { message: 'A property role needs the property; a tenant-wide role must not have one', path: ['scopeId'] });
export const RevokeRoles = z.object({ assignmentIds: z.array(uuid).min(1).max(12), reason: z.string().trim().min(3).max(300) });
export const Reason = z.object({ reason: z.string().trim().min(3).max(300) });
export const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), action: z.string().trim().max(60).optional(), before: z.string().datetime().optional() });
export const Phone = z.object({ phone: z.string().trim().max(30).regex(/^[0-9+() -]{6,30}$/, 'Enter a phone number').nullable() });
