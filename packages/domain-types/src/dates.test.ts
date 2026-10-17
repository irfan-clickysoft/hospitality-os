import { describe, expect, it } from 'vitest';
import { addDays, diffDays, isBusinessDate, isoWeekday, nightsOf } from './dates.js';

describe('business dates', () => {
  it('validates real calendar dates only', () => {
    for (const ok of ['2026-10-20', '2028-02-29']) expect(isBusinessDate(ok)).toBe(true);
    for (const bad of ['2026-02-29', '2026-13-01', '2026-1-1', '20261020', '2026-10-20T00:00', '']) expect(isBusinessDate(bad)).toBe(false);
  });
  it('adds days across month, year and leap boundaries without timezone drift', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-11-01', '2026-10-31')).toBe(1);
  });
  it('a stay occupies [arrival, departure): the departure date is not a night', () => {
    expect(nightsOf('2026-10-10', '2026-10-13')).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
    expect(() => nightsOf('2026-10-10', '2026-10-10')).toThrow();
    expect(() => nightsOf('2026-10-13', '2026-10-10')).toThrow();
    expect(() => nightsOf('2026-01-01', '2028-01-01')).toThrow(/cannot exceed/);
  });
  it('computes the ISO weekday', () => {
    expect(isoWeekday('2026-10-19')).toBe(1); // Monday
    expect(isoWeekday('2026-10-25')).toBe(7); // Sunday
  });
});
