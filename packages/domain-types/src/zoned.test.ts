import { describe, expect, it } from 'vitest';
import { civilDateIn, hoursBeforeArrival, zonedToUtcMs } from './zoned.js';

describe('zoned time', () => {
  it('converts a Karachi wall-clock time (UTC+5, no DST) to the right instant', () => {
    expect(new Date(zonedToUtcMs('2026-11-05', '14:00', 'Asia/Karachi')).toISOString()).toBe('2026-11-05T09:00:00.000Z');
    expect(new Date(zonedToUtcMs('2026-11-05', '00:30', 'Asia/Karachi')).toISOString()).toBe('2026-11-04T19:30:00.000Z');
  });
  it('handles daylight saving on both sides of the change (New York)', () => {
    expect(new Date(zonedToUtcMs('2026-01-15', '14:00', 'America/New_York')).toISOString()).toBe('2026-01-15T19:00:00.000Z');   // EST
    expect(new Date(zonedToUtcMs('2026-07-15', '14:00', 'America/New_York')).toISOString()).toBe('2026-07-15T18:00:00.000Z');   // EDT
    expect(new Date(zonedToUtcMs('2026-03-08', '14:00', 'America/New_York')).toISOString()).toBe('2026-03-08T18:00:00.000Z');   // the day the clocks change
  });
  it('measures the 72-hour boundary against check-in time, not midnight', () => {
    const arrival = '2026-11-05', checkIn = '14:00', tz = 'Asia/Karachi';
    const at = (h: number) => zonedToUtcMs(arrival, checkIn, tz) - h * 3_600_000;
    expect(hoursBeforeArrival(arrival, checkIn, tz, at(72))).toBeCloseTo(72, 6);
    expect(hoursBeforeArrival(arrival, checkIn, tz, at(71.5))).toBeCloseTo(71.5, 6);
    expect(hoursBeforeArrival(arrival, checkIn, tz, at(-2))).toBeCloseTo(-2, 6);
  });
  it('gives the civil date in the property time zone', () => {
    const ms = Date.UTC(2026, 9, 17, 20, 30);                                  // 20:30 UTC = 01:30 next day in Karachi
    expect(civilDateIn('Asia/Karachi', ms)).toBe('2026-10-18');
    expect(civilDateIn('UTC', ms)).toBe('2026-10-17');
  });
  it('rejects malformed input', () => {
    expect(() => zonedToUtcMs('2026-13-01', '14:00', 'UTC')).toThrow();
    expect(() => zonedToUtcMs('2026-11-05', '2pm', 'UTC')).toThrow();
  });
});
