import { z } from 'zod';
import { businessDate, uuid } from '../property-setup/schemas.js';

const amount = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'an amount like 12000 or 12000.50').nullish().or(z.literal(''));
const list = (n: number, len: number) => z.array(z.string().trim().min(1).max(len)).max(n);
const row = z.object({ label: z.string().trim().min(2).max(160), roomTypeId: uuid.nullish(), p1: amount, p2: amount, p3: amount, p4: amount })
  .refine((r) => [r.p1, r.p2, r.p3, r.p4].some((x) => x), { message: 'Give at least one rate for this room category', path: ['p1'] });
export const ProposalBody = z.object({
  reference: z.string().trim().max(60).nullish(), companyId: uuid.nullish(), companyName: z.string().trim().min(2).max(160), attnName: z.string().trim().max(160).nullish(), attnTitle: z.string().trim().max(160).nullish(),
  issuedOn: businessDate.optional(), validFrom: businessDate, validTo: businessDate, title: z.string().trim().max(200).nullish(), intro: z.string().trim().max(3000).nullish(),
  notes: list(20, 600), facilities: list(40, 400), terms: list(60, 700),
  billing: z.object({ contactName: z.string().trim().max(120).nullish(), phone: z.string().trim().max(60).nullish(), email: z.string().trim().max(254).nullish(), steps: list(20, 700) }),
  signatory: z.string().trim().max(300).nullish(), withPhotos: z.boolean().default(true), rows: z.array(row).min(1).max(30),
}).refine((v) => v.validTo >= v.validFrom, { message: 'The end date is before the start date', path: ['validTo'] });
export const UpdateProposal = ProposalBody.and(z.object({ version: z.number().int() }));
export const ListQuery = z.object({ status: z.enum(['ALL', 'OPEN', 'DRAFT', 'SENT', 'ARCHIVED']).default('OPEN'), q: z.string().trim().max(80).optional() });
