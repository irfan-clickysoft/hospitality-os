import { z } from 'zod';
const phone = z.string().min(7).max(25).regex(/^[+\d][\d\s\-()+]{5,24}$/, 'phone number');
const nationality = z.string().regex(/^[A-Za-z]{2}$/, 'two-letter country code like PK').transform((v) => v.toUpperCase());
export const CreateGuest = z.object({
  fullName: z.string().trim().min(2).max(160), phone: phone.nullish(), email: z.string().email().max(254).nullish(), nationality: nationality.nullish(),
  vip: z.boolean().default(false), notes: z.string().max(2000).nullish(), allowDuplicate: z.boolean().default(false),
});
export const UpdateGuest = z.object({
  fullName: z.string().trim().min(2).max(160).optional(), phone: phone.nullish(), email: z.string().email().max(254).nullish(), nationality: nationality.nullish(),
  vip: z.boolean().optional(), doNotRent: z.boolean().optional(), notes: z.string().max(2000).nullish(), version: z.number().int(),
});
export const residencyOf = (nationality: string | null | undefined): 'RESIDENT' | 'NON_RESIDENT' => (!nationality || nationality === 'PK' ? 'RESIDENT' : 'NON_RESIDENT');
