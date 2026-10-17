/**
 * Business dates are plain calendar dates (YYYY-MM-DD) in the PROPERTY's timezone — never JS Date objects, which carry a time zone
 * and silently shift days. A stay occupies nights [arrival, departure): the departure date is not a night.
 */
const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isBusinessDate(s: string): boolean {
  const m = RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function assertBusinessDate(s: string, label = 'date'): string {
  if (!isBusinessDate(s)) throw new RangeError(`${label} must be a valid YYYY-MM-DD date`);
  return s;
}

const toMs = (s: string) => { const m = RE.exec(assertBusinessDate(s))!; return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])); };
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(s: string, n: number): string { return fromMs(toMs(s) + n * 86_400_000); }
export function diffDays(later: string, earlier: string): number { return Math.round((toMs(later) - toMs(earlier)) / 86_400_000); }
export function compareDates(a: string, b: string): -1 | 0 | 1 { return a === b ? 0 : a < b ? -1 : 1; }

/** Nights of a stay [from, to). Throws for an empty or inverted range, and for stays longer than `maxNights`. */
export function nightsOf(from: string, to: string, maxNights = 366): string[] {
  const n = diffDays(to, from);
  if (n <= 0) throw new RangeError('departure must be after arrival');
  if (n > maxNights) throw new RangeError(`stay cannot exceed ${maxNights} nights`);
  return Array.from({ length: n }, (_, i) => addDays(from, i));
}

/** ISO weekday 1 (Mon) … 7 (Sun). */
export function isoWeekday(s: string): number { const d = new Date(toMs(s)).getUTCDay(); return d === 0 ? 7 : d; }
