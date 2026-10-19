import { addDays, assertBusinessDate } from './dates.js';

/** UTC instant (ms) of a wall-clock `date` + `HH:MM` in an IANA time zone (e.g. check-in 14:00 in Asia/Karachi). */
export function zonedToUtcMs(date: string, time: string, timeZone: string): number {
  assertBusinessDate(date);
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(time);
  if (!m) throw new RangeError('time must be HH:MM');
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, mo - 1, d, Number(m[1]), Number(m[2]));
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const offsetAt = (utc: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(utc)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - utc;
  };
  let utc = wall - offsetAt(wall);
  utc = wall - offsetAt(utc);            // second pass settles daylight-saving boundaries
  return utc;
}

/** Hours from `now` until check-in on the arrival date, in the property's time zone (negative once check-in time has passed). */
export function hoursBeforeArrival(arrival: string, checkInTime: string, timeZone: string, nowMs: number = Date.now()): number {
  return (zonedToUtcMs(arrival, checkInTime, timeZone) - nowMs) / 3_600_000;
}

/** The property's calendar date at an instant (the business date follows Night Audit, but this gives the civil date). */
export function civilDateIn(timeZone: string, nowMs: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
}

export { addDays };
