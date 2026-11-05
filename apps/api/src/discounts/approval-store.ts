import { sql, type Transaction } from 'kysely';
import type { DB } from '@hos/db';

type Trx = Transaction<DB>;
/** The part of a price search that decides the price: an approval only fits a request that matches it exactly. */
export interface PricedRequest {
  arrival: string; departure: string; adults: number; children: number; extraBeds: number; channel: string; residency: string; companyId: string | null; roomTypeId: string; planId?: string;
  discountPct: number; nightDiscounts: Array<{ date: string; pct: number }>; discountAmount: string | null; agreedTotal: string | null; nightPrices: Array<{ date: string; price: string }>;
}
const money = (v: string | null | undefined) => (v ? Number(v).toFixed(2) : null);
export function canonical(r: Partial<PricedRequest> & Pick<PricedRequest, 'arrival' | 'departure' | 'roomTypeId'>): PricedRequest {
  return { arrival: r.arrival, departure: r.departure, adults: r.adults ?? 2, children: r.children ?? 0, extraBeds: r.extraBeds ?? 0, channel: r.channel ?? 'DIRECT', residency: r.residency ?? 'RESIDENT', companyId: r.companyId ?? null, roomTypeId: r.roomTypeId, ...(r.planId ? { planId: r.planId } : {}),
    discountPct: r.discountPct ?? 0, nightDiscounts: [...(r.nightDiscounts ?? [])].sort((a, b) => a.date.localeCompare(b.date)).map((x) => ({ date: x.date, pct: x.pct })), discountAmount: money(r.discountAmount), agreedTotal: money(r.agreedTotal),
    nightPrices: [...(r.nightPrices ?? [])].sort((a, b) => a.date.localeCompare(b.date)).map((x) => ({ date: x.date, price: Number(x.price).toFixed(2) })) };
}
/** Same price-deciding request (the plan is checked separately). */
export const sameRequest = (a: PricedRequest, b: PricedRequest) => JSON.stringify({ ...canonical(a), planId: undefined }) === JSON.stringify({ ...canonical(b), planId: undefined });      // the database does not keep key order, so both sides are put in the same order first

/** The approval if this person may use it now: theirs, approved, not expired, with rooms left. */
export async function usableApproval(trx: Trx, id: string, userId: string) {
  const a = await trx.selectFrom('discount_approval').selectAll().where('id', '=', id).executeTakeFirst();
  if (!a || a.requested_by !== userId || a.status !== 'APPROVED' || new Date(a.expires_at).getTime() < Date.now() || a.used_rooms >= a.rooms) return null;
  return a;
}
/** Uses up one room of an approval, atomically; null when it can no longer be used. */
export async function consumeApproval(trx: Trx, id: string, userId: string) {
  return trx.updateTable('discount_approval').set({ used_rooms: sql`used_rooms + 1` } as never).where('id', '=', id).where('requested_by', '=', userId).where('status', '=', 'APPROVED').where('expires_at', '>', new Date()).whereRef('used_rooms', '<', 'rooms')
    .returning(['id', 'decided_by', 'decided_at', 'code', 'note']).executeTakeFirst();
}
