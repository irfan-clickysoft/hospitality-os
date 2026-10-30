import { sql } from 'kysely';
import type { Ctx, Def, Row } from './types.js';
import { addDays, dec, pctOf } from './util.js';

const monday = (d: string) => { const t = new Date(`${d}T00:00:00Z`); const w = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - w); return t.toISOString().slice(0, 10); };
const keyOf = (d: string, unit: string) => (unit === 'month' ? `${d.slice(0, 8)}01` : unit === 'week' ? monday(d) : d);
const dayList = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };

/** Room nights and revenue on the books right now for a range of stay dates (confirmed and in-house; tentative holds are not counted). */
async function booksNow(c: Ctx) {
  const r = await sql<{ d: string; n: number; rev: string }>`SELECT n.business_date::text AS d, count(*)::int AS n, coalesce(sum(n.total_minor), 0)::text AS rev FROM stay_night n JOIN reservation_room l ON l.id = n.reservation_room_id
    WHERE n.tenant_id = ${c.tenantId} AND n.property_id = ${c.propertyId} AND n.business_date BETWEEN ${c.from}::date AND ${c.to}::date AND l.status IN ('CONFIRMED','CHECKED_IN') GROUP BY n.business_date`.execute(c.trx);
  return new Map(r.rows.map((x) => [x.d, { n: x.n, rev: BigInt(x.rev) }]));
}
/** Rooms that could be sold on each date: active rooms less those blocked that night. */
async function sellable(c: Ctx) {
  const r = await sql<{ d: string; s: number }>`WITH d AS (SELECT generate_series(${c.from}::date, ${c.to}::date, '1 day')::date AS day)
    SELECT d.day::text AS d, ((SELECT count(*) FROM room WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND status = 'ACTIVE') - (SELECT count(DISTINCT b.room_id) FROM room_block b WHERE b.tenant_id = ${c.tenantId} AND b.property_id = ${c.propertyId} AND b.cancelled_at IS NULL AND b.start_date <= d.day AND b.end_date > d.day))::int AS s FROM d`.execute(c.trx);
  return new Map(r.rows.map((x) => [x.d, x.s]));
}

export const bookingPace: Def = {
  id: 'booking-pace', name: 'Booking pace and pickup', category: 'sales', kind: 'analytical', permissions: ['management.view', 'report.view'], roles: ['manager', 'accounts'],
  purpose: 'How the books for coming dates have moved since an earlier day: nights gained or lost, split into new bookings, cancellations and changes.',
  basis: [{ id: 'stay', label: 'Stay date' }], range: 'next30',
  params: [{ key: 'compare', label: 'Compare with the books', default: '7', options: [{ value: '1', label: '1 day ago' }, { value: '7', label: '7 days ago' }, { value: '14', label: '14 days ago' }, { value: '30', label: '30 days ago' }] },
    { key: 'group', label: 'Group by', default: 'day', options: [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }] }],
  definitions: [{ term: 'On the books', text: 'Confirmed and in-house room nights for a stay date at booked prices, excluding tax. Tentative holds are left out.' }, { term: 'Earlier books', text: 'The saved snapshot from the business day that closed on or before the comparison day. Its date is shown.' },
    { term: 'Net pickup', text: 'On the books now − on the books then, for the same stay dates.' }, { term: 'New bookings', text: 'Nights of bookings made after the snapshot and still active.' }, { term: 'Cancellations', text: 'Nights of bookings that existed at the snapshot and were since cancelled or no-showed.' },
    { term: 'Changes and other', text: 'What is left: date or room changes, extensions, early departures, check-in changes. = net pickup − new bookings + cancellations.' }],
  async run(c) {
    const days = Number(c.params.compare) || 7; const unit = c.params.group ?? 'day'; const target = addDays(c.prop.businessDate, -days);
    const snap = await sql<{ d: string; taken: string }>`SELECT snapshot_date::text AS d, taken_at::text AS taken FROM booking_snapshot_run WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND snapshot_date <= ${target}::date ORDER BY snapshot_date DESC LIMIT 1`.execute(c.trx);
    const s = snap.rows[0]; const now = await booksNow(c);
    const then = new Map<string, { n: number; rev: bigint }>(); const add = new Map<string, number>(); const canc = new Map<string, number>();
    if (s) {
      const t = await sql<{ d: string; n: number; rev: string }>`SELECT stay_date::text AS d, sum(rooms)::int AS n, sum(revenue_minor)::text AS rev FROM booking_snapshot WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND snapshot_date = ${s.d}::date AND stay_date BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY stay_date`.execute(c.trx);
      for (const x of t.rows) then.set(x.d, { n: x.n, rev: BigInt(x.rev) });
      const a = await sql<{ d: string; n: number }>`SELECT n.business_date::text AS d, count(*)::int AS n FROM stay_night n JOIN reservation_room l ON l.id = n.reservation_room_id JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id
        WHERE n.tenant_id = ${c.tenantId} AND n.property_id = ${c.propertyId} AND n.business_date BETWEEN ${c.from}::date AND ${c.to}::date AND l.status IN ('CONFIRMED','CHECKED_IN') AND r.created_at > ${s.taken}::timestamptz GROUP BY n.business_date`.execute(c.trx);
      for (const x of a.rows) add.set(x.d, x.n);
      const k = await sql<{ d: string; n: number }>`SELECT n.business_date::text AS d, count(*)::int AS n FROM stay_night n JOIN reservation_room l ON l.id = n.reservation_room_id JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id
        WHERE n.tenant_id = ${c.tenantId} AND n.property_id = ${c.propertyId} AND n.business_date BETWEEN ${c.from}::date AND ${c.to}::date AND l.status IN ('CANCELLED','NO_SHOW') AND r.created_at <= ${s.taken}::timestamptz
          AND EXISTS (SELECT 1 FROM reservation_history h WHERE h.reservation_room_id = l.id AND h.to_status IN ('CANCELLED','NO_SHOW') AND h.occurred_at > ${s.taken}::timestamptz) GROUP BY n.business_date`.execute(c.trx);
      for (const x of k.rows) canc.set(x.d, x.n);
    }
    const groups = new Map<string, Row>();
    for (const d of dayList(c.from, c.to)) {
      const key = keyOf(d, unit); const g = groups.get(key) ?? { period: unit === 'day' ? key : `${key}${unit === 'month' ? ' (month)' : ' (week)'}`, nowN: 0, thenN: s ? 0 : null, pickup: s ? 0 : null, nowRev: '0', thenRev: s ? '0' : null, pickupRev: s ? '0' : null, added: s ? 0 : null, cancelled: s ? 0 : null, changed: s ? 0 : null };
      const n = now.get(d) ?? { n: 0, rev: 0n }; const th = then.get(d) ?? { n: 0, rev: 0n };
      g.nowN = (g.nowN as number) + n.n; g.nowRev = (BigInt(g.nowRev as string) + n.rev).toString();
      if (s) { g.thenN = (g.thenN as number) + th.n; g.thenRev = (BigInt(g.thenRev as string) + th.rev).toString(); g.pickup = (g.pickup as number) + n.n - th.n; g.pickupRev = (BigInt(g.pickupRev as string) + n.rev - th.rev).toString(); g.added = (g.added as number) + (add.get(d) ?? 0); g.cancelled = (g.cancelled as number) + (canc.get(d) ?? 0); g.changed = (g.pickup as number) - (g.added as number) + (g.cancelled as number); }
      groups.set(key, g);
    }
    const rows = [...groups.values()];
    const sum = (k: string) => rows.reduce((t, r) => t + Number(r[k] ?? 0), 0);
    const warnings = s ? [] : [`No saved snapshot from ${days} day(s) ago or earlier yet. Snapshots are saved each time a business day is closed; pickup appears once there is one.`];
    return { kpis: [{ key: 'now', label: 'Nights on the books now', value: sum('nowN'), type: 'int', definition: 'Confirmed and in-house room nights in the period.' }, { key: 'then', label: s ? `Nights on ${s.d}` : 'Nights then', value: s ? sum('thenN') : '—', type: s ? 'int' : 'text', definition: 'The same stay dates in the snapshot used.' },
        { key: 'net', label: 'Net pickup', value: s ? sum('pickup') : '—', type: s ? 'int' : 'text', definition: 'Now minus then.' }, { key: 'add', label: 'New bookings', value: s ? sum('added') : '—', type: s ? 'int' : 'text', definition: 'Nights of bookings made since the snapshot.' },
        { key: 'can', label: 'Cancellations', value: s ? sum('cancelled') : '—', type: s ? 'int' : 'text', definition: 'Nights lost to cancellations and no-shows since the snapshot.' }, { key: 'rev', label: 'Revenue pickup', value: s ? dec(rows.reduce((t, r) => t + BigInt(r.pickupRev as string), 0n)) : '—', type: s ? 'money' : 'text', definition: 'Room revenue on the books now minus then, excluding tax.' }],
      columns: [{ key: 'period', label: unit === 'day' ? 'Stay date' : 'Period', type: unit === 'day' ? 'date' : 'text' }, { key: 'nowN', label: 'Nights now', type: 'int', total: true }, { key: 'thenN', label: 'Nights then', type: 'int', total: true }, { key: 'pickup', label: 'Net pickup', type: 'int', total: true }, { key: 'added', label: 'New bookings', type: 'int', total: true }, { key: 'cancelled', label: 'Cancellations', type: 'int', total: true }, { key: 'changed', label: 'Changes and other', type: 'int', total: true },
        { key: 'nowRev', label: 'Revenue now', type: 'money', total: true }, { key: 'thenRev', label: 'Revenue then', type: 'money', total: true, hidden: true }, { key: 'pickupRev', label: 'Revenue pickup', type: 'money', total: true }],
      chart: { kind: 'bar', x: 'period', series: [{ key: 'pickup', label: 'Net pickup (nights)' }] }, rows, warnings,
      notes: [s ? `Compared with the books as saved when ${s.d} closed.` : 'Comparison needs a saved snapshot.', 'Cancelled revenue is not split out; the revenue columns show the net movement.'] };
  },
};

const BUCKETS: Array<[number, number]> = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 14], [15, 21], [22, 30], [31, 60], [61, 90], [91, 180], [181, 365]];
const bucketOf = (lead: number) => BUCKETS.findIndex(([a, b]) => lead >= a && lead <= b);
const MIN_SAMPLES = 8;

export const forecast: Def = {
  id: 'forecast', name: 'Occupancy and revenue forecast', category: 'sales', kind: 'analytical', permissions: ['management.view', 'report.view'], roles: ['manager', 'accounts'],
  purpose: 'Expected room nights, occupancy and room revenue for coming dates: what is on the books plus the pickup that usually follows at that distance from the date, with the evidence shown.',
  basis: [{ id: 'stay', label: 'Stay date' }], range: 'next30',
  definitions: [{ term: 'Method', text: 'Forecast nights = nights on the books now + typical pickup, capped at sellable rooms. Typical pickup for a distance (lead) of L days is the average, over the last 90 stay dates, of (rooms finally sold − nights that were on the books L days before). Leads are grouped (0,1,2…7, 8–14, 15–21, 22–30, 31–60, 61–90, 91–180, 181–365).' },
    { term: 'Samples', text: 'How many past (date, lead) pairs the typical pickup is based on. Fewer than 8: no forecast is shown for that date. Fewer than 30: low confidence.' }, { term: 'Forecast revenue', text: 'Forecast nights × room ADR. ADR is the average price of the nights on the books for that date; if none, the property’s ADR over the last 30 closed days.' },
    { term: 'Not the same as', text: 'On the books (confirmed only), the sales pipeline (unconfirmed), recognized revenue (earned) or cash collected. A forecast is an estimate, never a promise.' }],
  async run(c) {
    const bd = c.prop.businessDate;
    const hist = await sql<{ lead: number; pickup: number }>`WITH h AS (SELECT snapshot_date AS sd, stay_date AS d, sum(rooms)::int AS otb FROM booking_snapshot WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND stay_date BETWEEN ${addDays(bd, -90)}::date AND ${addDays(bd, -1)}::date AND snapshot_date <= stay_date GROUP BY 1, 2)
      SELECT (h.d - h.sd)::int AS lead, (s.rooms_sold - h.otb)::int AS pickup FROM h JOIN daily_property_stats s ON s.tenant_id = ${c.tenantId} AND s.property_id = ${c.propertyId} AND s.business_date = h.d`.execute(c.trx);
    const stats = BUCKETS.map(() => ({ n: 0, sum: 0 })); for (const x of hist.rows) { const b = bucketOf(x.lead); if (b >= 0) { stats[b]!.n++; stats[b]!.sum += x.pickup; } }
    const now = await booksNow(c); const sell = await sellable(c);
    const adrRow = await sql<{ rev: string; sold: string }>`SELECT coalesce(sum(room_revenue_minor), 0)::text AS rev, coalesce(sum(rooms_sold), 0)::text AS sold FROM daily_property_stats WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND business_date BETWEEN ${addDays(bd, -30)}::date AND ${addDays(bd, -1)}::date`.execute(c.trx);
    const recentAdr = BigInt(adrRow.rows[0]!.sold) > 0n ? BigInt(adrRow.rows[0]!.rev) / BigInt(adrRow.rows[0]!.sold) : null;
    const rows: Row[] = []; let missing = 0;
    for (const d of dayList(c.from, c.to)) {
      if (d < bd) continue;
      const lead = Math.round((Date.parse(d) - Date.parse(bd)) / 86_400_000); const b = bucketOf(lead); const st = b >= 0 ? stats[b]! : { n: 0, sum: 0 };
      const o = now.get(d) ?? { n: 0, rev: 0n }; const cap = sell.get(d) ?? 0; const enough = st.n >= MIN_SAMPLES;
      const pickup = enough ? Math.round((st.sum / st.n) * 10) / 10 : null; const fn = enough ? Math.min(cap, Math.max(0, Math.round(o.n + (st.sum / st.n)))) : null;
      const adr = o.n > 0 ? o.rev / BigInt(o.n) : recentAdr; if (!enough) missing++;
      rows.push({ date: d, lead, otb: o.n, pickup, samples: st.n, nights: fn, occ: fn === null ? null : pctOf(fn, cap), adr: adr === null ? null : adr.toString(), revenue: fn === null || adr === null ? null : (adr * BigInt(fn)).toString(), confidence: !enough ? 'Not enough history' : st.n >= 30 ? 'Good' : 'Low' });
    }
    const ok = rows.filter((r) => r.nights !== null); const tN = ok.reduce((t, r) => t + Number(r.nights), 0); const tO = ok.reduce((t, r) => t + Number(r.otb), 0); const tS = ok.reduce((t, r) => t + (sell.get(r.date as string) ?? 0), 0);
    const tRev = ok.reduce((t, r) => t + BigInt((r.revenue as string | null) ?? 0), 0n);
    const warnings: string[] = [];
    if (hist.rows.length === 0) warnings.push('No snapshot history yet, so no forecast can be made. Snapshots are saved each time a business day closes; a forecast needs a few weeks of them.');
    else if (missing) warnings.push(`${missing} of ${rows.length} dates do not have enough history at their distance (fewer than ${MIN_SAMPLES} samples) and show no forecast.`);
    return { kpis: [{ key: 'n', label: 'Forecast room nights', value: ok.length ? tN : '—', type: ok.length ? 'int' : 'text', definition: 'Sum of forecast nights for dates that have a forecast.' }, { key: 'otb', label: 'Of which on the books', value: ok.length ? tO : '—', type: ok.length ? 'int' : 'text', definition: 'Confirmed and in-house nights for the same dates.' },
        { key: 'occ', label: 'Forecast occupancy', value: ok.length ? pctOf(tN, tS) : '—', type: ok.length ? 'pct' : 'text', definition: 'Forecast nights ÷ sellable nights for those dates.' }, { key: 'rev', label: 'Forecast room revenue', value: ok.length ? dec(tRev) : '—', type: ok.length ? 'money' : 'text', definition: 'Forecast nights × ADR, excluding tax. An estimate.' }],
      columns: [{ key: 'date', label: 'Stay date', type: 'date' }, { key: 'lead', label: 'Days ahead', type: 'int' }, { key: 'otb', label: 'On the books', type: 'int', total: true }, { key: 'pickup', label: 'Typical pickup (nights)' }, { key: 'samples', label: 'Samples', type: 'int', hidden: false }, { key: 'nights', label: 'Forecast nights', type: 'int', total: true }, { key: 'occ', label: 'Forecast occupancy %', type: 'pct' },
        { key: 'adr', label: 'ADR used', type: 'money' }, { key: 'revenue', label: 'Forecast revenue', type: 'money', total: true }, { key: 'confidence', label: 'Confidence', type: 'badge' }],
      chart: { kind: 'line', x: 'date', series: [{ key: 'occ', label: 'Forecast occupancy %' }] }, rows, warnings,
      notes: ['A statistical estimate from this property’s own history; it does not know about events, rate changes or groups not yet booked. Each row shows what it was based on.', 'Forecast accuracy (how close past forecasts were) needs forecasts to be saved over time and is a later addition.'] };
  },
};
