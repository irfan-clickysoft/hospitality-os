import { z } from 'zod';
import { QuoteRequest } from '../rates/schemas.js';
import { uuid } from '../property-setup/schemas.js';
import { DISCOUNT_CODES } from './reasons.js';

/** Why a discount was given (a standard reason, plus the desk's own words). */
export const DiscountReason = z.object({ code: z.enum(DISCOUNT_CODES), note: z.string().trim().max(300).optional() }).strict();
/** A request for a manager to approve a discount above what the requester may give: the same price search, which room and rate, how many rooms, and why. */
export const ApprovalRequest = z.object({ quote: QuoteRequest, roomTypeId: uuid, planId: uuid, rooms: z.number().int().min(1).max(10).default(1), reason: DiscountReason }).strict();
export const Decision = z.object({ note: z.string().trim().max(300).optional() }).strict();
export const RejectDecision = z.object({ note: z.string().trim().min(3).max(300) }).strict();
export const ApprovalList = z.object({ status: z.string().max(80).optional(), mine: z.enum(['true', 'false']).default('false') });
