import { z } from 'zod';
import { money } from '../folio/schemas.js';
import { businessDate } from '../property-setup/schemas.js';

const note = z.string().trim().min(3).max(300);
export const ClaimFee = z.object({ kind: z.enum(['NO_SHOW', 'LATE_CANCELLATION', 'OTHER']), amount: money.optional(), note: z.string().trim().max(300).nullish() });
export const MarkClaimed = z.object({ claimRef: z.string().trim().max(80).nullish(), claimedOn: businessDate.optional() });
export const Receive = z.object({ amount: money, reference: z.string().trim().min(3).max(80), receivedOn: businessDate.optional(), note: z.string().trim().max(300).nullish() });
export const Dispute = z.object({ reason: note });
export const Resolve = z.object({ note });
export const WriteOff = z.object({ amount: money.optional(), reason: note });
export const VoidClaim = z.object({ reason: note });
export const ListQuery = z.object({ status: z.enum(['CLAIMABLE', 'CLAIMED', 'RECEIVED', 'DISPUTED', 'WRITTEN_OFF', 'VOID', 'OPEN']).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
