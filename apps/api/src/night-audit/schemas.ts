import { z } from 'zod';
import { businessDate, uuid } from '../property-setup/schemas.js';

export const EXCEPTION_KINDS = ['OPEN_CASHIER_SESSION', 'DEPARTURE_OVERDUE', 'LEDGER_INVARIANT', 'INVENTORY_INVARIANT', 'EARLY_AUDIT', 'ARRIVAL_PENDING', 'PENDING_BANK_TRANSFER'] as const;
export const StartRun = z.object({
  /** Proceed past these blocking exceptions. Needs the override permission, a fresh second factor and a reason for each. */
  overrides: z.array(z.object({ kind: z.enum(EXCEPTION_KINDS), reason: z.string().trim().min(3).max(300) })).max(10).default([]),
});
export const RunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(60).default(15) });
export const ReportsQuery = z.object({ from: businessDate.optional(), to: businessDate.optional(), limit: z.coerce.number().int().min(1).max(366).default(31) });
export const RunParam = z.object({ id: uuid });
