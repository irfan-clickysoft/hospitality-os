/** Normalises phone numbers to digits so the same person is found however the number was typed. Pakistani mobiles → 92XXXXXXXXXX. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d+]/g, '');
  d = d.startsWith('+') ? d.slice(1) : d;
  d = d.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^0\d{10}$/.test(d)) d = `92${d.slice(1)}`;            // 03xx-xxxxxxx → 923xxxxxxxxx
  if (d.length < 7 || d.length > 15) return null;
  return d;
}
