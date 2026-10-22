import { z } from 'zod';

/** An IBAN passes when its check digits work out (the standard mod-97 test), so a mistyped number is caught as it is entered. */
export function ibanValid(iban: string): boolean {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) { const v = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55); for (const d of v) rem = (rem * 10 + Number(d)) % 97; }
  return rem === 1;
}
const clean = (v: string) => v.replace(/\s+/g, '').toUpperCase();
const iban = z.string().trim().transform(clean).refine(ibanValid, 'This IBAN is not valid. Check it against the bank letter or cheque book.');
const swift = z.string().trim().transform(clean).refine((v) => /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v), 'A SWIFT code has 8 or 11 letters and digits, like HABBPKKA');
import { businessDate } from '../property-setup/schemas.js';
import { uuid } from '../property-setup/schemas.js';

const Base = z.object({
  kind: z.enum(['BANK', 'CARD_CLEARING', 'WALLET', 'GATEWAY']), name: z.string().trim().min(2).max(80), propertyId: uuid.nullish(), bankName: z.string().trim().max(80).nullish(), accountTitle: z.string().trim().max(120).nullish(),
  last4: z.string().regex(/^[0-9A-Za-z]{4}$/, 'the last four characters of the account number').nullish(),
  branch: z.string().trim().max(120).nullish(), branchCode: z.string().trim().max(20).nullish(), branchAddress: z.string().trim().max(300).nullish(),
  iban: iban.nullish(), swiftCode: swift.nullish(), accountNumber: z.string().trim().regex(/^[0-9A-Za-z -]{4,34}$/, 'Enter the account number as printed').nullish(),
  /** Who legally owns the account. Anything other than the company must say whose. */
  ownerType: z.enum(['COMPANY', 'PERSONAL', 'OTHER']).default('COMPANY'), ownerName: z.string().trim().max(120).nullish(), note: z.string().trim().max(300).nullish(),
});
export const CreateAccount = Base.refine((v) => v.ownerType === 'COMPANY' || (v.ownerName?.trim().length ?? 0) >= 2, { message: 'Say whose account this is', path: ['ownerName'] });
export const UpdateAccount = Base.partial().extend({ version: z.number().int() });
export const CloseAccount = z.object({ version: z.number().int(), reason: z.string().trim().min(3).max(300) });
export const SummaryQuery = z.object({ from: businessDate.optional(), to: businessDate.optional() });
export const ListQuery = z.object({ includeClosed: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') });
