import { z } from 'zod';
import { businessDate, uuid } from '../property-setup/schemas.js';
import { money } from '../folio/schemas.js';

const text = (max: number) => z.string().trim().max(max);
const reason = z.string().trim().min(3).max(300);

export const CreateCompany = z.object({
  name: z.string().trim().min(2).max(160), ntn: text(40).nullish(), strn: text(40).nullish(), address: text(400).nullish(),
  contactName: text(120).nullish(), contactPhone: text(40).nullish(), contactEmail: z.string().trim().email().max(160).nullish(),
  creditLimit: money.default('0'), termsDays: z.number().int().min(0).max(365).default(30), notes: text(500).nullish(),
});
/** Changing the credit limit or the payment terms is a second-factor action. */
export const UpdateCompany = CreateCompany.partial();
export const SetStatus = z.object({ status: z.enum(['ACTIVE', 'ON_HOLD', 'ARCHIVED']), reason: reason.optional() })
  .refine((v) => v.status === 'ACTIVE' || !!v.reason, { message: 'Give a reason', path: ['reason'] });
export const ListCompanies = z.object({ q: z.string().trim().max(80).optional(), status: z.enum(['ACTIVE', 'ON_HOLD', 'ARCHIVED']).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });

export const BillToCompany = z.object({
  companyId: uuid.optional(), amount: money.optional(), note: text(300).nullish(),
  /** Needed to bill above the credit limit or while the company is on hold: a manager's decision, with a reason. */
  override: z.object({ reason }).optional(),
});
export const VoidItem = z.object({ reason });

export const RecordReceipt = z.object({
  method: z.enum(['BANK_TRANSFER', 'CHEQUE', 'WALLET']), amount: money, reference: z.string().trim().min(3).max(80), counterparty: text(120).nullish(),
  receivedOn: businessDate, note: text(300).nullish(),
  /** Tax the company withheld from this payment. It settles what is owed too, and needs the certificate or challan number. */
  withheld: money.default('0'), withholdingRef: text(80).nullish(),
  applyTo: z.array(uuid).max(200).default([]),
});
export const VerifyReceipt = z.object({ approve: z.boolean(), note: text(300).nullish() });
export const StatementQuery = z.object({ from: businessDate.optional(), to: businessDate.optional() });
export const AgingQuery = z.object({ asOf: businessDate.optional() });
export const IdParam = z.object({ id: uuid });
