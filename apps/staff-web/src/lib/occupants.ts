import type { Key } from '../i18n/en.js';

/** One person on a registration card, as typed. */
export interface Occupant { fullName: string; idType: string; idNumber: string; nationality: string; idExpiry: string; ageGroup: 'ADULT' | 'CHILD' }
export type OccErrors = Partial<Record<'fullName' | 'idType' | 'idNumber' | 'nationality' | 'idExpiry', Key>>;

const digits = (s: string) => s.replace(/[\s-]/g, '');

/** What is wrong with an ID number of this type, or null. Mirrors the server's own rules so the person learns as they leave the field, not after pressing the button. */
export function idNumberError(type: string, raw: string): Key | null {
  const s = raw.trim();
  if (type === 'CNIC' || type === 'NICOP') return /^\d{13}$/.test(digits(s)) ? null : 'ci.e.cnic';
  if (type === 'PASSPORT') return /^[A-Za-z0-9]{5,15}$/.test(s.replace(/\s/g, '')) ? null : 'ci.e.passport';
  return /^[A-Za-z0-9][A-Za-z0-9 /.-]{3,29}$/.test(s.replace(/\s+/g, ' ')) ? null : 'ci.e.otherId';
}

/** The number the way it is printed: 3520212345671 → 35202-1234567-1, a passport in capitals. Left alone when it is not valid yet. */
export function formatId(type: string, raw: string): string {
  const s = raw.trim();
  if ((type === 'CNIC' || type === 'NICOP') && /^\d{13}$/.test(digits(s))) { const d = digits(s); return `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`; }
  if (type === 'PASSPORT') return s.replace(/\s/g, '').toUpperCase();
  return s;
}

/**
 * What is wrong with one guest's card. Only the main guest must have an ID; children (under 18 have none) and family members covered by the main guest's ID may leave it empty.
 * Whatever is entered must still be valid.
 */
export function checkOccupant(o: Occupant, i: number, foreign: boolean, businessDate: string): OccErrors {
  const e: OccErrors = {};
  const main = i === 0;
  const hasId = o.idNumber.trim() !== '';
  if (!o.fullName.trim()) e.fullName = 'ci.e.name';
  if (main && foreign && o.idType !== 'PASSPORT') e.idType = 'ci.e.passportOnly';
  if (!hasId) { if (main) e.idNumber = 'ci.e.idNumber'; }
  else { const bad = idNumberError(o.idType, o.idNumber); if (bad) e.idNumber = bad; }
  if (o.nationality.trim() ? o.nationality.trim().length !== 2 : (main || (hasId && o.ageGroup === 'ADULT'))) e.nationality = 'ci.e.nationality';
  if (o.idType === 'PASSPORT' && hasId && o.idExpiry && o.idExpiry < businessDate) e.idExpiry = 'ci.e.expired';
  return e;
}

export const hasErrors = (all: OccErrors[]) => all.some((e) => Object.keys(e).length > 0);
