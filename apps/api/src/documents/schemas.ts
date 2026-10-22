import { z } from 'zod';
import { money } from '../folio/schemas.js';
import { uuid } from '../property-setup/schemas.js';

export const KINDS = ['PAYMENT', 'STATEMENT', 'ORDER', 'INVOICE'] as const;
export const LinkBody = z.object({ kind: z.enum(KINDS), refId: uuid });
export const SlipFields = z.object({ amount: money.optional(), reference: z.string().trim().max(80).optional(), bank: z.string().trim().max(80).optional(), note: z.string().trim().max(300).optional() });
export const SlipQuery = z.object({ status: z.enum(['SUBMITTED', 'LINKED', 'REJECTED', 'ALL']).default('SUBMITTED'), limit: z.coerce.number().int().min(1).max(200).default(100) });
export const SlipRecord = z.object({ kind: z.enum(['PAYMENT', 'DEPOSIT']).default('DEPOSIT'), amount: money, reference: z.string().trim().min(3).max(80), counterparty: z.string().trim().min(2).max(80), paymentAccountId: uuid.nullish(), note: z.string().trim().max(300).nullish() });
export const SlipReject = z.object({ reason: z.string().trim().min(3).max(300) });
