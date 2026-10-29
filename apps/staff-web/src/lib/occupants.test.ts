import { describe, expect, it } from 'vitest';
import { checkOccupant, formatId, gapsFor, idNumberError, parseRoster, suggestType, type Matrix, type Occupant } from './occupants.js';

const adult = (p: Partial<Occupant> = {}): Occupant => ({ fullName: 'Ali Raza', idType: 'CNIC', idNumber: '35202-1234567-1', nationality: 'PK', idExpiry: '', ageGroup: 'ADULT', guestType: '', docs: {}, foreign: {}, guardian: null, relationship: '', ...p });
const BD = '2026-11-05';

describe('ID numbers are checked as the person leaves the field', () => {
  it('accepts a CNIC with or without dashes and prints it the standard way', () => {
    expect(idNumberError('CNIC', '3520212345671')).toBeNull(); expect(idNumberError('CNIC', '35202-1234567-1')).toBeNull(); expect(idNumberError('CNIC', '35202 1234567 1')).toBeNull();
    expect(formatId('CNIC', '3520212345671')).toBe('35202-1234567-1');
  });
  it('says what is wrong, not just that something is', () => {
    expect(idNumberError('CNIC', '3520212345')).toBe('ci.e.cnic');
    expect(idNumberError('PASSPORT', 'AB1')).toBe('ci.e.passport'); expect(idNumberError('PASSPORT', 'ab 123456')).toBeNull(); expect(formatId('PASSPORT', 'ab 123456')).toBe('AB123456');
    expect(idNumberError('DRIVING_LICENSE', '1')).toBe('ci.e.otherId');
  });
});

describe('who must have an ID', () => {
  it('requires it for the main guest only', () => {
    expect(checkOccupant(adult({ idNumber: '' }), 0, false, BD).idNumber).toBe('ci.e.idNumber');
    expect(checkOccupant(adult({ idNumber: '' }), 1, false, BD)).toEqual({});                                  // a family member covered by the main guest's ID
  });
  it('lets a child have none, and nothing else about the child is demanded', () => {
    expect(checkOccupant(adult({ fullName: 'Sara', idNumber: '', nationality: '', ageGroup: 'CHILD' }), 2, false, BD)).toEqual({});
  });
  it('still checks an ID that is given, for anyone', () => {
    expect(checkOccupant(adult({ idNumber: '123' }), 1, false, BD).idNumber).toBe('ci.e.cnic');
    expect(checkOccupant(adult({ idType: 'PASSPORT', idNumber: 'AB123456', idExpiry: '2026-01-01' }), 1, true, BD).idExpiry).toBe('ci.e.expired');
  });
  it('requires a foreign main guest to use a passport', () => {
    expect(checkOccupant(adult(), 0, true, BD).idType).toBe('ci.e.passportOnly');
  });
});


const matrix: Matrix = { strict: false, nicopAloneOk: false, foreignDetailKeys: [], types: [
  { type: 'PAKISTANI_ADULT', minor: false, foreignDetails: false, requirements: [{ key: 'CNIC_OR_PASSPORT', required: true, supplementary: false }], requirementsCorporate: [{ key: 'CNIC_OR_PASSPORT', required: true, supplementary: false }, { key: 'COMPANY_LETTER', required: false, supplementary: true }] },
  { type: 'PAKISTANI_MINOR', minor: true, foreignDetails: false, requirements: [{ key: 'MINOR_ID', required: true, supplementary: false }, { key: 'GUARDIAN_ID', required: true, supplementary: false }], requirementsCorporate: [] },
  { type: 'FOREIGN_ADULT', minor: false, foreignDetails: true, requirements: [{ key: 'FOREIGN_PASSPORT', required: true, supplementary: false }], requirementsCorporate: [] },
] };
describe('the document matrix on the card', () => {
  it('suggests the kind of guest from the card', () => {
    expect(suggestType({ nationality: 'PK', ageGroup: 'ADULT', idType: 'CNIC' })).toBe('PAKISTANI_ADULT'); expect(suggestType({ nationality: 'PK', ageGroup: 'ADULT', idType: 'NICOP' })).toBe('OVERSEAS_PAKISTANI');
    expect(suggestType({ nationality: 'GB', ageGroup: 'ADULT', idType: 'PASSPORT' })).toBe('FOREIGN_ADULT'); expect(suggestType({ nationality: '', ageGroup: 'CHILD', idType: 'CNIC' })).toBe('PAKISTANI_MINOR');
  });
  it('names what is missing, and a recorded reason counts as an exception, not a gap', () => {
    const a = adult();
    expect(gapsFor(a, 0, [a], matrix)).toEqual([{ kind: 'DOCUMENT', key: 'CNIC_OR_PASSPORT' }]);
    expect(gapsFor(adult({ docs: { CNIC_OR_PASSPORT: { state: 'SEEN' } } }), 0, [a], matrix)).toEqual([]);
    expect(gapsFor(adult({ docs: { CNIC_OR_PASSPORT: { state: 'NOT_AVAILABLE', note: 'Lost, FIR shown' } } }), 0, [a], matrix)).toEqual([]);
    expect(gapsFor(adult({ docs: { CNIC_OR_PASSPORT: { state: 'NOT_AVAILABLE' } } }), 0, [a], matrix)).toHaveLength(1);
  });
  it('a child needs a linked adult who has an ID; an adult without an ID is flagged', () => {
    const parent = adult({ docs: { CNIC_OR_PASSPORT: { state: 'SEEN' } } });
    const kid = adult({ ageGroup: 'CHILD', idNumber: '', docs: { MINOR_ID: { state: 'SEEN' } } });
    expect(gapsFor(kid, 1, [parent, kid], matrix)).toEqual([{ kind: 'GUARDIAN', key: 'GUARDIAN_ID' }]);
    expect(gapsFor({ ...kid, guardian: 0 }, 1, [parent, { ...kid, guardian: 0 }], matrix)).toEqual([]);
    expect(gapsFor(adult({ idNumber: '', docs: { CNIC_OR_PASSPORT: { state: 'SEEN' } } }), 1, [parent], matrix)).toEqual([{ kind: 'ID', key: 'ID' }]);
  });
  it('a foreign guest needs the foreign-guest record', () => {
    const f = adult({ nationality: 'GB', idType: 'PASSPORT', docs: { FOREIGN_PASSPORT: { state: 'SEEN' } } });
    expect(gapsFor(f, 0, [f], matrix).map((g) => g.key)).toEqual(['passportIssuePlace', 'visaType', 'stayExpiry', 'entryDate', 'entryPort', 'localAddress', 'nextDestination', 'passportExpiry']);
    const done = { ...f, idExpiry: '2031-01-01', foreign: { passportIssuePlace: 'London', visaType: 'eVisa', stayExpiry: '2026-12-01', entryDate: '2026-11-01', entryPort: 'KHI', localAddress: 'Hotel', nextDestination: 'Lahore' } };
    expect(gapsFor(done, 0, [done], matrix)).toEqual([]);
  });
});

describe('parseRoster', () => {
  it('reads one person per line: CNIC, passport, child, country', () => {
    const r = parseRoster('Ali Raza, 3520212345671\nSara Raza, child\nJohn Smith; GB; 123456789\n\n12345678901, x\nA');
    expect(r.people.map((p) => [p.fullName, p.idType, p.idNumber, p.nationality, p.ageGroup])).toEqual([
      ['Ali Raza', 'CNIC', '35202-1234567-1', 'PK', 'ADULT'], ['Sara Raza', 'CNIC', '', 'PK', 'CHILD'], ['John Smith', 'PASSPORT', '123456789', 'GB', 'ADULT']]);
    expect(r.skipped).toEqual(['12345678901, x', 'A']);
  });
});
