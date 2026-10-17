/** Currency exponents (minor-unit digits). Extend via reference data; PKR=2. */
const EXPONENT: Record<string, number> = { PKR: 2, USD: 2, EUR: 2, GBP: 2, AED: 2, SAR: 2, JPY: 0, KWD: 3, BHD: 3 };

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

export class CurrencyMismatchError extends Error {}

/** Immutable money value: integer minor units (bigint) + ISO-4217 currency. No floating point anywhere. */
export class Money {
  private constructor(readonly minor: bigint, readonly currency: string) {}

  static ofMinor(minor: bigint | number, currency: string): Money {
    if (typeof minor === 'number' && !Number.isSafeInteger(minor)) throw new RangeError('minor must be a safe integer');
    if (!(currency in EXPONENT)) throw new RangeError(`Unsupported currency ${currency}`);
    return new Money(BigInt(minor), currency);
  }

  /** Parse a decimal string like "12500.50" exactly (rejects more fraction digits than the currency allows). */
  static parse(amount: string, currency: string): Money {
    const exp = Money.exponent(currency);
    const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(amount.trim());
    if (!m) throw new RangeError(`Invalid amount "${amount}"`);
    const frac = m[3] ?? '';
    if (frac.length > exp) throw new RangeError(`Too many decimal places for ${currency}`);
    const minor = BigInt(m[2]! + frac.padEnd(exp, '0'));
    return new Money(m[1] ? -minor : minor, currency);
  }

  static zero(currency: string): Money { return Money.ofMinor(0n, currency); }
  static exponent(currency: string): number {
    const e = EXPONENT[currency];
    if (e === undefined) throw new RangeError(`Unsupported currency ${currency}`);
    return e;
  }

  add(o: Money): Money { this.same(o); return new Money(this.minor + o.minor, this.currency); }
  sub(o: Money): Money { this.same(o); return new Money(this.minor - o.minor, this.currency); }
  negate(): Money { return new Money(-this.minor, this.currency); }
  isZero(): boolean { return this.minor === 0n; }
  isNegative(): boolean { return this.minor < 0n; }
  equals(o: Money): boolean { return this.currency === o.currency && this.minor === o.minor; }
  compare(o: Money): -1 | 0 | 1 { this.same(o); return this.minor === o.minor ? 0 : this.minor < o.minor ? -1 : 1; }

  /** Multiply by a rational factor num/den (e.g., tax in basis points = bp/10000) with explicit rounding. */
  mulRatio(num: bigint, den: bigint, mode: RoundingMode = 'HALF_UP'): Money {
    if (den === 0n) throw new RangeError('division by zero');
    return new Money(divRound(this.minor * num, den, mode), this.currency);
  }

  /** Percentage in basis points (1500 = 15.00%). */
  percentBp(bp: bigint | number, mode: RoundingMode = 'HALF_UP'): Money { return this.mulRatio(BigInt(bp), 10000n, mode); }

  /** Split into parts proportional to `weights` so the parts always sum exactly to this amount (largest remainder). */
  allocate(weights: Array<bigint | number>): Money[] {
    const w = weights.map(BigInt);
    const total = w.reduce((a, b) => a + b, 0n);
    if (w.length === 0 || total <= 0n || w.some((x) => x < 0n)) throw new RangeError('weights must be non-negative with a positive sum');
    const sign = this.minor < 0n ? -1n : 1n;
    const abs = this.minor * sign;
    const base = w.map((x) => (abs * x) / total);
    let rest = abs - base.reduce((a, b) => a + b, 0n);
    const order = w.map((x, i) => ({ i, r: (abs * x) % total })).sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
    for (const { i } of order) { if (rest === 0n) break; base[i]! += 1n; rest -= 1n; }
    return base.map((b) => new Money(b * sign, this.currency));
  }

  toDecimalString(): string {
    const exp = Money.exponent(this.currency);
    const neg = this.minor < 0n;
    const s = (neg ? -this.minor : this.minor).toString().padStart(exp + 1, '0');
    const body = exp === 0 ? s : `${s.slice(0, -exp)}.${s.slice(-exp)}`;
    return neg ? `-${body}` : body;
  }
  toJSON(): { amount: string; currency: string } { return { amount: this.toDecimalString(), currency: this.currency }; }

  private same(o: Money): void { if (o.currency !== this.currency) throw new CurrencyMismatchError(`${this.currency} vs ${o.currency}`); }
}

function divRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  if (d < 0n) { n = -n; d = -d; }
  const q = n / d; // truncates toward zero
  const r = n % d;
  if (r === 0n) return q;
  const neg = n < 0n;
  const away = neg ? q - 1n : q + 1n;
  const twice = (r < 0n ? -r : r) * 2n;
  switch (mode) {
    case 'DOWN': return q;
    case 'UP': return away;
    case 'HALF_UP': return twice >= d ? away : q;
    case 'HALF_EVEN': return twice > d ? away : twice < d ? q : (q % 2n === 0n ? q : away);
  }
}
