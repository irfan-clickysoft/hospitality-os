/** Early check-in and late checkout fees: how far from the standard time a guest is, and what share of a night that costs under the property's tiers. Pure, so the check, the desk preview and the settings screen agree. */
export type Kind = 'EARLY_CHECKIN' | 'LATE_CHECKOUT';
export interface TimingTier { upToMinutes: number; percent: number }
export interface TimingRule { early: TimingTier[]; late: TimingTier[] }

export function parseTimingRule(raw: unknown): TimingRule {
  const pick = (v: unknown): TimingTier[] => {
    if (!Array.isArray(v)) return [];
    const t = v.map((x) => ({ upToMinutes: Number((x as TimingTier).upToMinutes), percent: Number((x as TimingTier).percent) }));
    return t.some((x) => !Number.isFinite(x.upToMinutes) || !Number.isFinite(x.percent) || x.upToMinutes <= 0 || x.percent < 0 || x.percent > 100) ? [] : t.sort((a, b) => a.upToMinutes - b.upToMinutes);
  };
  const r = (raw ?? {}) as { early?: unknown; late?: unknown };
  return { early: pick(r.early), late: pick(r.late) };
}
/** The share of the night: the first step the minutes fit in, otherwise the whole night. No steps set means no fee is suggested. */
export const percentFor = (tiers: TimingTier[], minutes: number): number => (tiers.length === 0 ? 0 : (tiers.find((x) => minutes <= x.upToMinutes)?.percent ?? 100));
/** "HH:MM" in the hotel's own time. */
export const localHM = (ms: number, timeZone: string): string => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
export const toMinutes = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
