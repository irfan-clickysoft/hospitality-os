import { describe, expect, it } from 'vitest';
import { groupIban, ibanValid, swiftValid } from './iban.js';

describe('bank number checks', () => {
  it('accepts a correct IBAN in any spacing and case, and refuses a mistyped one', () => {
    expect(ibanValid('PK36SCBL0000001123456702')).toBe(true); expect(ibanValid('pk36 scbl 0000 0011 2345 6702')).toBe(true);
    expect(ibanValid('PK36SCBL0000001123456703')).toBe(false); expect(ibanValid('PK36')).toBe(false); expect(ibanValid('GB82WEST12345698765432')).toBe(true);
  });
  it('prints an IBAN in groups of four', () => { expect(groupIban('pk36scbl0000001123456702')).toBe('PK36 SCBL 0000 0011 2345 6702'); });
  it('knows a SWIFT code', () => { expect(swiftValid('scblpkka')).toBe(true); expect(swiftValid('SCBLPKKAXXX')).toBe(true); expect(swiftValid('ABC')).toBe(false); });
});
