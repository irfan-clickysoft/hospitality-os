import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : []; });

describe('dates', () => {
  it('no screen takes "today" from the browser clock: the day that counts is the property’s business day (it lags the calendar until the night audit, and the browser may be in another zone)', () => {
    const bad = files(new URL('..', import.meta.url).pathname).filter((f) => /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)|toLocaleDateString\('en-CA'\)/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
