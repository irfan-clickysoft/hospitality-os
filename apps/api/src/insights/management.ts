import { sql } from 'kysely';
import type { Ctx, Def, Kpi, Row } from './types.js';
import { addDays, dec, pctOf } from './util.js';

const ACTIVE = (c: Ctx) => sql`SELECT count(*)::int AS n FROM room WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND status = 'ACTIVE'`;
const num = (v: unknown) => Number(v ?? 0);

async function stats(c: Ctx, from: string, to: string) {
  const r = await sql<Record<string, any>>`SELECT coalesce(sum(rooms_sold), 0)::int AS sold, coalesce(sum(rooms_available), 0)::int AS avail, coalesce(sum(room_revenue_minor), 0)::text AS room, coalesce(sum(fees_minor), 0)::text AS fees, coalesce(sum(other_revenue_minor), 0)::text AS other,
      coalesce(sum(tax_minor), 0)::text AS tax, count(*)::int AS days FROM daily_property_stats WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND business_date BETWEEN ${from}::date AND ${to}::date`.execute(c.trx);
  const x = r.rows[0]!; const room = BigInt(x.room);
  return { sold: x.sold as number, avail: x.avail as number, room, fees: BigInt(x.fees), other: BigInt(x.other), tax: BigInt(x.tax), days: x.days as number, occ: pctOf(x.sold, x.avail), adr: x.sold > 0 ? room / BigInt(x.sold) : 0n, revpar: x.avail > 0 ? room / BigInt(x.avail) : 0n };
}

export const flash: Def = {
  id: 'flash', name: 'Daily manager flash', category: 'management', kind: 'executive', permissions: ['management.view', 'report.view'], roles: ['manager'],
  purpose: 'The business day at a glance: rooms, arrivals and departures, money taken, what is owed, and what needs a decision.',
  basis: [{ id: 'today', label: 'Current business date' }], range: 'none',
  definitions: [{ term: 'Live', text: 'Counts are as of the moment of generation. Revenue is what has been posted to bills; room charges are posted by the night audit.' }, { term: 'Month to date', text: 'Closed business days of the month from the night audit, excluding today.' }, { term: 'Cash collected', text: 'Payments received on the business date. It is not revenue.' }],
  async run(c) {
    const bd = c.prop.businessDate; const t = c.tenantId; const p = c.propertyId; const mStart = `${bd.slice(0, 8)}01`;
    const one = async <T>(q: ReturnType<typeof sql<T>>) => (await q.execute(c.trx)).rows[0] as Record<string, any>;
    const rooms = num((await one(ACTIVE(c))).n);
    const ooo = num((await one(sql`SELECT count(DISTINCT room_id)::int AS n FROM room_block WHERE tenant_id = ${t} AND property_id = ${p} AND cancelled_at IS NULL AND start_date <= ${bd}::date AND end_date > ${bd}::date`)).n);
    const lines = await one(sql`SELECT count(*) FILTER (WHERE status = 'CHECKED_IN')::int AS inhouse, count(*) FILTER (WHERE status = 'CONFIRMED' AND arrival = ${bd}::date)::int AS arr_due, count(*) FILTER (WHERE status = 'CHECKED_IN' AND checked_in_business_date = ${bd}::date AND arrival = ${bd}::date)::int AS arr_done,
        count(*) FILTER (WHERE status = 'CHECKED_IN' AND departure = ${bd}::date)::int AS dep_due, count(*) FILTER (WHERE status = 'CHECKED_OUT' AND checked_out_business_date = ${bd}::date)::int AS dep_done, count(*) FILTER (WHERE status = 'CHECKED_IN' AND departure < ${bd}::date)::int AS overdue,
        count(*) FILTER (WHERE status = 'CONFIRMED' AND arrival < ${bd}::date)::int AS noshow_cand, count(*) FILTER (WHERE status = 'CONFIRMED' AND arrival = ${bd}::date AND NOT EXISTS (SELECT 1 FROM room_assignment a WHERE a.assignment_ref = reservation_room.id AND a.status IN ('ASSIGNED','IN_HOUSE')))::int AS unassigned
      FROM reservation_room WHERE tenant_id = ${t} AND property_id = ${p}`);
    const money = await one(sql`SELECT coalesce(sum(amount_minor) FILTER (WHERE posting_type = 'CHARGE' AND txn_code IN ('ROOM','ROOM_EXTRAS')), 0)::text AS room, coalesce(sum(amount_minor) FILTER (WHERE posting_type = 'CHARGE' AND txn_code NOT IN ('ROOM','ROOM_EXTRAS')), 0)::text AS other
      FROM folio_posting WHERE tenant_id = ${t} AND property_id = ${p} AND business_date = ${bd}::date`);
    const pay = await one(sql`SELECT coalesce(sum(amount_minor) FILTER (WHERE kind <> 'REFUND' AND status = 'CAPTURED'), 0)::text AS inn, coalesce(sum(amount_minor) FILTER (WHERE kind = 'REFUND' AND status = 'CAPTURED'), 0)::text AS out,
        coalesce(sum(amount_minor) FILTER (WHERE kind <> 'REFUND' AND status = 'CAPTURED' AND method = 'CASH'), 0)::text AS cash FROM payment WHERE tenant_id = ${t} AND property_id = ${p} AND business_date = ${bd}::date`);
    const owe = await one(sql`SELECT coalesce(sum(balance_minor) FILTER (WHERE balance_minor > 0), 0)::text AS owing, count(*) FILTER (WHERE balance_minor > 0)::int AS n FROM folio WHERE tenant_id = ${t} AND property_id = ${p} AND status = 'OPEN'`);
    const exc = await one(sql`SELECT (SELECT count(*) FROM cashier_session WHERE tenant_id = ${t} AND property_id = ${p} AND status = 'OPEN')::int AS open_shifts,
        (SELECT count(*) FROM work_order WHERE tenant_id = ${t} AND property_id = ${p} AND status IN ('OPEN','ASSIGNED','IN_PROGRESS','WAITING') AND due_date < ${bd}::date)::int AS wo_late,
        (SELECT count(*) FROM reservation WHERE tenant_id = ${t} AND property_id = ${p} AND status = 'CONFIRMED' AND at_risk)::int AS at_risk,
        (SELECT count(*) FROM room r WHERE r.tenant_id = ${t} AND r.property_id = ${p} AND r.status = 'ACTIVE' AND r.hk_status = 'DIRTY')::int AS dirty`);
    const mtd = await stats(c, mStart, addDays(bd, -1)); const lastRun = await one(sql`SELECT max(business_date)::text AS d FROM night_audit_run WHERE tenant_id = ${t} AND property_id = ${p} AND status = 'COMPLETED'`);
    const sellable = rooms - ooo;
    const R = (section: string, metric: string, today: string | number, mtdV: string | number | null, fmt: 'int' | 'money' | 'pct', def: string, tone = ''): Row => ({ section, metric, today, mtd: mtdV, _fmt: fmt, definition: def, tone });
    const rows: Row[] = [
      R('Rooms', 'Sellable rooms', sellable, null, 'int', 'Active rooms minus rooms out of order or out of service today.'), R('Rooms', 'Rooms in house', num(lines.inhouse), null, 'int', 'Room lines checked in now.'), R('Rooms', 'Occupancy now', pctOf(num(lines.inhouse), sellable), mtd.days ? mtd.occ : null, 'pct', 'Rooms in house ÷ sellable rooms. Month to date is rooms sold ÷ rooms available over closed days.'),
      R('Rooms', 'Out of order / service', ooo, null, 'int', 'Rooms with an active block today.'),
      R('Front desk', 'Arrivals due / arrived', `${num(lines.arr_done)} of ${num(lines.arr_due) + num(lines.arr_done)}`, null, 'int', 'Arrivals due today and how many have checked in.'), R('Front desk', 'Departures due / left', `${num(lines.dep_done)} of ${num(lines.dep_due) + num(lines.dep_done)}`, null, 'int', 'Departures due today and how many have checked out.'),
      R('Money', 'Room revenue posted today', dec(money.room), dec(mtd.room), 'money', 'Room charges posted on the bill for the business date, excluding tax.'), R('Money', 'Other revenue posted today', dec(money.other), dec(mtd.fees + mtd.other), 'money', 'Fees, food, laundry and other charges posted, excluding tax.'),
      R('Money', 'ADR', '', dec(mtd.adr), 'money', 'Recognized room revenue ÷ rooms sold (closed days).'), R('Money', 'RevPAR', '', dec(mtd.revpar), 'money', 'Recognized room revenue ÷ rooms available (closed days).'),
      R('Money', 'Cash collected today', dec(pay.inn), null, 'money', 'Payments received on the business date, all methods, before refunds. Not revenue.'), R('Money', 'of which physical cash', dec(pay.cash), null, 'money', 'Cash payments only.'), R('Money', 'Refunds today', dec(pay.out), null, 'money', 'Refunds paid out on the business date.'),
      R('Money', 'Owing on open bills', dec(owe.owing), null, 'money', 'Open bills with a balance above zero (guests and companies).'),
      R('Needs a decision', 'Overdue departures', num(lines.overdue), null, 'int', 'Checked in beyond the departure date.', num(lines.overdue) ? 'warn' : ''), R('Needs a decision', 'No-show candidates', num(lines.noshow_cand), null, 'int', 'Confirmed bookings whose arrival date has passed and are still open.', num(lines.noshow_cand) ? 'warn' : ''),
      R('Needs a decision', 'Arrivals with no room', num(lines.unassigned), null, 'int', 'Due today with no room assigned.', num(lines.unassigned) ? 'warn' : ''), R('Needs a decision', 'Bookings with guarantee at risk', num(exc.at_risk), null, 'int', 'Confirmed bookings flagged at risk.', num(exc.at_risk) ? 'warn' : ''),
      R('Needs a decision', 'Cashier shifts still open', num(exc.open_shifts), null, 'int', 'Shifts not yet closed.', num(exc.open_shifts) ? 'warn' : ''), R('Needs a decision', 'Overdue work orders', num(exc.wo_late), null, 'int', 'Open work orders past their due date.', num(exc.wo_late) ? 'warn' : ''), R('Needs a decision', 'Dirty rooms', num(exc.dirty), null, 'int', 'Active rooms marked dirty.'),
    ];
    const warnings: string[] = []; if (!lastRun.d) warnings.push('No night audit has been completed yet, so month-to-date figures are empty.'); else if (lastRun.d < addDays(bd, -1)) warnings.push(`The last completed night audit is for ${lastRun.d}; month-to-date figures stop there.`);
    return { kpis: rows.filter((x) => ['Occupancy now', 'Cash collected today', 'Owing on open bills'].includes(x.metric as string)).map((x): Kpi => ({ key: x.metric as string, label: x.metric as string, value: x.today as string | number, type: x._fmt as 'int' | 'money' | 'pct', definition: x.definition as string })),
      columns: [{ key: 'section', label: 'Section' }, { key: 'metric', label: 'Measure' }, { key: 'today', label: 'Today', type: 'text' }, { key: 'mtd', label: 'Month to date (closed days)', type: 'text' }, { key: 'definition', label: 'Definition', hidden: true }], rows, warnings };
  },
};

export const nightAudit: Def = {
  id: 'night-audit', name: 'Night audit', category: 'finance', kind: 'audit', permissions: ['nightaudit.run', 'report.view', 'management.view'], roles: ['accounts', 'manager'],
  purpose: 'Each closed business day: who closed it, how it went, and the figures it locked in.',
  basis: [{ id: 'business', label: 'Business date' }], range: 'month',
  definitions: [{ term: 'Closed day', text: 'A completed night audit locks that day’s statistics: rooms sold, revenue (excluding tax), cash and variances.' }, { term: 'Overrides', text: 'Steps the closing user chose to push past a warning.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT n.business_date::text AS bd, n.status, n.mode, u.full_name AS by, to_char(n.started_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI') AS started, to_char(n.completed_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI') AS done, n.resumed_count, n.error, jsonb_array_length(coalesce(n.overrides, '[]'::jsonb)) AS overrides,
        (SELECT count(*) FROM night_audit_step s WHERE s.run_id = n.id AND s.status = 'FAILED')::int AS failed, d.rooms_sold, d.rooms_available, d.occupancy_bp, d.room_revenue_minor::text AS room, d.fees_minor::text AS fees, d.other_revenue_minor::text AS other, d.tax_minor::text AS tax, d.adr_minor::text AS adr, d.revpar_minor::text AS revpar,
        d.guest_ledger_minor::text AS ledger, d.advance_deposits_minor::text AS deposits, d.cashier_variance_minor::text AS variance, d.no_shows, d.cancellations
      FROM night_audit_run n JOIN staff_user u ON u.id = n.started_by LEFT JOIN daily_property_stats d ON d.tenant_id = n.tenant_id AND d.property_id = n.property_id AND d.business_date = n.business_date
      WHERE n.tenant_id = ${c.tenantId} AND n.property_id = ${c.propertyId} AND n.business_date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY n.business_date DESC, n.started_at DESC`.execute(c.trx);
    const rows: Row[] = r.rows.map((x) => ({ bd: x.bd, status: x.status === 'COMPLETED' ? 'Completed' : x.status === 'FAILED' ? 'Failed' : 'Running', mode: x.mode === 'AUTO' ? 'Automatic' : 'Manual', by: x.by, started: x.started, done: x.done ?? '', overrides: x.overrides, failed: x.failed, resumed: x.resumed_count, sold: x.rooms_sold ?? null, avail: x.rooms_available ?? null, occ: x.occupancy_bp === null || x.occupancy_bp === undefined ? null : x.occupancy_bp / 100,
      room: x.room ?? null, fees: x.fees ?? null, other: x.other ?? null, tax: x.tax ?? null, adr: x.adr ?? null, revpar: x.revpar ?? null, ledger: x.ledger ?? null, deposits: x.deposits ?? null, variance: x.variance ?? null, noshows: x.no_shows ?? null, canc: x.cancellations ?? null, error: x.error ?? '' }));
    const days = new Set(rows.filter((x) => x.status === 'Completed').map((x) => x.bd)).size; const span = Math.round((Date.parse(c.to) - Date.parse(c.from)) / 86_400_000) + 1; const missing = []; for (let i = 0; i < span; i++) { const d = addDays(c.from, i); if (d < c.prop.businessDate && !rows.some((x) => x.bd === d && x.status === 'Completed')) missing.push(d); }
    return { kpis: [{ key: 'closed', label: 'Days closed', value: days, type: 'int', definition: 'Business days with a completed night audit in the period.' }, { key: 'miss', label: 'Days not closed', value: missing.length, type: 'int', tone: missing.length ? 'bad' : 'ok', definition: 'Days before today with no completed night audit.' },
        { key: 'ov', label: 'Overrides used', value: rows.reduce((s, x) => s + Number(x.overrides), 0), type: 'int', definition: 'Warnings pushed past when closing.' }],
      columns: [{ key: 'bd', label: 'Business date', type: 'date' }, { key: 'status', label: 'Status', type: 'badge' }, { key: 'mode', label: 'How', hidden: true }, { key: 'by', label: 'Closed by' }, { key: 'started', label: 'Started', type: 'datetime', hidden: true }, { key: 'done', label: 'Completed', type: 'datetime' }, { key: 'overrides', label: 'Overrides', type: 'int', total: true }, { key: 'failed', label: 'Failed steps', type: 'int', total: true, hidden: true },
        { key: 'sold', label: 'Rooms sold', type: 'int', total: true }, { key: 'avail', label: 'Rooms available', type: 'int', total: true, hidden: true }, { key: 'occ', label: 'Occupancy %', type: 'pct' }, { key: 'room', label: 'Room revenue', type: 'money', total: true }, { key: 'fees', label: 'Fees', type: 'money', total: true, hidden: true }, { key: 'other', label: 'Other revenue', type: 'money', total: true, hidden: true }, { key: 'tax', label: 'Tax', type: 'money', total: true, hidden: true },
        { key: 'adr', label: 'ADR', type: 'money' }, { key: 'revpar', label: 'RevPAR', type: 'money', hidden: true }, { key: 'ledger', label: 'Guest ledger', type: 'money' }, { key: 'deposits', label: 'Advance deposits', type: 'money', hidden: true }, { key: 'variance', label: 'Cashier variance', type: 'money', total: true }, { key: 'error', label: 'Error', hidden: true }],
      rows, warnings: missing.length ? [`No completed night audit for: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`] : [] };
  },
};

export const futureBookings: Def = {
  id: 'future-bookings', name: 'Future bookings and revenue', category: 'sales', kind: 'analytical', permissions: ['management.view', 'report.view'], roles: ['manager', 'accounts'],
  purpose: 'What is already on the books for the coming days: rooms, occupancy and room revenue, with tentative holds kept apart.',
  basis: [{ id: 'stay', label: 'Stay date' }], range: 'next30',
  params: [{ key: 'group', label: 'Group by', default: 'day', options: [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }] }],
  definitions: [{ term: 'On the books', text: 'Confirmed and in-house room nights for the stay date, at today’s booked prices, excluding tax. This is not a forecast and not revenue earned.' }, { term: 'Tentative', text: 'Holds that have not been confirmed; never added to on-the-books figures.' },
    { term: 'Occupancy on the books', text: 'On-the-books room nights ÷ sellable room nights (active rooms minus rooms blocked that night).' }, { term: 'Forecast', text: 'Not shown. A forecast needs saved daily snapshots of the books (pace and pickup) which the system does not keep yet.' }],
  async run(c) {
    const unit = c.params.group === 'month' ? 'month' : c.params.group === 'week' ? 'week' : 'day';
    const r = await sql<Record<string, any>>`WITH d AS (SELECT generate_series(${c.from}::date, ${c.to}::date, '1 day')::date AS day),
        rooms AS (SELECT count(*)::int AS n FROM room WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND status = 'ACTIVE'),
        sell AS (SELECT d.day, (SELECT n FROM rooms) - (SELECT count(DISTINCT b.room_id) FROM room_block b WHERE b.tenant_id = ${c.tenantId} AND b.property_id = ${c.propertyId} AND b.cancelled_at IS NULL AND b.start_date <= d.day AND b.end_date > d.day)::int AS sellable FROM d),
        otb AS (SELECT n.business_date AS day, count(*) FILTER (WHERE l.status IN ('CONFIRMED','CHECKED_IN'))::int AS conf, count(*) FILTER (WHERE l.status = 'OPTION')::int AS opt,
            coalesce(sum(n.total_minor) FILTER (WHERE l.status IN ('CONFIRMED','CHECKED_IN')), 0) AS rev, coalesce(sum(n.total_minor) FILTER (WHERE l.status = 'OPTION'), 0) AS rev_opt
          FROM stay_night n JOIN reservation_room l ON l.id = n.reservation_room_id WHERE n.tenant_id = ${c.tenantId} AND n.property_id = ${c.propertyId} AND n.business_date BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY n.business_date)
      SELECT date_trunc(${unit}, s.day)::date::text AS period, min(s.day)::text AS first_day, count(*)::int AS days, sum(s.sellable)::int AS sellable, coalesce(sum(o.conf), 0)::int AS conf, coalesce(sum(o.opt), 0)::int AS opt, coalesce(sum(o.rev), 0)::text AS rev, coalesce(sum(o.rev_opt), 0)::text AS rev_opt
      FROM sell s LEFT JOIN otb o ON o.day = s.day GROUP BY 1 ORDER BY 1`.execute(c.trx);
    const rows: Row[] = r.rows.map((x) => ({ period: unit === 'day' ? x.period : `${x.first_day}${unit === 'month' ? ' (month)' : ' (week)'}`, days: x.days, sellable: x.sellable, nights: x.conf, occ: pctOf(x.conf, x.sellable), rev: x.rev, adr: x.conf > 0 ? (BigInt(x.rev) / BigInt(x.conf)).toString() : '0', opt: x.opt, revOpt: x.rev_opt }));
    const tn = rows.reduce((s, x) => s + Number(x.nights), 0); const ts = rows.reduce((s, x) => s + Number(x.sellable), 0); const trev = rows.reduce((s, x) => s + BigInt(x.rev as string), 0n); const topt = rows.reduce((s, x) => s + Number(x.opt), 0);
    return { kpis: [{ key: 'n', label: 'Room nights on the books', value: tn, type: 'int', definition: 'Confirmed and in-house room nights in the period.' }, { key: 'occ', label: 'Occupancy on the books', value: pctOf(tn, ts), type: 'pct', definition: 'On-the-books nights ÷ sellable nights.' },
        { key: 'rev', label: 'Room revenue on the books', value: dec(trev), type: 'money', definition: 'Booked room revenue for confirmed and in-house nights, excluding tax.' }, { key: 'adr', label: 'ADR on the books', value: tn ? dec(trev / BigInt(tn)) : '0.00', type: 'money', definition: 'Revenue on the books ÷ nights on the books.' }, { key: 'opt', label: 'Tentative nights (not included)', value: topt, type: 'int', definition: 'Unconfirmed holds in the period.' }],
      columns: [{ key: 'period', label: unit === 'day' ? 'Stay date' : 'Period', type: unit === 'day' ? 'date' : 'text' }, { key: 'days', label: 'Days', type: 'int', hidden: unit === 'day' }, { key: 'sellable', label: 'Sellable room nights', type: 'int', total: true }, { key: 'nights', label: 'Nights on the books', type: 'int', total: true }, { key: 'occ', label: 'Occupancy %', type: 'pct' },
        { key: 'rev', label: 'Room revenue on the books', type: 'money', total: true }, { key: 'adr', label: 'ADR', type: 'money' }, { key: 'opt', label: 'Tentative nights', type: 'int', total: true }, { key: 'revOpt', label: 'Tentative value', type: 'money', total: true, hidden: true }],
      chart: { kind: 'bar', x: 'period', series: [{ key: 'occ', label: 'Occupancy % on the books' }] }, rows, notes: ['On-the-books only. Forecast revenue, booking pace and pickup need daily snapshots and are a later phase.'] };
  },
};

export const historical: Def = {
  id: 'historical', name: 'Historical performance', category: 'sales', kind: 'analytical', permissions: ['management.view', 'report.view'], roles: ['manager', 'accounts'],
  purpose: 'Occupancy, ADR, RevPAR and revenue for closed business days, compared with the period before and the same period last year.',
  basis: [{ id: 'business', label: 'Business date (closed days)' }], range: 'month',
  params: [{ key: 'group', label: 'Group by', default: 'day', options: [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }] }],
  definitions: [{ term: 'Occupancy %', text: 'Rooms sold ÷ rooms available, where rooms available excludes rooms out of order or out of service. Shown for paid rooms sold.' }, { term: 'ADR', text: 'Room revenue ÷ rooms sold, excluding tax, fees and other revenue.' }, { term: 'RevPAR', text: 'Room revenue ÷ rooms available.' },
    { term: 'Recognized revenue', text: 'Revenue earned for nights consumed, as locked by the night audit. It is not cash collected and not future bookings.' }, { term: 'Comparison', text: 'Previous period = the same number of days immediately before. Last year = the same dates one year earlier.' }],
  async run(c) {
    const unit = c.params.group === 'month' ? 'month' : c.params.group === 'week' ? 'week' : 'day';
    const days = Math.round((Date.parse(c.to) - Date.parse(c.from)) / 86_400_000) + 1; const cur = await stats(c, c.from, c.to);
    const prev = await stats(c, addDays(c.from, -days), addDays(c.from, -1)); const ly = await stats(c, addDays(c.from, -365), addDays(c.to, -365));
    const r = await sql<Record<string, any>>`SELECT date_trunc(${unit}, business_date)::date::text AS p, min(business_date)::text AS first_day, count(*)::int AS days, sum(rooms_sold)::int AS sold, sum(rooms_available)::int AS avail, sum(room_revenue_minor)::text AS room, sum(fees_minor)::text AS fees, sum(other_revenue_minor)::text AS other, sum(tax_minor)::text AS tax, sum(arrivals)::int AS arr, sum(no_shows)::int AS ns, sum(cancellations)::int AS canc
      FROM daily_property_stats WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND business_date BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY 1 ORDER BY 1`.execute(c.trx);
    const rows: Row[] = r.rows.map((x) => ({ period: unit === 'day' ? x.p : `${x.first_day}${unit === 'month' ? ' (month)' : ' (week)'}`, days: x.days, sold: x.sold, avail: x.avail, occ: pctOf(x.sold, x.avail), room: x.room, adr: x.sold > 0 ? (BigInt(x.room) / BigInt(x.sold)).toString() : '0', revpar: x.avail > 0 ? (BigInt(x.room) / BigInt(x.avail)).toString() : '0', fees: x.fees, other: x.other, total: (BigInt(x.room) + BigInt(x.fees) + BigInt(x.other)).toString(), tax: x.tax, arr: x.arr, ns: x.ns, canc: x.canc }));
    const cmp = (f: (s: typeof cur) => string | number) => [{ label: 'Previous period', value: prev.days ? f(prev) : '—' }, { label: 'Last year', value: ly.days ? f(ly) : '—' }];
    const warnings: string[] = []; if (cur.days < days) warnings.push(`Only ${cur.days} of ${days} days in this period have a closed night audit; figures cover those days only.`);
    return { kpis: [{ key: 'occ', label: 'Occupancy', value: cur.occ, type: 'pct', definition: 'Rooms sold ÷ rooms available.', compare: cmp((s) => `${s.occ}%`) }, { key: 'adr', label: 'ADR', value: dec(cur.adr), type: 'money', definition: 'Room revenue ÷ rooms sold, excluding tax.', compare: cmp((s) => dec(s.adr)) },
        { key: 'revpar', label: 'RevPAR', value: dec(cur.revpar), type: 'money', definition: 'Room revenue ÷ rooms available.', compare: cmp((s) => dec(s.revpar)) }, { key: 'rev', label: 'Room revenue', value: dec(cur.room), type: 'money', definition: 'Recognized room revenue excluding tax.', compare: cmp((s) => dec(s.room)) },
        { key: 'sold', label: 'Rooms sold', value: cur.sold, type: 'int', definition: 'Occupied room nights.', compare: cmp((s) => s.sold) }],
      columns: [{ key: 'period', label: unit === 'day' ? 'Business date' : 'Period', type: unit === 'day' ? 'date' : 'text' }, { key: 'days', label: 'Days', type: 'int', hidden: unit === 'day' }, { key: 'sold', label: 'Rooms sold', type: 'int', total: true }, { key: 'avail', label: 'Rooms available', type: 'int', total: true }, { key: 'occ', label: 'Occupancy %', type: 'pct' },
        { key: 'room', label: 'Room revenue', type: 'money', total: true }, { key: 'adr', label: 'ADR', type: 'money' }, { key: 'revpar', label: 'RevPAR', type: 'money' }, { key: 'fees', label: 'Fees', type: 'money', total: true, hidden: true }, { key: 'other', label: 'Other revenue', type: 'money', total: true, hidden: true }, { key: 'total', label: 'Total revenue', type: 'money', total: true }, { key: 'tax', label: 'Tax', type: 'money', total: true, hidden: true },
        { key: 'arr', label: 'Arrivals', type: 'int', total: true, hidden: true }, { key: 'ns', label: 'No-shows', type: 'int', total: true, hidden: true }, { key: 'canc', label: 'Cancellations', type: 'int', total: true, hidden: true }],
      chart: { kind: 'line', x: 'period', series: [{ key: 'occ', label: 'Occupancy %' }] }, rows, warnings };
  },
};
