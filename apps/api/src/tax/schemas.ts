import { z } from 'zod';
import { businessDate, uuid } from '../property-setup/schemas.js';

const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,30}$/, 'letters, digits, - and _ (2–30)');
export const TXN_CODES = ['ROOM', 'ROOM_EXTRAS', 'FNB', 'LAUNDRY', 'TRANSPORT', 'MINIBAR', 'MISC', 'CANCEL_FEE', 'NOSHOW_FEE'] as const;
export const VersionBody = z.object({
  /** Basis points: 1600 = 16.00%. */
  rateBp: z.number().int().min(0).max(10000),
  appliesTo: z.array(z.enum(TXN_CODES)).min(1),
  residency: z.enum(['RESIDENT', 'NON_RESIDENT']).nullish(),
  effectiveFrom: businessDate, effectiveTo: businessDate.nullish(),
  /** Charged when the posting is made. Settlement-dependent rates are not supported yet and are refused. */
  determinationPoint: z.literal('ON_POSTING').default('ON_POSTING'),
  inputTaxTreatment: z.enum(['RECOVERABLE', 'NOT_RECOVERABLE', 'NOT_APPLICABLE']).default('NOT_APPLICABLE'),
  legalBasis: z.string().trim().max(1000).nullish(), advisorRef: z.string().trim().max(200).nullish(),
}).refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { message: 'effectiveTo cannot be before effectiveFrom' });
export const CreateCode = z.object({ code, name: z.string().trim().min(2).max(120), jurisdiction: code, version: VersionBody });
export const Approve = z.object({ advisorRef: z.string().trim().min(3).max(200), legalBasis: z.string().trim().min(3).max(1000), note: z.string().trim().max(300).nullish() });
export const Decision = z.object({ reason: z.string().trim().min(3).max(300) });
export const SetJurisdiction = z.object({ jurisdiction: code.nullable() });
export const Preview = z.object({
  date: businessDate.optional(), residency: z.enum(['RESIDENT', 'NON_RESIDENT']).default('RESIDENT'),
  lines: z.array(z.object({ txnCode: z.enum(TXN_CODES), amount: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/) })).min(1).max(50),
});
export const LiabilityQuery = z.object({ from: businessDate, to: businessDate });
export const UpdateLegalEntity = z.object({
  name: z.string().trim().min(2).max(160).optional(), ntn: z.string().trim().max(40).nullish(), strn: z.string().trim().max(40).nullish(), address: z.string().trim().max(400).nullish(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
});
export const IdParam = z.object({ id: uuid });
