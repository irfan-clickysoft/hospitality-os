/**
 * The short-stay rule: how much of one night a guest is charged who checks in and leaves the same day. Pure, so the check-out, its preview and the settings screen all read it the same way.
 */
export interface Tier { upToHours: number; percent: number }
export interface ShortStayRule { tiers: Tier[] }

/** Whether a stored rule is one we understand (the database keeps whatever was saved; a bad value is treated as "no rule", never as a crash). */
export function parseRule(raw: unknown): ShortStayRule | null {
  const t = (raw as { tiers?: unknown } | null)?.tiers;
  if (!Array.isArray(t) || !t.length) return null;
  const tiers = t.map((x) => ({ upToHours: Number((x as Tier).upToHours), percent: Number((x as Tier).percent) }));
  if (tiers.some((x) => !Number.isFinite(x.upToHours) || !Number.isFinite(x.percent) || x.upToHours <= 0 || x.percent < 0 || x.percent > 100)) return null;
  return { tiers: tiers.sort((a, b) => a.upToHours - b.upToHours) };
}

/** The share of the night to charge for a stay of `hours` hours: the first tier it fits in, otherwise the whole night. */
export function percentFor(rule: ShortStayRule | null, hours: number): number {
  if (!rule) return 100;
  return rule.tiers.find((x) => hours <= x.upToHours)?.percent ?? 100;
}

/** `total` × `percent` %, rounded to the nearest unit of the smallest currency unit. */
export const share = (total: bigint, percent: number): bigint => (total * BigInt(Math.round(percent * 100)) + 5000n) / 10000n;
