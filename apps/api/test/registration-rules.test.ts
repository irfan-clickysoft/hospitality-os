import { describe, expect, it } from 'vitest';
import { evaluateCard, requirementsFor, suggestGuestType, type CardPerson } from '../src/registration/rules.js';

const keys = (t: Parameters<typeof requirementsFor>[0], o = {}) => requirementsFor(t, o).filter((r) => r.required).map((r) => r.key);
const person = (p: Partial<CardPerson> = {}): CardPerson => ({ name: 'Ali', ageGroup: 'ADULT', guestType: 'PAKISTANI_ADULT', hasId: true, documents: {}, hasGuardian: false, ...p });

describe('the document matrix', () => {
  it('asks each kind of guest for what the hotel requires', () => {
    expect(keys('PAKISTANI_ADULT')).toEqual(['CNIC_OR_PASSPORT']);
    expect(keys('OVERSEAS_PAKISTANI')).toEqual(['NICOP', 'PASSPORT']);
    expect(keys('OVERSEAS_PAKISTANI', { nicopAloneOk: true })).toEqual(['NICOP']);                       // once Hotel Eye confirms a NICOP alone is accepted
    expect(keys('POC_HOLDER')).toEqual(['FOREIGN_PASSPORT', 'POC', 'ENTRY_STATUS_EVIDENCE']);
    expect(keys('FOREIGN_ADULT')).toEqual(['FOREIGN_PASSPORT', 'PASSPORT_BIO_COPY', 'VISA_BASIS', 'ENTRY_STAMP']);
    expect(keys('PAKISTANI_MINOR')).toEqual(['MINOR_ID', 'GUARDIAN_ID']);
    expect(keys('FOREIGN_MINOR')).toEqual(['FOREIGN_PASSPORT', 'VISA_BASIS', 'GUARDIAN_ID']);
  });
  it('a company letter is only supplementary and never required', () => {
    const r = requirementsFor('PAKISTANI_ADULT', { corporate: true });
    expect(r.find((x) => x.key === 'COMPANY_LETTER')).toMatchObject({ required: false, supplementary: true });
    expect(requirementsFor('PAKISTANI_ADULT').some((x) => x.key === 'COMPANY_LETTER')).toBe(false);
  });
  it('guesses the kind of guest from the card, and leaves overseas Pakistanis and POC holders to the desk', () => {
    expect(suggestGuestType({ nationality: 'PK', ageGroup: 'ADULT', idType: 'CNIC' })).toBe('PAKISTANI_ADULT');
    expect(suggestGuestType({ nationality: 'PK', ageGroup: 'ADULT', idType: 'NICOP' })).toBe('OVERSEAS_PAKISTANI');
    expect(suggestGuestType({ nationality: 'GB', ageGroup: 'ADULT' })).toBe('FOREIGN_ADULT');
    expect(suggestGuestType({ nationality: 'PK', ageGroup: 'CHILD' })).toBe('PAKISTANI_MINOR');
    expect(suggestGuestType({ nationality: 'US', ageGroup: 'CHILD' })).toBe('FOREIGN_MINOR');
  });
});

describe('checking a card', () => {
  it('a Pakistani adult with the document seen is complete; without it, missing', () => {
    expect(evaluateCard([person({ documents: { CNIC_OR_PASSPORT: { state: 'SEEN' } } })]).complete).toBe(true);
    const r = evaluateCard([person()]);
    expect(r.complete).toBe(false); expect(r.people[0]!.missing).toEqual([{ kind: 'DOCUMENT', key: 'CNIC_OR_PASSPORT' }]);
  });
  it('a document not available is an exception only when a reason is given', () => {
    expect(evaluateCard([person({ documents: { CNIC_OR_PASSPORT: { state: 'NOT_AVAILABLE', note: 'Lost, police report shown' } } })]).people[0]).toMatchObject({ status: 'EXCEPTIONS', exceptions: [{ key: 'CNIC_OR_PASSPORT' }] });
    expect(evaluateCard([person({ documents: { CNIC_OR_PASSPORT: { state: 'NOT_AVAILABLE' } } })]).people[0]!.status).toBe('MISSING');
  });
  it('every adult needs an identity document of their own (couples, corporate, groups); a child needs the guardian instead', () => {
    const seen = { CNIC_OR_PASSPORT: { state: 'SEEN' as const } };
    const r = evaluateCard([person({ documents: seen }), person({ name: 'Wife', documents: seen, hasId: false })]);
    expect(r.people[1]!.missing).toContainEqual({ kind: 'ID', key: 'ID' });
    const kid = evaluateCard([person({ name: 'Kid', ageGroup: 'CHILD', guestType: 'PAKISTANI_MINOR', hasId: false, documents: { MINOR_ID: { state: 'SEEN' } }, hasGuardian: false })]);
    expect(kid.people[0]!.missing).toEqual([{ kind: 'GUARDIAN', key: 'GUARDIAN_ID' }]);
    expect(evaluateCard([person({ name: 'Kid', ageGroup: 'CHILD', guestType: 'PAKISTANI_MINOR', hasId: false, documents: { MINOR_ID: { state: 'SEEN' } }, hasGuardian: true })]).complete).toBe(true);
  });
  it('a foreign adult needs the foreign-guest record: issue place, visa, stay expiry, entry date and port, local address, next destination, passport expiry', () => {
    const docs = { FOREIGN_PASSPORT: { state: 'SEEN' as const }, PASSPORT_BIO_COPY: { state: 'SEEN' as const }, VISA_BASIS: { state: 'SEEN' as const }, ENTRY_STAMP: { state: 'SEEN' as const } };
    const r = evaluateCard([person({ guestType: 'FOREIGN_ADULT', documents: docs })]);
    expect(r.people[0]!.missing.map((m) => m.key)).toEqual(['passportIssuePlace', 'visaType', 'stayExpiry', 'entryDate', 'entryPort', 'localAddress', 'nextDestination', 'passportExpiry']);
    const full = evaluateCard([person({ guestType: 'FOREIGN_ADULT', documents: docs, idExpiry: '2030-01-01', foreign: { passportIssuePlace: 'London', visaType: 'eVisa', stayExpiry: '2026-12-01', entryDate: '2026-10-30', entryPort: 'Karachi airport', localAddress: 'Sunset BnB', nextDestination: 'Lahore' } })]);
    expect(full.complete).toBe(true);
  });
});
