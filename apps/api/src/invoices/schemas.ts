import { z } from 'zod';

export const IssueInvoice = z.object({
  /** Who the invoice is made out to, when it is not the guest (a company, with its registration numbers). */
  billTo: z.object({ name: z.string().trim().min(2).max(160), ntn: z.string().trim().max(40).nullish(), strn: z.string().trim().max(40).nullish(), address: z.string().trim().max(400).nullish() }).optional(),
});
export const CreditInvoice = z.object({ reason: z.string().trim().min(3).max(300) });
