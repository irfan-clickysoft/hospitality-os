/**
 * Pure tax arithmetic. The engine carries no rates: it applies whatever approved, effective-dated versions it is given.
 * Exclusive pricing only (quotes and rates exclude tax; tax is added on top).
 */
export interface TaxVersionRule {
  id: string; code: string; rateBp: number; appliesTo: readonly string[]; residency: 'RESIDENT' | 'NON_RESIDENT' | null; effectiveFrom: string; effectiveTo: string | null;
}
export interface TaxContext { txnCode: string; date: string; residency: 'RESIDENT' | 'NON_RESIDENT' }
export interface TaxLine { versionId: string; code: string; rateBp: number; taxableMinor: bigint; taxMinor: bigint }

/** The transaction code a posting is taxed as (a room discount reduces the room's taxable value). */
export const taxAs = (txnCode: string): string => (txnCode === 'ROOM_DISCOUNT' ? 'ROOM' : txnCode);

export const applies = (v: TaxVersionRule, c: TaxContext): boolean =>
  v.appliesTo.includes(c.txnCode) && v.effectiveFrom <= c.date && (v.effectiveTo === null || c.date <= v.effectiveTo) && (v.residency === null || v.residency === c.residency);

/** Half away from zero at the paisa, symmetric for negative amounts, so a charge and an equal discount always cancel exactly. */
export function taxOn(netMinor: bigint, rateBp: number): bigint {
  const abs = netMinor < 0n ? -netMinor : netMinor;
  const t = (abs * BigInt(rateBp) + 5000n) / 10000n;
  return netMinor < 0n ? -t : t;
}
export function computeTax(versions: readonly TaxVersionRule[], ctx: TaxContext, netMinor: bigint): TaxLine[] {
  if (netMinor === 0n) return [];
  return versions.filter((v) => applies(v, ctx)).map((v) => ({ versionId: v.id, code: v.code, rateBp: v.rateBp, taxableMinor: netMinor, taxMinor: taxOn(netMinor, v.rateBp) }));
}
