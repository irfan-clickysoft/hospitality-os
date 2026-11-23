import { sql } from 'kysely';
import type { Def, Row } from './types.js';
import { addDays } from './util.js';

const DEPT: Record<string, string> = { FRONT_DESK: 'Front desk', HOUSEKEEPING: 'Housekeeping', MAINTENANCE: 'Maintenance', FNB: 'Food and beverage', SECURITY: 'Security', MANAGEMENT: 'Management' };
const ORDER = Object.keys(DEPT);

/** Staff needed against staff rostered, day by day, from the rooms expected to be in use and the standard set for each department. */
export const staffing: Def = {
  id: 'staffing-forecast', name: 'Staffing forecast', category: 'staff', kind: 'analytical', permissions: ['report.view', 'management.view'], roles: ['manager'],
  purpose: 'How many people each department needs for the rooms expected to be in use, against how many are on the roster, so short days are seen before they happen.',
  basis: [{ id: 'stay', label: 'Date worked' }], range: 'next30',
  params: [{ key: 'group', label: 'Show', default: 'department', options: [{ value: 'department', label: 'By department' }, { value: 'day', label: 'By day' }] }],
  definitions: [
    { term: 'Rooms in use', text: 'For days already past: rooms sold, from the night audit. For today and later: the latest saved forecast for that date, or the nights on the books if there is none.' },
    { term: 'Needed', text: 'Rooms in use ÷ the department’s rooms-per-person standard, rounded up, and never below its minimum. The standard is set on the Roster page. A department with no standard is not scored.' },
    { term: 'Rostered', text: 'People with a shift in that department on that date. A person with two shifts in a day counts once.' },
    { term: 'Short / over', text: 'Rostered − needed. Negative is short.' },
  ],
  async run(c) {
    const bd = c.prop.businessDate;
    const rules = await sql<{ department: string; rps: number; min: number }>`SELECT department, rooms_per_staff AS rps, min_staff AS min FROM staffing_rule WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId}`.execute(c.trx);
    const rule = new Map(rules.rows.map((r) => [r.department, r]));
    const past = await sql<{ d: string; n: number }>`SELECT business_date::text AS d, rooms_sold AS n FROM daily_property_stats WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND business_date BETWEEN ${c.from}::date AND ${c.to}::date`.execute(c.trx);
    const fc = await sql<{ d: string; n: number }>`SELECT DISTINCT ON (stay_date) stay_date::text AS d, forecast_nights AS n FROM forecast_saved WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND stay_date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY stay_date, made_on DESC`.execute(c.trx);
    const otb = await sql<{ d: string; n: number }>`SELECT n.business_date::text AS d, count(*)::int AS n FROM stay_night n JOIN reservation_room l ON l.id = n.reservation_room_id WHERE n.tenant_id = ${c.tenantId} AND n.property_id = ${c.propertyId} AND n.business_date BETWEEN ${c.from}::date AND ${c.to}::date AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT') GROUP BY n.business_date`.execute(c.trx);
    const sh = await sql<{ d: string; dep: string; n: number }>`SELECT shift_date::text AS d, department AS dep, count(DISTINCT user_id)::int AS n FROM roster_shift WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND shift_date BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY 1, 2`.execute(c.trx);
    const P = new Map(past.rows.map((x) => [x.d, x.n])); const F = new Map(fc.rows.map((x) => [x.d, x.n])); const B = new Map(otb.rows.map((x) => [x.d, x.n])); const R = new Map(sh.rows.map((x) => [`${x.d}|${x.dep}`, x.n]));
    const days: Array<{ d: string; rooms: number; src: string }> = [];
    for (let d = c.from; d <= c.to; d = addDays(d, 1)) { const isPast = d < bd; const rooms = isPast && P.has(d) ? P.get(d)! : F.has(d) && !isPast ? F.get(d)! : B.get(d) ?? 0; days.push({ d, rooms, src: isPast && P.has(d) ? 'Sold' : !isPast && F.has(d) ? 'Forecast' : 'On the books' }); }
    const scored = ORDER.filter((k) => rule.has(k));
    const need = (k: string, rooms: number) => { const r = rule.get(k)!; return Math.max(r.min, Math.ceil(rooms / r.rps)); };
    const warnings: string[] = [];
    if (!scored.length) warnings.push('No staffing standards are set yet. Set how many rooms one person covers for each department on the Roster page.');
    const total = { short: 0, shortDays: 0, unrostered: 0 };
    const perDept = scored.map((k) => { let needSum = 0; let haveSum = 0; let shortDays = 0; let shortPeople = 0; let overDays = 0; for (const x of days) { const nd = need(k, x.rooms); const hv = R.get(`${x.d}|${k}`) ?? 0; needSum += nd; haveSum += hv; if (hv < nd) { shortDays++; shortPeople += nd - hv; } else if (hv > nd) overDays++; } return { k, needSum, haveSum, shortDays, shortPeople, overDays }; });
    for (const p of perDept) { total.short += p.shortPeople; total.shortDays += p.shortDays; }
    const dayCount = days.length || 1;
    const shortDates = days.filter((x) => scored.some((k) => (R.get(`${x.d}|${k}`) ?? 0) < need(k, x.rooms))).length;
    const rostered = !sh.rows.length;
    if (scored.length && rostered) warnings.push('Nobody is rostered in this period, so every day shows as short.');
    const kp = [{ key: 'days', label: 'Days with a department short', value: shortDates, type: 'int' as const, definition: 'Days where at least one scored department has fewer people rostered than needed.' }, { key: 'ppl', label: 'People short (person-days)', value: total.short, type: 'int' as const, definition: 'Sum over departments and days of people needed but not rostered.' }, { key: 'avg', label: 'Average rooms in use', value: days.length ? Math.round((days.reduce((s, x) => s + x.rooms, 0) / dayCount) * 10) / 10 : 0, type: 'int' as const, definition: 'Average rooms in use per day.' }, { key: 'dep', label: 'Departments scored', value: scored.length, type: 'int' as const, definition: 'Departments with a standard set.' }];
    if ((c.params.group ?? 'department') === 'day') {
      const cols = [{ key: 'd', label: 'Date', type: 'date' as const }, { key: 'rooms', label: 'Rooms in use', type: 'int' as const }, { key: 'src', label: 'Based on' }, ...scored.map((k) => ({ key: k, label: `${DEPT[k]} (short / over)`, type: 'int' as const })), { key: 'short', label: 'People short', type: 'int' as const, total: true }];
      const rows = days.map((x): Row => { const o: Row = { d: x.d, rooms: x.rooms, src: x.src, short: 0 }; for (const k of scored) { const gap = (R.get(`${x.d}|${k}`) ?? 0) - need(k, x.rooms); o[k] = gap; if (gap < 0) o.short = (o.short as number) - gap; } return o; });
      return { kpis: kp, warnings, columns: cols, rows, chart: { kind: 'bar', x: 'd', series: [{ key: 'short', label: 'People short' }] }, notes: ['Negative figures are people short, positive are people over the standard.'] };
    }
    const rows: Row[] = perDept.map((p): Row => ({ what: DEPT[p.k]!, std: `1 per ${rule.get(p.k)!.rps} rooms, min ${rule.get(p.k)!.min}`, need: Math.round((p.needSum / dayCount) * 10) / 10, have: Math.round((p.haveSum / dayCount) * 10) / 10, shortDays: p.shortDays, shortPeople: p.shortPeople, overDays: p.overDays }));
    return { kpis: kp, warnings, columns: [{ key: 'what', label: 'Department' }, { key: 'std', label: 'Standard' }, { key: 'need', label: 'Average needed', type: 'int' }, { key: 'have', label: 'Average rostered', type: 'int' }, { key: 'shortDays', label: 'Days short', type: 'int', total: true }, { key: 'shortPeople', label: 'People short (person-days)', type: 'int', total: true }, { key: 'overDays', label: 'Days over', type: 'int', total: true }],
      rows, chart: { kind: 'bar', x: 'what', series: [{ key: 'need', label: 'Average needed' }, { key: 'have', label: 'Average rostered' }] }, notes: ['Needs come from the standard set on the Roster page and the rooms expected in use. A standard is a rule of thumb, not a labour law.'] };
  },
};
