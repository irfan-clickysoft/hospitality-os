import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../src/guests/phone.js';

describe('normalizePhone', () => {
  it.each([
    ['0300-1234567', '923001234567'], ['03001234567', '923001234567'], ['+92 300 1234567', '923001234567'], ['0092 300 1234567', '923001234567'],
    ['(+92) 300-123-4567', '923001234567'], ['92 300 1234567', '923001234567'], ['+44 7700 900123', '447700900123'],
  ])('%s → %s', (raw, want) => { expect(normalizePhone(raw)).toBe(want); });
  it('rejects junk and empty values', () => { for (const bad of [null, undefined, '', 'abc', '123', '1'.repeat(20)]) expect(normalizePhone(bad as string)).toBeNull(); });
});
