import { describe, expect, it } from 'vitest';
import { checkOccupant, formatId, idNumberError, type Occupant } from './occupants.js';

const adult = (p: Partial<Occupant> = {}): Occupant => ({ fullName: 'Ali Raza', idType: 'CNIC', idNumber: '35202-1234567-1', nationality: 'PK', idExpiry: '', ageGroup: 'ADULT', ...p });
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
    expect(checkOccupant({ fullName: 'Sara', idType: 'CNIC', idNumber: '', nationality: '', idExpiry: '', ageGroup: 'CHILD' }, 2, false, BD)).toEqual({});
  });
  it('still checks an ID that is given, for anyone', () => {
    expect(checkOccupant(adult({ idNumber: '123' }), 1, false, BD).idNumber).toBe('ci.e.cnic');
    expect(checkOccupant(adult({ idType: 'PASSPORT', idNumber: 'AB123456', idExpiry: '2026-01-01' }), 1, true, BD).idExpiry).toBe('ci.e.expired');
  });
  it('requires a foreign main guest to use a passport', () => {
    expect(checkOccupant(adult(), 0, true, BD).idType).toBe('ci.e.passportOnly');
  });
});
