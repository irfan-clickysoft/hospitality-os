import { z } from 'zod';
import { businessDate, uuid } from '../property-setup/schemas.js';

const pct = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'a percentage like 10 or 12.5').refine((v) => Number(v) <= 100, 'at most 100%');
const amount = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'an amount like 5000 or 5000.50');
/** A discount typed the way people say it: "10" percent, or "5000" rupees. */
export const DiscountIn = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('NONE') }), z.object({ kind: z.literal('PCT'), value: pct }), z.object({ kind: z.literal('AMOUNT'), value: amount }),
]);
export const DepositIn = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('NONE') }), z.object({ kind: z.literal('PCT'), value: pct }), z.object({ kind: z.literal('AMOUNT'), value: amount }),
]);
const line = z.object({
  roomTypeId: uuid, ratePlanId: uuid.nullish(), rooms: z.number().int().min(1).max(60), arrival: businessDate, departure: businessDate,
  adults: z.number().int().min(1).max(20).default(2), children: z.number().int().min(0).max(20).default(0), extraBeds: z.number().int().min(0).max(5).default(0),
  discount: DiscountIn.default({ kind: 'NONE' }), note: z.string().trim().max(300).nullish(),
}).refine((l) => l.departure > l.arrival, { message: 'departure must be after arrival', path: ['departure'] });
const phone = z.string().trim().max(40).regex(/^[+\d][\d\s\-()+]{5,39}$/, 'a phone number');
export const QuotationBody = z.object({
  customerName: z.string().trim().min(2).max(120), companyId: uuid.nullish(), guestId: uuid.nullish(),
  contactName: z.string().trim().max(120).nullish(), phone: phone.nullish(), email: z.string().trim().email().max(254).nullish(),
  residency: z.enum(['RESIDENT', 'NON_RESIDENT']).default('RESIDENT'), title: z.string().trim().max(160).nullish(), validUntil: businessDate,
  discount: DiscountIn.default({ kind: 'NONE' }), discountReason: z.string().trim().max(200).nullish(), deposit: DepositIn.default({ kind: 'NONE' }),
  specialRequests: z.string().trim().max(2000).nullish(), amenities: z.array(z.string().trim().min(1).max(80)).max(30).default([]), terms: z.string().trim().max(4000).nullish(),
  notesInternal: z.string().trim().max(2000).nullish(), lines: z.array(line).min(1).max(30),
});
export const UpdateQuotation = QuotationBody.and(z.object({ version: z.number().int() }));
export const ListQuery = z.object({ status: z.enum(['ALL', 'OPEN', 'DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'CONVERTED']).default('OPEN'), q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
export const Mark = z.object({ status: z.enum(['ACCEPTED', 'DECLINED']), note: z.string().trim().max(1000).nullish() }).strict();
export const Respond = z.object({ decision: z.enum(['ACCEPT', 'DECLINE']), name: z.string().trim().min(2).max(120), note: z.string().trim().max(1000).optional() }).strict();
export const Convert = z.object({ guestId: uuid.optional(), acceptNewPrice: z.boolean().default(false) }).strict();
