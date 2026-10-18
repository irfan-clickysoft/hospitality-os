/** Display helpers. Business dates are plain YYYY-MM-DD strings (the property's calendar day) and are never run through time zones. */
export const addDays = (d: string, n: number): string => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const nightsBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const dayRange = (from: string, n: number): string[] => Array.from({ length: n }, (_, i) => addDays(from, i));
export const weekday = (d: string, locale: 'en' | 'ur'): string => new Intl.DateTimeFormat(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
export const shortDate = (d: string, locale: 'en' | 'ur'): string => new Intl.DateTimeFormat(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
export const isWeekend = (d: string): boolean => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w === 5 || w === 6; };

/** "12000.00" → "12,000" (whole rupees when there are no paisa). */
export function money(amount: string | { amount: string; currency?: string }, currency = 'PKR'): string {
  const a = typeof amount === 'string' ? amount : amount.amount;
  const cur = typeof amount === 'string' ? currency : amount.currency ?? currency;
  const neg = a.startsWith('-');
  const [whole = '0', frac = '00'] = a.replace('-', '').split('.');
  const w = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '−' : ''}${cur} ${w}${/^0+$/.test(frac) ? '' : '.' + frac}`;
}
export const isZero = (a: { amount: string }): boolean => /^-?0+(\.0+)?$/.test(a.amount);
export const isNegative = (a: { amount: string }): boolean => a.amount.startsWith('-') && !isZero(a);

/** Pakistani numbers to the international form wa.me expects: 0300 1234567 → 923001234567. */
export function whatsappNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('92') && d.length >= 12) return d;
  if (d.startsWith('0') && d.length === 11) return `92${d.slice(1)}`;
  if (d.length >= 10 && d.length <= 15 && !d.startsWith('0')) return d;
  return null;
}
export const newKey = (): string => `ui-${crypto.randomUUID()}`;
