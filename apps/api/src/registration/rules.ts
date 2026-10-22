/**
 * What a guest has to show at check-in, by kind of guest — the hotel's document matrix. Kept as plain data and pure functions so the screen, the check-in and the
 * registration card all read the same rules. Nothing here talks to the database.
 */

export const GUEST_TYPES = ['PAKISTANI_ADULT', 'OVERSEAS_PAKISTANI', 'POC_HOLDER', 'FOREIGN_ADULT', 'PAKISTANI_MINOR', 'FOREIGN_MINOR'] as const;
export type GuestType = (typeof GUEST_TYPES)[number];

export const DOCUMENT_KEYS = ['CNIC_OR_PASSPORT', 'NICOP', 'PASSPORT', 'FOREIGN_PASSPORT', 'PASSPORT_BIO_COPY', 'POC', 'ENTRY_STATUS_EVIDENCE', 'VISA_BASIS', 'ENTRY_STAMP', 'MINOR_ID', 'GUARDIAN_ID', 'COMPANY_LETTER'] as const;
export type DocumentKey = (typeof DOCUMENT_KEYS)[number];

export interface Requirement { key: DocumentKey; required: boolean; /** Helps but never replaces an identity document (a company letter). */ supplementary: boolean }

export const FOREIGN_DETAIL_KEYS = ['passportIssuePlace', 'visaType', 'stayExpiry', 'entryDate', 'entryPort', 'localAddress', 'nextDestination'] as const;
export type ForeignDetailKey = (typeof FOREIGN_DETAIL_KEYS)[number];
/** The guest types that need the foreign-guest record (Foreigners Act: nationality, passport, visa, entry, address, destination). */
export const NEEDS_FOREIGN_DETAILS: readonly GuestType[] = ['FOREIGN_ADULT', 'FOREIGN_MINOR', 'POC_HOLDER'];
export const MINORS: readonly GuestType[] = ['PAKISTANI_MINOR', 'FOREIGN_MINOR'];

export interface Options { /** The property has confirmed that a NICOP alone is accepted for overseas Pakistanis. */ nicopAloneOk?: boolean; /** The booking is billed to a company: a company letter or employee card is asked for as supplementary evidence. */ corporate?: boolean }

export function requirementsFor(type: GuestType, o: Options = {}): Requirement[] {
  const req = (key: DocumentKey, required = true, supplementary = false): Requirement => ({ key, required, supplementary });
  const base: Requirement[] = (() => {
    switch (type) {
      case 'PAKISTANI_ADULT': return [req('CNIC_OR_PASSPORT')];
      case 'OVERSEAS_PAKISTANI': return [req('NICOP'), req('PASSPORT', !o.nicopAloneOk)];
      case 'POC_HOLDER': return [req('FOREIGN_PASSPORT'), req('POC'), req('ENTRY_STATUS_EVIDENCE')];
      case 'FOREIGN_ADULT': return [req('FOREIGN_PASSPORT'), req('PASSPORT_BIO_COPY'), req('VISA_BASIS'), req('ENTRY_STAMP')];
      case 'PAKISTANI_MINOR': return [req('MINOR_ID'), req('GUARDIAN_ID')];
      case 'FOREIGN_MINOR': return [req('FOREIGN_PASSPORT'), req('VISA_BASIS'), req('GUARDIAN_ID')];
    }
  })();
  return o.corporate && !MINORS.includes(type) ? [...base, req('COMPANY_LETTER', false, true)] : base;
}

/** A first guess at the kind of guest from what is already on the card; the person at the desk can always change it. */
export function suggestGuestType(i: { nationality?: string | null; ageGroup: 'ADULT' | 'CHILD'; idType?: string | null }): GuestType {
  const pk = i.nationality ? i.nationality.toUpperCase() === 'PK' : i.idType !== 'PASSPORT';
  if (i.ageGroup === 'CHILD') return pk ? 'PAKISTANI_MINOR' : 'FOREIGN_MINOR';
  if (!pk) return 'FOREIGN_ADULT';
  return i.idType === 'NICOP' ? 'OVERSEAS_PAKISTANI' : 'PAKISTANI_ADULT';
}

export type DocState = 'SEEN' | 'NOT_AVAILABLE';
export interface DocRecord { state: DocState; note?: string | null }
export interface ForeignDetails { passportIssuePlace?: string | null; visaType?: string | null; stayExpiry?: string | null; entryDate?: string | null; entryPort?: string | null; localAddress?: string | null; nextDestination?: string | null;
  froInstruction?: boolean | null; formCRef?: string | null; residentialPermitRef?: string | null; remarks?: string | null }

export interface CardPerson {
  name: string; ageGroup: 'ADULT' | 'CHILD'; guestType: GuestType; hasId: boolean; documents: Partial<Record<DocumentKey, DocRecord>>; foreign?: ForeignDetails | null; /** An accompanying adult is linked. */ hasGuardian: boolean; idExpiry?: string | null;
}
export interface Gap { kind: 'ID' | 'DOCUMENT' | 'DETAIL' | 'GUARDIAN'; key: string }
export interface PersonResult { name: string; guestType: GuestType; status: 'COMPLETE' | 'EXCEPTIONS' | 'MISSING'; missing: Gap[]; exceptions: Array<{ key: string; note: string | null }> }
export interface CardResult { complete: boolean; missingCount: number; exceptionCount: number; people: PersonResult[] }

/**
 * Checks the whole card. "Missing" is something required that was neither seen nor given a reason; "exceptions" are required items the desk recorded as not available, with a reason —
 * the hotel can still decide to proceed, but it is on record. Every adult needs an identity document of their own; a child under 18 needs the guardian instead.
 */
export function evaluateCard(people: CardPerson[], o: Options = {}): CardResult {
  const out: PersonResult[] = people.map((p) => {
    const missing: Gap[] = []; const exceptions: Array<{ key: string; note: string | null }> = [];
    if (p.ageGroup === 'ADULT' && !p.hasId) missing.push({ kind: 'ID', key: 'ID' });
    for (const r of requirementsFor(p.guestType, o)) {
      if (!r.required) continue;
      if (r.key === 'GUARDIAN_ID') { if (!p.hasGuardian) missing.push({ kind: 'GUARDIAN', key: r.key }); continue; }
      const d = p.documents[r.key];
      if (d?.state === 'SEEN') continue;
      if (d?.state === 'NOT_AVAILABLE' && (d.note ?? '').trim().length >= 3) { exceptions.push({ key: r.key, note: d.note ?? null }); continue; }
      missing.push({ kind: 'DOCUMENT', key: r.key });
    }
    if (NEEDS_FOREIGN_DETAILS.includes(p.guestType)) {
      for (const k of FOREIGN_DETAIL_KEYS) if (!((p.foreign?.[k] as string | null | undefined) ?? '').toString().trim()) missing.push({ kind: 'DETAIL', key: k });
      if (!p.idExpiry && p.ageGroup === 'ADULT') missing.push({ kind: 'DETAIL', key: 'passportExpiry' });
    }
    return { name: p.name, guestType: p.guestType, status: missing.length ? 'MISSING' : exceptions.length ? 'EXCEPTIONS' : 'COMPLETE', missing, exceptions };
  });
  const missingCount = out.reduce((a, p) => a + p.missing.length, 0), exceptionCount = out.reduce((a, p) => a + p.exceptions.length, 0);
  return { complete: missingCount === 0, missingCount, exceptionCount, people: out };
}
