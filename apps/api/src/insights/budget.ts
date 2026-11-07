import { sql } from 'kysely';
import type { Ctx, Def, Row, Trx } from './types.js';
import { addDays, dec, pctOf } from './util.js';
import type { PDef, PProp } from './portfolio.js';
import { scorecard } from './exec.js';

export interface Month {
  month: string; days: number; elapsed: number; hasBudget: boolean;
  budget: { room: bigint; fnb: bigint; occ: number | null };
  actual: { room: bigint; fnb: bigint; sold: number; sell: number };
  otb: { room: bigint; nights: number }; sellMonth: number;
}
const lastDay = (m: string) => { const t = new Date(`${m}-01T00:00:00Z`); t.setUTCMonth(t.getUTCMonth() + 1); t.setUTCDate(0); return t.toISOString().slice(0, 10); };

/** Budget, actual to date and what is already on the books for the rest of the month, for one property. */
export async function monthFigures(trx: Trx, tenantId: string, propertyId: string, bd: string): Promise<Month> {
  const month = bd.slice(0, 7); const first = `${month}-01`; const end = lastDay(month); const days = Number(end.slice(8, 10)); const elapsed = Number(bd.slice(8, 10));
  const r = await sql<Record<string, any>>`SELECT
      (SELECT count(*) FROM room WHERE tenant_id = ${tenantId} AND property_id = ${propertyId} AND status = 'ACTIVE')::int AS rooms,
      (SELECT room_revenue_minor FROM budget_month WHERE tenant_id = ${tenantId} AND property_id = ${propertyId} AND month = ${first}::date)::text AS b_room,
      (SELECT fnb_revenue_minor FROM budget_month WHERE tenant_id = ${tenantId} AND property_id = ${propertyId} AND month = ${first}::date)::text AS b_fnb,
      (SELECT occupancy_pct FROM budget_month WHERE tenant_id = ${tenantId} AND property_id = ${propertyId} AND month = ${first}::date)::float AS b_occ,
      EXISTS (SELECT 1 FROM budget_month WHERE tenant_id = ${tenantId} AND property_id = ${propertyId} AND month = ${first}::date) AS has_b,
      (SELECT coalesce(sum(least(b.end_date, ${end}::date + 1) - greatest(b.start_date, ${first}::date)), 0) FROM room_block b WHERE b.tenant_id = ${tenantId} AND b.property_id = ${propertyId} AND b.cancelled_at IS NULL AND b.start_date <= ${end}::date AND b.end_date > ${first}::date)::int AS blocked_m,
      (SELECT coalesce(sum(least(b.end_date, ${bd}::date + 1) - greatest(b.start_date, ${first}::date)), 0) FROM room_block b WHERE b.tenant_id = ${tenantId} AND b.property_id = ${propertyId} AND b.cancelled_at IS NULL AND b.start_date <= ${bd}::date AND b.end_date > ${first}::date)::int AS blocked_td,
      (SELECT count(*) FROM stay_night n JOIN reservation_room l ON l.id = n.reservation_room_id WHERE n.tenant_id = ${tenantId} AND n.property_id = ${propertyId} AND n.business_date BETWEEN ${first}::date AND ${bd}::date AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT'))::int AS sold,
      (SELECT coalesce(sum(n.total_minor), 0) FROM stay_night n JOIN reservation_room l ON l.id = n.reservation_room_id WHERE n.tenant_id = ${tenantId} AND n.property_id = ${propertyId} AND n.business_date BETWEEN ${first}::date AND ${bd}::date AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT'))::text AS rev,
      (SELECT count(*) FROM stay_night n JOIN reservation_room l ON l.id = n.reservation_room_id WHERE n.tenant_id = ${tenantId} AND n.property_id = ${propertyId} AND n.business_date BETWEEN ${addDays(bd, 1)}::date AND ${end}::date AND l.status IN ('CONFIRMED','CHECKED_IN'))::int AS otb_n,
      (SELECT coalesce(sum(n.total_minor), 0) FROM stay_night n JOIN reservation_room l ON l.id = n.reservation_room_id WHERE n.tenant_id = ${tenantId} AND n.property_id = ${propertyId} AND n.business_date BETWEEN ${addDays(bd, 1)}::date AND ${end}::date AND l.status IN ('CONFIRMED','CHECKED_IN'))::text AS otb_rev,
      (SELECT coalesce(sum(p.amount_minor), 0) FROM folio_posting p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id WHERE p.tenant_id = ${tenantId} AND p.property_id = ${propertyId} AND p.posting_type = 'CHARGE' AND p.txn_code = 'FNB' AND f.folio_type <> 'HOUSE' AND p.business_date BETWEEN ${first}::date AND ${bd}::date)::text AS fnb`.execute(trx);
  const x = r.rows[0]!;
  return { month, days, elapsed, hasBudget: !!x.has_b, budget: { room: BigInt(x.b_room ?? 0), fnb: BigInt(x.b_fnb ?? 0), occ: x.b_occ == null ? null : Number(x.b_occ) },
    actual: { room: BigInt(x.rev), fnb: BigInt(x.fnb), sold: x.sold, sell: Math.max(0, x.rooms * elapsed - x.blocked_td) }, otb: { room: BigInt(x.otb_rev), nights: x.otb_n }, sellMonth: Math.max(0, x.rooms * days - x.blocked_m) };
}

const prorate = (full: bigint, m: Month) => (m.days ? (full * BigInt(m.elapsed)) / BigInt(m.days) : 0n);
const pct = (a: bigint, b: bigint) => (b > 0n ? Math.round(Number(((a - b) * 1000n) / b)) / 10 : 0);

/** The rows both the property report and the owner pack show. Money is in decimal text, as the table expects for mixed-format rows. */
export function varianceRows(m: Month): Row[] {
  const bRoom = prorate(m.budget.room, m); const bFnb = prorate(m.budget.fnb, m);
  const fRoom = m.actual.room + m.otb.room; const occA = pctOf(m.actual.sold, m.actual.sell); const occF = pctOf(m.actual.sold + m.otb.nights, m.sellMonth);
  const money = (what: string, full: bigint, td: bigint, act: bigint, fc: bigint | null): Row => ({ what, full: dec(full), todate: dec(td), actual: dec(act), var: dec(act - td), varPct: m.hasBudget ? pct(act, td) : '', forecast: fc == null ? '' : dec(fc), fcVar: fc == null ? '' : dec(fc - full), _fmt: 'money' });
  return [money('Room revenue', m.budget.room, bRoom, m.actual.room, fRoom), money('Food and beverage revenue', m.budget.fnb, bFnb, m.actual.fnb, null),
    { what: 'Occupancy %', full: m.budget.occ ?? '', todate: m.budget.occ ?? '', actual: occA, var: m.budget.occ == null ? '' : Math.round((occA - m.budget.occ) * 10) / 10, varPct: '', forecast: occF, fcVar: m.budget.occ == null ? '' : Math.round((occF - m.budget.occ) * 10) / 10, _fmt: 'pct' }];
}
const COLS = [{ key: 'what', label: 'Measure' }, ...([['full', 'Budget for the month'], ['todate', 'Budget to date'], ['actual', 'Actual to date'], ['var', 'Over or under']] as const).map(([key, label]) => ({ key, label, rowFmt: true })), { key: 'varPct', label: 'Over or under %', type: 'pct' as const }, ...([['forecast', 'Forecast for the month'], ['fcVar', 'Forecast vs budget']] as const).map(([key, label]) => ({ key, label, rowFmt: true }))];
const NOTES = ['Budget to date is the month’s budget spread evenly over its days, so it ignores weekends and seasons.', 'Forecast is actual so far plus what is already booked for the rest of the month; it does not guess at bookings still to come. Food and beverage has no forecast: orders are not booked ahead.'];
const FORMAT_COLS = { key: '', label: '' };
void FORMAT_COLS;

export const variance: Def = {
  id: 'budget-variance', name: 'Budget versus actual versus forecast', category: 'management', kind: 'executive', permissions: ['management.view', 'report.view'], roles: ['manager', 'accounts'],
  purpose: 'This month’s budget against what has happened so far and what is already on the books, so the owner sees early whether the month will land.',
  basis: [{ id: 'asof', label: 'The business date’s month, to date' }], range: 'none',
  definitions: [{ term: 'Budget', text: 'Entered by the property manager for each month: room revenue, food and beverage revenue and occupancy.' }, { term: 'Actual to date', text: 'Room revenue (before tax) and food and beverage charges for the month up to the business date.' }, { term: 'Forecast', text: 'Actual to date + confirmed and in-house nights on the books for the rest of the month.' }],
  async run(c: Ctx) {
    const m = await monthFigures(c.trx, c.tenantId, c.propertyId, c.prop.businessDate); const rows = varianceRows(m);
    return { kpis: [{ key: 'rev', label: 'Room revenue vs budget to date', value: m.hasBudget ? `${pct(m.actual.room, prorate(m.budget.room, m))}%` : 'No budget', type: 'text', tone: !m.hasBudget ? 'warn' : m.actual.room >= prorate(m.budget.room, m) ? 'ok' : 'warn', definition: 'Actual minus budget to date, as a percent of budget to date.' }, { key: 'fc', label: 'Room revenue forecast for the month', value: dec(m.actual.room + m.otb.room), type: 'money', definition: 'Actual so far plus booked for the rest of the month.' }, { key: 'bud', label: 'Room revenue budget', value: dec(m.budget.room), type: 'money', definition: 'For the whole month.' }],
      columns: COLS, rows, warnings: m.hasBudget ? [] : [`No budget is set for ${m.month}. Add it in Reports → Budgets.`], notes: NOTES };
  },
};

/** Owner or investor pack: the scorecard, the budget picture and the money that is owed, on one page, ready to print. */
export const ownerPack: Def = {
  id: 'owner-pack', name: 'Owner and investor pack', category: 'management', kind: 'executive', permissions: ['management.view', 'report.view'], roles: ['manager', 'accounts'],
  purpose: 'The month and year so far, the budget picture and what is owed and at risk, in one page that can be printed or scheduled to the owner.',
  basis: [{ id: 'asof', label: 'To the business date' }], range: 'none',
  definitions: [{ term: 'Sections', text: 'Performance: the scorecard (month, last month, year, last year). Budget: this month against its budget and forecast. Position: what guests and companies owe, and what is overdue.' }],
  async run(c: Ctx) {
    const sc = await scorecard.run(c); const m = await monthFigures(c.trx, c.tenantId, c.propertyId, c.prop.businessDate); const v = varianceRows(m);
    const pos = await sql<Record<string, any>>`SELECT (SELECT coalesce(sum(f.balance_minor), 0) FROM folio f WHERE f.tenant_id = ${c.tenantId} AND f.property_id = ${c.propertyId} AND f.status = 'OPEN' AND f.folio_type = 'GUEST' AND f.balance_minor > 0)::text AS guests,
        (SELECT coalesce(sum(i.amount_minor - coalesce((SELECT sum(a.applied_minor) FROM ar_allocation a WHERE a.tenant_id = i.tenant_id AND a.item_id = i.id), 0)), 0) FROM ar_item i WHERE i.tenant_id = ${c.tenantId} AND i.property_id = ${c.propertyId} AND NOT EXISTS (SELECT 1 FROM ar_item_void v WHERE v.tenant_id = i.tenant_id AND v.item_id = i.id))::text AS companies,
        (SELECT count(*) FROM work_order w WHERE w.tenant_id = ${c.tenantId} AND w.property_id = ${c.propertyId} AND w.status IN ('REQUESTED','OPEN','ASSIGNED','IN_PROGRESS','WAITING') AND w.due_date < ${c.prop.businessDate}::date)::int AS jobs`.execute(c.trx);
    const p = pos.rows[0]!;
    const rows: Row[] = [...sc.rows.map((x): Row => ({ section: 'Performance', metric: x.what as string, a: x.mtd ?? '', b: x.lm ?? '', c: x.y ?? '', d: x.ly ?? '', _fmt: x._fmt ?? 'int' })),
      ...v.map((x): Row => ({ section: 'Budget', metric: x.what as string, a: x.actual ?? '', b: x.todate ?? '', c: x.full ?? '', d: x.forecast ?? '', _fmt: x._fmt ?? 'int' })),
      { section: 'Position', metric: 'Guests owe', a: dec(p.guests), b: '', c: '', d: '', _fmt: 'money' }, { section: 'Position', metric: 'Companies owe', a: dec(p.companies), b: '', c: '', d: '', _fmt: 'money' }, { section: 'Position', metric: 'Overdue maintenance jobs', a: p.jobs, b: '', c: '', d: '', _fmt: 'int' }];
    return { kpis: sc.kpis, columns: [{ key: 'section', label: 'Section' }, { key: 'metric', label: 'Measure' }, { key: 'a', label: 'Month to date / Actual', rowFmt: true }, { key: 'b', label: 'Last month / Budget to date', rowFmt: true }, { key: 'c', label: 'Year to date / Budget for month', rowFmt: true }, { key: 'd', label: 'Same dates last year / Forecast', rowFmt: true }], rows,
      warnings: m.hasBudget ? [] : [`No budget is set for ${m.month}.`], notes: ['The four columns mean different things in each section: see the headings of the scorecard and budget reports. Cash flow, loans, capital spending and departmental profit are not recorded, so they are not in this pack.'] };
  },
};

export const portfolioVariance: PDef = {
  id: 'portfolio-budget', name: 'Portfolio budget variance', kind: 'executive', range: 'none',
  purpose: 'Every property’s month so far against its budget, and the forecast for the month, side by side.',
  definitions: [{ term: 'Month', text: 'Each property’s own business date month.' }, { term: 'Over or under', text: 'Room revenue actual to date minus budget to date.' }, { term: 'Forecast', text: 'Actual so far plus what is booked for the rest of the month.' }],
  async run(c) {
    const rows: Row[] = [];
    for (const p of c.props as PProp[]) { const m = await monthFigures(c.trx, c.tenantId, p.id, p.businessDate); const td = prorate(m.budget.room, m); rows.push({ prop: p.name, month: m.month, bud: m.budget.room.toString(), todate: td.toString(), actual: m.actual.room.toString(), diff: (m.actual.room - td).toString(), pct: m.hasBudget ? pct(m.actual.room, td) : '', fc: (m.actual.room + m.otb.room).toString(), fcv: (m.actual.room + m.otb.room - m.budget.room).toString(), set: m.hasBudget ? 'Set' : 'No budget' }); }
    const s = (k: string) => rows.reduce((t, x) => t + BigInt(x[k] as string), 0n);
    return { kpis: [{ key: 'act', label: 'Room revenue to date', value: dec(s('actual')), type: 'money', definition: 'All properties, before tax.' }, { key: 'bud', label: 'Budget to date', value: dec(s('todate')), type: 'money', definition: 'Prorated month budgets.' }, { key: 'fc', label: 'Forecast for the month', value: dec(s('fc')), type: 'money', definition: 'Actual plus on the books.' }, { key: 'no', label: 'Properties with no budget', value: rows.filter((x) => x.set === 'No budget').length, type: 'int', tone: rows.some((x) => x.set === 'No budget') ? 'warn' : 'ok', definition: 'Set the budget to include them.' }],
      columns: [{ key: 'prop', label: 'Property' }, { key: 'month', label: 'Month' }, { key: 'bud', label: 'Budget for the month', type: 'money', total: true }, { key: 'todate', label: 'Budget to date', type: 'money', total: true }, { key: 'actual', label: 'Actual to date', type: 'money', total: true }, { key: 'diff', label: 'Over or under', type: 'money', total: true }, { key: 'pct', label: 'Over or under %', type: 'pct' }, { key: 'fc', label: 'Forecast', type: 'money', total: true }, { key: 'fcv', label: 'Forecast vs budget', type: 'money', total: true }, { key: 'set', label: 'Budget', type: 'badge' }], rows, notes: NOTES };
  },
};
