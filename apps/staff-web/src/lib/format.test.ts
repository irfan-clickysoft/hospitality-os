import { describe, expect, it } from 'vitest';
import { addDays, dayRange, isNegative, isZero, money, nightsBetween, whatsappNumber } from './format.js';
import { policyLines } from '../desk/policy.js';
import { translate } from '../i18n/index.js';

describe('dates', () => {
  it('moves plain calendar days without touching time zones, across month and year ends', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01'); expect(addDays('2026-12-31', 1)).toBe('2027-01-01'); expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); expect(addDays('2026-11-05', -7)).toBe('2026-10-29');
    expect(nightsBetween('2026-11-05', '2026-11-08')).toBe(3);
    expect(dayRange('2026-11-29', 3)).toEqual(['2026-11-29', '2026-11-30', '2026-12-01']);
  });
});
describe('money display', () => {
  it('shows whole rupees without paisa, keeps paisa when there are some, groups thousands, marks negatives', () => {
    expect(money({ amount: '12000.00', currency: 'PKR' })).toBe('PKR 12,000'); expect(money('1234567.50')).toBe('PKR 1,234,567.50'); expect(money({ amount: '-6000.00', currency: 'PKR' })).toBe('−PKR 6,000'); expect(money('0.00')).toBe('PKR 0');
    expect(isZero({ amount: '0.00' })).toBe(true); expect(isZero({ amount: '-0.00' })).toBe(true); expect(isNegative({ amount: '-5.00' })).toBe(true); expect(isNegative({ amount: '5.00' })).toBe(false);
  });
});
describe('WhatsApp numbers', () => {
  it('turns Pakistani numbers in any common format into the international form wa.me needs, and refuses nonsense', () => {
    expect(whatsappNumber('0300 1234567')).toBe('923001234567'); expect(whatsappNumber('+92 300 1234567')).toBe('923001234567'); expect(whatsappNumber('0092-300-1234567')).toBeNull(); expect(whatsappNumber('923001234567')).toBe('923001234567');
    expect(whatsappNumber('+44 7700 900123')).toBe('447700900123'); expect(whatsappNumber('12')).toBeNull(); expect(whatsappNumber(null)).toBeNull();
  });
});
describe('cancellation policy sentences', () => {
  const t = (l: 'en' | 'ur') => (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(l, k, v);
  const policy = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'PERCENT', feeValue: 5000 }, depositRule: { type: 'FIXED', value: 500000 } };
  it('says each rule in plain words, in both languages', () => {
    expect(policyLines(t('en'), policy)).toEqual(['Free cancellation until 72 hours before arrival; after that 1 night(s).', 'No-show: 50%.', 'Deposit to guarantee: PKR 5,000.']);
    expect(policyLines(t('ur'), policy)[0]).toContain('72');
    expect(policyLines(t('en'), undefined)).toEqual([]);
  });
});
