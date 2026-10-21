/** Basis points (1% = 100) for a percentage given to two decimals. */
export const toBp = (pct: number) => Math.round(pct * 100);

/** The discount on each night when nights carry their own percentage: each night's price × its own percentage, rounded down to the paisa. */
export function perNightDiscounts(totals: bigint[], bps: number[]): bigint[] {
  return totals.map((t, k) => (t * BigInt(bps[k] ?? 0)) / 10000n);
}

/** One percentage per night of the stay, from a whole-stay default and any per-date overrides. */
export function nightBpFor(dates: string[], defaultPct: number, overrides: Array<{ date: string; pct: number }>): number[] {
  const by = new Map(overrides.map((o) => [o.date, o.pct]));
  return dates.map((d) => toBp(by.get(d) ?? defaultPct));
}
