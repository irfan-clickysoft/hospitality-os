import { z } from 'zod';
import { businessDate } from '../property-setup/schemas.js';
import { uuid } from '../property-setup/schemas.js';

const Base = z.object({
  kind: z.enum(['BANK', 'CARD_CLEARING', 'WALLET', 'GATEWAY']), name: z.string().trim().min(2).max(80), propertyId: uuid.nullish(), bankName: z.string().trim().max(80).nullish(), accountTitle: z.string().trim().max(120).nullish(),
  last4: z.string().regex(/^[0-9A-Za-z]{4}$/, 'the last four characters of the account number').nullish(),
  /** Who legally owns the account. Anything other than the company must say whose. */
  ownerType: z.enum(['COMPANY', 'PERSONAL', 'OTHER']).default('COMPANY'), ownerName: z.string().trim().max(120).nullish(), note: z.string().trim().max(300).nullish(),
});
export const CreateAccount = Base.refine((v) => v.ownerType === 'COMPANY' || (v.ownerName?.trim().length ?? 0) >= 2, { message: 'Say whose account this is', path: ['ownerName'] });
export const UpdateAccount = Base.partial().extend({ version: z.number().int() });
export const CloseAccount = z.object({ version: z.number().int(), reason: z.string().trim().min(3).max(300) });
export const SummaryQuery = z.object({ from: businessDate.optional(), to: businessDate.optional() });
export const ListQuery = z.object({ includeClosed: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') });
