import type { Key } from '../i18n/en.js';

/** One person on a registration card, as typed. */
export interface Occupant {
  fullName: string; idType: string; idNumber: string; nationality: string; idExpiry: string; ageGroup: 'ADULT' | 'CHILD';
  /** The kind of guest; empty means "worked out from the card". */
  guestType: string; docs: Record<string, { state: 'SEEN' | 'NOT_AVAILABLE'; note?: string }>; foreign: Record<string, string | boolean>; /** Position of the accompanying adult on the card. */ guardian: number | null;
}
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

// ───────────── the document matrix ─────────────
export interface MatrixType { type: string; minor: boolean; foreignDetails: boolean; requirements: Array<{ key: string; required: boolean; supplementary: boolean }>; requirementsCorporate: Array<{ key: string; required: boolean; supplementary: boolean }> }
export interface Matrix { strict: boolean; nicopAloneOk: boolean; foreignDetailKeys: string[]; types: MatrixType[] }
export type DocMap = Record<string, { state: 'SEEN' | 'NOT_AVAILABLE'; note?: string }>;
export const FOREIGN_FIELDS = ['passportIssuePlace', 'visaType', 'stayExpiry', 'entryDate', 'entryPort', 'localAddress', 'nextDestination'] as const;

/** The kind of guest the card suggests: the desk can always change it. */
export function suggestType(o: { nationality: string; ageGroup: 'ADULT' | 'CHILD'; idType: string }): string {
  const pk = o.nationality.trim() ? o.nationality.trim().toUpperCase() === 'PK' : o.idType !== 'PASSPORT';          // no nationality yet and a passport: a foreign guest, until told otherwise
  if (o.ageGroup === 'CHILD') return pk ? 'PAKISTANI_MINOR' : 'FOREIGN_MINOR';
  if (!pk) return 'FOREIGN_ADULT';
  return o.idType === 'NICOP' ? 'OVERSEAS_PAKISTANI' : 'PAKISTANI_ADULT';
}
export const typeOf = (o: Occupant) => o.guestType || suggestType(o);

export interface Gap { kind: 'ID' | 'DOCUMENT' | 'DETAIL' | 'GUARDIAN'; key: string }
/** What is still missing for one person, by the matrix the server sent (the server checks again when the card is submitted). */
export function gapsFor(o: Occupant, index: number, all: Occupant[], m: Matrix | null, corporate = false): Gap[] {
  if (!m) return [];
  const t = m.types.find((x) => x.type === typeOf(o));
  if (!t) return [];
  const gaps: Gap[] = [];
  if (o.ageGroup === 'ADULT' && !o.idNumber.trim()) gaps.push({ kind: 'ID', key: 'ID' });
  for (const r of corporate ? t.requirementsCorporate : t.requirements) {
    if (!r.required) continue;
    if (r.key === 'GUARDIAN_ID') { const g = o.guardian; if (g === null || g === undefined || g === index || !all[g] || all[g]!.ageGroup !== 'ADULT' || !all[g]!.idNumber.trim()) gaps.push({ kind: 'GUARDIAN', key: r.key }); continue; }
    const d = o.docs[r.key];
    if (d?.state === 'SEEN') continue;
    if (d?.state === 'NOT_AVAILABLE' && (d.note ?? '').trim().length >= 3) continue;
    gaps.push({ kind: 'DOCUMENT', key: r.key });
  }
  if (t.foreignDetails) {
    for (const k of FOREIGN_FIELDS) if (!String(o.foreign[k] ?? '').trim()) gaps.push({ kind: 'DETAIL', key: k });
    if (o.ageGroup === 'ADULT' && !o.idExpiry) gaps.push({ kind: 'DETAIL', key: 'passportExpiry' });
  }
  return gaps;
}
