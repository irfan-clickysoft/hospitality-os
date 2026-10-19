import { describe, expect, it } from 'vitest';
import { computeTax, taxAs, taxOn, type TaxVersionRule } from './engine.js';

// Fictional test rates — the product ships with none. They exist only to prove the arithmetic.
const v = (o: Partial<TaxVersionRule> & { id: string; code: string; rateBp: number }): TaxVersionRule => ({ appliesTo: ['ROOM', 'ROOM_EXTRAS'], residency: null, effectiveFrom: '2026-01-01', effectiveTo: null, ...o });
const ctx = { txnCode: 'ROOM', date: '2026-11-05', residency: 'RESIDENT' as const };

describe('tax arithmetic', () => {
  it('rounds half away from zero at the paisa', () => {
    expect(taxOn(1000n, 1250)).toBe(125n); expect(taxOn(1n, 5000)).toBe(1n); expect(taxOn(1n, 4999)).toBe(0n); expect(taxOn(333n, 1000)).toBe(33n); expect(taxOn(335n, 1000)).toBe(34n);
  });
  it('is symmetric: a charge and an equal discount cancel exactly, whatever the rounding', () => {
    for (const net of [1n, 333n, 335n, 1234567n, 99999n]) for (const bp of [1, 250, 1250, 1600, 4999]) expect(taxOn(net, bp) + taxOn(-net, bp)).toBe(0n);
  });
  it('applies every matching version and records the taxable value, even at a zero rate', () => {
    const lines = computeTax([v({ id: 'a', code: 'ACCOM', rateBp: 1000 }), v({ id: 'b', code: 'LEVY', rateBp: 200 }), v({ id: 'z', code: 'ZERO', rateBp: 0 })], ctx, 1500000n);
    expect(lines.map((l) => [l.code, l.taxMinor, l.taxableMinor])).toEqual([['ACCOM', 150000n, 1500000n], ['LEVY', 30000n, 1500000n], ['ZERO', 0n, 1500000n]]);
  });
  it('respects transaction codes, effective dates (both ends included), residency and nothing-to-tax', () => {
    const rule = v({ id: 'a', code: 'ACCOM', rateBp: 1000, effectiveFrom: '2026-11-05', effectiveTo: '2026-11-30', residency: 'NON_RESIDENT' });
    expect(computeTax([rule], { ...ctx, residency: 'NON_RESIDENT' }, 100n)).toHaveLength(1);
    expect(computeTax([rule], ctx, 100n)).toHaveLength(0);                                                  // residents are not in scope of this version
    expect(computeTax([rule], { ...ctx, residency: 'NON_RESIDENT', date: '2026-11-04' }, 100n)).toHaveLength(0);
    expect(computeTax([rule], { ...ctx, residency: 'NON_RESIDENT', date: '2026-11-30' }, 100n)).toHaveLength(1);
    expect(computeTax([rule], { ...ctx, residency: 'NON_RESIDENT', date: '2026-12-01' }, 100n)).toHaveLength(0);
    expect(computeTax([rule], { ...ctx, residency: 'NON_RESIDENT', txnCode: 'FNB' }, 100n)).toHaveLength(0);
    expect(computeTax([v({ id: 'a', code: 'A', rateBp: 1000 })], ctx, 0n)).toEqual([]);
  });
  it('taxes a room discount as room', () => { expect(taxAs('ROOM_DISCOUNT')).toBe('ROOM'); expect(taxAs('FNB')).toBe('FNB'); });
});
