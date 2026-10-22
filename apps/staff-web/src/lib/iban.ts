/** An IBAN passes when its check digits work out (the standard mod-97 test), so a mistyped number is caught as the person leaves the field. */
export const tidyIban = (v: string) => v.replace(/\s+/g, '').toUpperCase();
export function ibanValid(raw: string): boolean {
  const iban = tidyIban(raw);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  let rem = 0;
  for (const ch of iban.slice(4) + iban.slice(0, 4)) { const v = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55); for (const d of v) rem = (rem * 10 + Number(d)) % 97; }
  return rem === 1;
}
/** "PK36SCBL0000001123456702" → "PK36 SCBL 0000 0011 2345 6702", the way it is printed. */
export const groupIban = (v: string) => tidyIban(v).replace(/(.{4})/g, '$1 ').trim();
export const swiftValid = (v: string) => /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v.replace(/\s+/g, '').toUpperCase());
