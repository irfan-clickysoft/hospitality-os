import { describe, expect, it } from 'vitest';
import { allocateDiscounts, depositOf, discountOf, groupNights, splitByWeight } from '../src/quotations/pricing.js';

const none = { kind: 'NONE' as const, value: 0n };
describe('quotation arithmetic', () => {
  it('splits an amount so the parts always add up to it', () => {
    expect(splitByWeight(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(splitByWeight(5n, [3n, 1n])).toEqual([4n, 1n]);
    expect(splitByWeight(0n, [1n, 2n])).toEqual([0n, 0n]);
    expect(splitByWeight(7n, [0n, 0n])).toEqual([4n, 3n]);
    for (const [t, w] of [[1_000_001n, [5n, 7n, 11n, 13n]], [999n, [1n, 1n]]] as const) expect(splitByWeight(t, [...w]).reduce((a, b) => a + b, 0n)).toBe(t);
  });
  it('takes a percentage or an amount off, never more than the price', () => {
    expect(discountOf(7_000_000n, { kind: 'PCT', value: 1250n })).toBe(875_000n);            // 12.5% of 70,000.00
    expect(discountOf(7_000_000n, { kind: 'AMOUNT', value: 500_000n })).toBe(500_000n);
    expect(discountOf(100n, { kind: 'AMOUNT', value: 500n })).toBe(100n);
    expect(discountOf(100n, { kind: 'PCT', value: 20000n })).toBe(100n);
    expect(discountOf(100n, none)).toBe(0n);
  });
  it('applies line discounts, then the overall one shared by what each line is worth, and gives every room a whole amount', () => {
    // line 1: 3 rooms x 105,000.00 (7 nights x 15,000), 10% off; line 2: 1 room x 245,000.00 (7 x 35,000), 5,000.00 off
    const out = allocateDiscounts([
      { gross: 10_500_000n, rooms: 3, discount: { kind: 'PCT', value: 1000n } },
      { gross: 24_500_000n, rooms: 1, discount: { kind: 'AMOUNT', value: 500_000n } },
    ], { kind: 'AMOUNT', value: 1_000_000n });
    expect(out[0]!.lineDiscount).toBe(3_150_000n); expect(out[1]!.lineDiscount).toBe(500_000n);
    const afterLine = [31_500_000n - 3_150_000n, 24_500_000n - 500_000n];                        // 28,350,000 and 24,000,000
    expect(out[0]!.overallShare + out[1]!.overallShare).toBe(1_000_000n);
    expect(out[0]!.overallShare).toBe((1_000_000n * afterLine[0]!) / (afterLine[0]! + afterLine[1]!));
    expect(out[0]!.roomDiscounts).toHaveLength(3); expect(out[0]!.roomDiscounts.reduce((a, b) => a + b, 0n)).toBe(out[0]!.lineDiscount + out[0]!.overallShare);
    expect(out[1]!.roomDiscounts).toEqual([500_000n + out[1]!.overallShare]);
  });
  it('a quotation with no discount takes nothing off', () => {
    const out = allocateDiscounts([{ gross: 1_500_000n, rooms: 2, discount: none }], none);
    expect(out[0]).toEqual({ lineDiscount: 0n, overallShare: 0n, roomDiscounts: [0n, 0n] });
  });
  it('groups consecutive nights at one price, so a season shows as its own band', () => {
    const n = (date: string, total: bigint, source = 'BASE') => ({ date, total, source });
    const g = groupNights([n('2026-12-01', 1_500_000n), n('2026-12-02', 1_500_000n), n('2026-12-03', 3_500_000n, 'SEASON:Peak'), n('2026-12-04', 3_500_000n, 'SEASON:Peak'), n('2026-12-05', 3_500_000n, 'SEASON:Peak'), n('2026-12-06', 1_500_000n)]);
    expect(g).toEqual([{ from: '2026-12-01', to: '2026-12-02', nights: 2, rate: 1_500_000n, source: 'BASE' }, { from: '2026-12-03', to: '2026-12-05', nights: 3, rate: 3_500_000n, source: 'SEASON:Peak' }, { from: '2026-12-06', to: '2026-12-06', nights: 1, rate: 1_500_000n, source: 'BASE' }]);
  });
  it('asks for an advance as a share of the total or a fixed amount, up to the total', () => {
    expect(depositOf(10_000_000n, { kind: 'PCT', value: 3000n })).toBe(3_000_000n);
    expect(depositOf(10_000_000n, { kind: 'AMOUNT', value: 2_500_000n })).toBe(2_500_000n);
    expect(depositOf(10_000_000n, { kind: 'AMOUNT', value: 99_000_000n })).toBe(10_000_000n);
    expect(depositOf(10_000_000n, none)).toBe(0n);
  });
});
