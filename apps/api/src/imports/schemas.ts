import { z } from 'zod';

const cell = z.union([z.string(), z.number()]).nullish().transform((v) => (v === null || v === undefined ? '' : String(v).trim()));
export const MAX_ROWS = 2000;
export const GuestRow = z.object({ fullName: cell, phone: cell, email: cell, nationality: cell, vip: cell, notes: cell });
export const CompanyRow = z.object({ name: cell, ntn: cell, strn: cell, address: cell, contactName: cell, contactPhone: cell, contactEmail: cell, creditLimit: cell, termsDays: cell, notes: cell });
export const GuestImport = z.object({ rows: z.array(GuestRow).min(1).max(MAX_ROWS), onExisting: z.enum(['SKIP', 'FILL_BLANKS']).default('SKIP') });
export const CompanyImport = z.object({ rows: z.array(CompanyRow).min(1).max(MAX_ROWS) });
