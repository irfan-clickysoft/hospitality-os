import { z } from 'zod';
import { businessDate } from '../property-setup/schemas.js';
import { MANUAL_CODES } from './txn-codes.js';

export const money = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'amount like 2500 or 2500.50');
const reason = z.string().trim().min(3).max(300);

export const ManualCharge = z.object({
  txnCode: z.enum(MANUAL_CODES), amount: money, quantity: z.number().min(0.001).max(9999).default(1),
  description: z.string().trim().min(2).max(120), note: z.string().max(300).nullish(),
});
export const DiscountPosting = z.object({ pct: z.number().min(0.01).max(100), reason });
export const ReversePosting = z.object({ reason });
export const RecordPayment = z.object({
  kind: z.enum(['PAYMENT', 'DEPOSIT']).default('PAYMENT'), method: z.enum(['CASH', 'BANK_TRANSFER', 'CARD_SLIP', 'WALLET']), amount: money,
  reference: z.string().trim().min(3).max(80).nullish(), cardLast4: z.string().regex(/^\d{4}$/).nullish(), approvalCode: z.string().trim().max(40).nullish(),
  counterparty: z.string().trim().max(80).nullish(), note: z.string().max(300).nullish(), paymentAccountId: z.string().uuid().nullish(),
});
export const VerifyPayment = z.object({ approve: z.boolean(), note: z.string().trim().max(300).nullish() });
export const VoidPayment = z.object({ reason });
export const RefundPayment = z.object({
  amount: money, reason, method: z.enum(['CASH', 'BANK_TRANSFER', 'CARD_SLIP', 'WALLET']).optional(),
  counterparty: z.string().trim().max(120).nullish(), reference: z.string().trim().max(80).nullish(), paymentAccountId: z.string().uuid().nullish(),
});
export const OpenSession = z.object({ openingFloat: money.default('0'), registerName: z.string().trim().min(1).max(60).default('Front desk') });
export const CashDrop = z.object({ amount: money, note: z.string().max(200).nullish() });
export const CloseSession = z.object({ counted: money, note: z.string().max(300).nullish() });
export const ReviewSession = z.object({ note: z.string().trim().max(300).nullish() });
export const SessionsQuery = z.object({ status: z.enum(['OPEN', 'CLOSED', 'REVIEWED']).optional(), date: businessDate.optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
