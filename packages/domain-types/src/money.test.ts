import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, Money } from './money.js';

const pkr = (s: string) => Money.parse(s, 'PKR');

describe('Money', () => {
  it('parses and formats exactly', () => {
    expect(pkr('12500.50').minor).toBe(1250050n);
    expect(pkr('0.05').toDecimalString()).toBe('0.05');
    expect(pkr('-3.07').toDecimalString()).toBe('-3.07');
    expect(Money.parse('100', 'JPY').toDecimalString()).toBe('100');
    expect(Money.parse('1.234', 'KWD').minor).toBe(1234n);
    expect(() => pkr('1.234')).toThrow(/decimal places/);
    expect(() => pkr('abc')).toThrow();
  });
  it('has no floating-point drift (0.1 + 0.2)', () => {
    expect(pkr('0.10').add(pkr('0.20')).equals(pkr('0.30'))).toBe(true);
  });
  it('rejects cross-currency arithmetic', () => {
    expect(() => pkr('1').add(Money.parse('1', 'USD'))).toThrow(CurrencyMismatchError);
  });
  it('computes tax in basis points with explicit rounding (illustrative 15% / 8% fixture from the brief)', () => {
    // Model A: 15,000 @ 15% = 2,250
    expect(pkr('15000').percentBp(1500).toDecimalString()).toBe('2250.00');
    // Model B: room 11,000@15% + breakfast 2,000@8% + dinner 1,500@8% + laundry 500@15% = 2,005
    const tax = pkr('11000').percentBp(1500).add(pkr('2000').percentBp(800)).add(pkr('1500').percentBp(800)).add(pkr('500').percentBp(1500));
    expect(tax.toDecimalString()).toBe('2005.00');
  });
  it('rounding modes behave on exact halves', () => {
    const m = Money.ofMinor(5n, 'PKR'); // 0.05 * 1/2 -> 2.5 minor
    expect(m.mulRatio(1n, 2n, 'HALF_UP').minor).toBe(3n);
    expect(m.mulRatio(1n, 2n, 'HALF_EVEN').minor).toBe(2n);
    expect(Money.ofMinor(7n, 'PKR').mulRatio(1n, 2n, 'HALF_EVEN').minor).toBe(4n);
    expect(m.mulRatio(1n, 2n, 'DOWN').minor).toBe(2n);
    expect(m.mulRatio(1n, 2n, 'UP').minor).toBe(3n);
    expect(Money.ofMinor(-5n, 'PKR').mulRatio(1n, 2n, 'HALF_UP').minor).toBe(-3n);
  });
  it('allocate always sums exactly to the original (largest remainder)', () => {
    const parts = pkr('100.00').allocate([1, 1, 1]);
    expect(parts.map((p) => p.toDecimalString())).toEqual(['33.34', '33.33', '33.33']);
    expect(parts.reduce((a, b) => a.add(b), Money.zero('PKR')).toDecimalString()).toBe('100.00');
    // package allocation 15,000 by standalone prices 11000:2000:1500:500
    const split = pkr('15000').allocate([11000, 2000, 1500, 500]);
    expect(split.map((p) => p.toDecimalString())).toEqual(['11000.00', '2000.00', '1500.00', '500.00']);
  });
  it('allocate handles negatives and zero weights', () => {
    const parts = pkr('-10.00').allocate([1, 0, 2]);
    expect(parts.reduce((a, b) => a.add(b), Money.zero('PKR')).toDecimalString()).toBe('-10.00');
    expect(parts[1]!.isZero()).toBe(true);
    expect(() => pkr('1').allocate([0, 0])).toThrow();
  });
  it('allocation property: sum preserved for many random inputs', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 500; i++) {
      const total = Money.ofMinor(BigInt(rnd() % 10_000_000) - 5_000_000n, 'PKR');
      const n = 1 + (rnd() % 7);
      const weights = Array.from({ length: n }, () => rnd() % 1000);
      if (weights.every((w) => w === 0)) continue;
      const sum = total.allocate(weights).reduce((a, b) => a.add(b), Money.zero('PKR'));
      expect(sum.equals(total)).toBe(true);
    }
  });
});
