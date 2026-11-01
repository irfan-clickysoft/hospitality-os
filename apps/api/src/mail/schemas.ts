import { z } from 'zod';
import { uuid } from '../property-setup/schemas.js';

const address = z.string().trim().toLowerCase().max(254).regex(/^[^\s<>",;@]+@[^\s<>",;@]+\.[^\s<>",;@]+$/, 'Enter one email address');
export const Send = z.object({
  purpose: z.enum(['GUEST', 'COMPANY', 'QUOTATION', 'PROPOSAL', 'REPORT']), refId: uuid, to: address,
  subject: z.string().trim().min(1).max(200).regex(/^[^\r\n]*$/, 'The subject is one line'),
  text: z.string().trim().min(10).max(8000),
}).strict();
export const GuestSend = Send.omit({ purpose: true }).extend({ reservationId: uuid }).omit({ refId: true }).strict();
export const CompanySend = Send.omit({ purpose: true, refId: true }).strict();
export const QuotationSend = Send.omit({ purpose: true, refId: true }).strict();
export const ProposalSend = Send.omit({ purpose: true, refId: true }).strict();
