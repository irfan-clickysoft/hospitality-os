/** The arithmetic of a quotation, kept apart from the database so it can be tested on its own. Everything is in minor units (paisa); nothing is ever rounded by a float. */

export type DiscountKind = 'NONE' | 'PCT' | 'AMOUNT';
export interface Discount { kind: DiscountKind; value: bigint }          // PCT: hundredths of a percent (1250 = 12.5%); AMOUNT: minor units

/** Splits `total` over the weights so the parts add up to exactly `total` (largest remainder first, earlier parts on ties). */
export function splitByWeight(total: bigint, weights: bigint[]): bigint[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (total <= 0n) return weights.map(() => 0n);
  if (sum === 0n) return splitByWeight(total, weights.map(() => 1n));
  const base = weights.map((w) => (total * w) / sum);
  let left = total - base.reduce((a, b) => a + b, 0n);
  const order = weights.map((w, k) => ({ k, r: (total * w) % sum })).sort((x, y) => (x.r === y.r ? x.k - y.k : x.r > y.r ? -1 : 1));
  for (const { k } of order) { if (left <= 0n) break; base[k]! += 1n; left -= 1n; }
  return base;
}

/** What a discount takes off a gross figure (never more than the figure). */
export function discountOf(gross: bigint, d: Discount): bigint {
  if (d.kind === 'PCT') return gross <= 0n ? 0n : (gross * (d.value > 10000n ? 10000n : d.value)) / 10000n;
  if (d.kind === 'AMOUNT') return d.value > gross ? gross : d.value;
  return 0n;
}

export interface LineIn { gross: bigint; rooms: number; discount: Discount }       // gross = the price of the stay for ONE room, before any discount
export interface LineOut { lineDiscount: bigint; overallShare: bigint; roomDiscounts: bigint[] }

/**
 * Line discounts first (a percentage of the line, or an amount for the whole line), then the discount on the whole quotation shared over the lines in proportion to what each line is
 * worth after its own discount. Each line's total cut is then shared over its rooms, so every room carries a whole number of paisa and the rooms add up to the line.
 */
export function allocateDiscounts(lines: LineIn[], overall: Discount): LineOut[] {
  const lineGross = lines.map((l) => l.gross * BigInt(l.rooms));
  const lineCut = lines.map((l, k) => discountOf(lineGross[k]!, l.discount));
  const afterLine = lineGross.map((g, k) => g - lineCut[k]!);
  const overallTotal = discountOf(afterLine.reduce((a, b) => a + b, 0n), overall);
  const shares = splitByWeight(overallTotal, afterLine);
  return lines.map((l, k) => ({ lineDiscount: lineCut[k]!, overallShare: shares[k]!, roomDiscounts: splitByWeight(lineCut[k]! + shares[k]!, Array.from({ length: l.rooms }, () => 1n)) }));
}

export interface Night { date: string; total: bigint; source: string }
export interface RateGroup { from: string; to: string; nights: number; rate: bigint; source: string }
/** Consecutive nights at the same price and source, so a 12-night stay across a season reads "4 nights at 15,000 then 8 nights at 35,000". `to` is the last night. */
export function groupNights(nights: Night[]): RateGroup[] {
  const out: RateGroup[] = [];
  for (const n of nights) {
    const last = out[out.length - 1];
    if (last && last.rate === n.total && last.source === n.source) { last.to = n.date; last.nights += 1; } else out.push({ from: n.date, to: n.date, nights: 1, rate: n.total, source: n.source });
  }
  return out;
}

/** The advance asked for: a percentage of the total (with tax), or a fixed amount, never more than the total. */
export function depositOf(total: bigint, d: Discount): bigint { return discountOf(total, d); }
