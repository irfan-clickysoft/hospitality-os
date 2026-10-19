import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode } from '../src/identity/base32.js';
import { TotpService } from '../src/identity/totp.service.js';
import { SecretBox } from '../src/common/secret-box.js';
import { parseToken, newToken } from '../src/identity/tokens.js';
import { PasswordService } from '../src/identity/password.service.js';

const totp = new TotpService();
const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238 vectors, SHA-1, last 6 digits of the published 8-digit values)', () => {
  it.each([[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']])(
    'T=%i -> %s', (t, code) => { expect(totp.codeAtStep(rfcSecret, Math.floor(t / 30))).toBe(code); });
  it('accepts ±1 step and rejects further drift or malformed input', () => {
    const now = 1_700_000_000_000; const step = Math.floor(now / 30000);
    expect(totp.check(rfcSecret, totp.codeAtStep(rfcSecret, step), now)).toBe(step);
    expect(totp.check(rfcSecret, totp.codeAtStep(rfcSecret, step - 1), now)).toBe(step - 1);
    expect(totp.check(rfcSecret, totp.codeAtStep(rfcSecret, step + 3), now)).toBeNull();
    expect(totp.check(rfcSecret, '12345', now)).toBeNull();
    expect(totp.check(rfcSecret, 'abcdef', now)).toBeNull();
  });
  it('generates distinct base32 secrets and a standard otpauth URI', () => {
    const a = totp.generateSecret(), b = totp.generateSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(totp.uri('a@b.test', 'Hospitality OS', a)).toMatch(/^otpauth:\/\/totp\/Hospitality%20OS:a%40b\.test\?secret=/);
  });
});

describe('base32 (RFC 4648 vectors)', () => {
  it.each([['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']])(
    '%j <-> %s', (plain, enc) => { expect(base32Encode(Buffer.from(plain))).toBe(enc); expect(base32Decode(enc).toString()).toBe(plain); });
  it('tolerates padding and lowercase, rejects garbage', () => {
    expect(base32Decode('mzxw6===').toString()).toBe('foo');
    expect(() => base32Decode('MZ1W6')).toThrow();
  });
});

describe('SecretBox', () => {
  const box = new SecretBox(Buffer.alloc(32, 7).toString('base64'));
  it('round-trips and uses a fresh IV each time', () => {
    const s1 = box.seal('JBSWY3DPEHPK3PXP'), s2 = box.seal('JBSWY3DPEHPK3PXP');
    expect(s1).not.toBe(s2);
    expect(box.open(s1)).toBe('JBSWY3DPEHPK3PXP');
  });
  it('binds ciphertext to its context (AAD) and detects tampering', () => {
    const s = box.seal('secret', 'tenant:user');
    expect(() => box.open(s, 'tenant:other')).toThrow();
    const parts = s.split(':'); parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.open(parts.join(':'), 'tenant:user')).toThrow();
  });
  it('rejects bad keys', () => { expect(() => new SecretBox('c2hvcnQ=')).toThrow(/32 bytes/); });
});

describe('tokens', () => {
  it('round-trips tenant prefix and hashes deterministically; rejects malformed tokens', () => {
    const tenant = '11111111-2222-4333-8444-555555555555';
    const { token, hash } = newToken(tenant);
    const p = parseToken(token)!;
    expect(p.tenantId).toBe(tenant);
    expect(p.hash.equals(hash)).toBe(true);
    for (const bad of [undefined, '', 'abc', `${tenant}.short`, `not-a-uuid-not-a-uuid-not-a-uuid-xxxx.${'a'.repeat(50)}`, 'x'.repeat(500)]) expect(parseToken(bad as string)).toBeNull();
  });
});

describe('PasswordService', () => {
  const pw = new PasswordService();
  it('hashes with argon2id and verifies', async () => {
    const h = await pw.hash('correct horse battery staple');
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await pw.verify(h, 'correct horse battery staple')).toBe(true);
    expect(await pw.verify(h, 'wrong')).toBe(false);
    expect(await pw.verify('garbage', 'x')).toBe(false);
  });
  it('enforces a length-first policy', () => {
    expect(pw.violations('short')).toContain('Use at least 12 characters');
    expect(pw.violations('sunset123456')).toContain('This password is too common');
    expect(pw.violations('maria.khan-pass-1', { email: 'maria.khan@x.test' }).join()).toMatch(/email name/);
    expect(pw.violations('a correct horse battery')).toEqual([]);
  });
});
