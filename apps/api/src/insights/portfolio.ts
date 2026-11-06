import { sql } from 'kysely';
import type { Col, Kpi, Result, Row, Trx } from './types.js';
import { dec, pctOf } from './util.js';

export interface PProp { id: string; code: string; name: string; currency: string; timezone: string; businessDate: string }
export interface PCtx { trx: Trx; tenantId: string; props: PProp[]; ids: string[]; from: string; to: string; params: Record<string, string> }
export interface PDef {
  id: string; name: string; purpose: string; kind: 'operational' | 'analytical' | 'financial' | 'audit' | 'executive'; range: 'none' | 'today' | 'month';
  params?: Array<{ key: string; label: string; options: Array<{ value: string; label: string }>; default: string }>;
  definitions: Array<{ term: string; text: string }>;
  run: (c: PCtx) => Promise<Result>;
}
const SOLD = sql`('CONFIRMED','CHECKED_IN','CHECKED_OUT')`;
const name = (c: PCtx, id: string) => c.props.find((p) => p.id === id)?.name ?? id;
const days = (c: PCtx) => Math.round((Date.parse(`${c.to}T00:00:00Z`) - Date.parse(`${c.from}T00:00:00Z`)) / 86_400_000) + 1;
const num = (v: unknown) => Number(v ?? 0);

export const flash: PDef = {
  id: 'portfolio-flash', name: 'Portfolio daily flash', kind: 'executive', range: 'none',
  purpose: 'Every property today on one page: arrivals, departures, guests in the house, occupancy, room revenue posted, money taken, and what guests owe.',
  definitions: [{ term: 'Today', text: 'Each property’s own business date, which may differ between properties.' }, { term: 'Room revenue', text: 'Room nights for the business date, before tax.' }, { term: 'Money taken', text: 'Captured payments and deposits for the business date, less refunds.' }, { term: 'Owing', text: 'Open guest bills with a balance to pay.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT p.id, p.business_date::text AS bd,
        (SELECT count(*) FROM room WHERE tenant_id = p.tenant_id AND property_id = p.id AND status = 'ACTIVE')::int AS rooms,
        (SELECT count(*) FROM reservation_room l WHERE l.tenant_id = p.tenant_id AND l.property_id = p.id AND l.arrival = p.business_date AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT'))::int AS arr,
        (SELECT count(*) FROM reservation_room l WHERE l.tenant_id = p.tenant_id AND l.property_id = p.id AND l.departure = p.business_date AND l.status IN ('CHECKED_IN','CHECKED_OUT'))::int AS dep,
        (SELECT count(*) FROM reservation_room l WHERE l.tenant_id = p.tenant_id AND l.property_id = p.id AND l.status = 'CHECKED_IN')::int AS inh,
        (SELECT coalesce(sum(n.total_minor), 0) FROM stay_night n JOIN reservation_room l ON l.id = n.reservation_room_id WHERE n.tenant_id = p.tenant_id AND n.property_id = p.id AND n.business_date = p.business_date AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT'))::text AS rev,
        (SELECT coalesce(sum(CASE WHEN y.kind = 'REFUND' THEN -y.amount_minor ELSE y.amount_minor END), 0) FROM payment y WHERE y.tenant_id = p.tenant_id AND y.property_id = p.id AND y.business_date = p.business_date AND y.status = 'CAPTURED')::text AS cash,
        (SELECT coalesce(sum(f.balance_minor), 0) FROM folio f WHERE f.tenant_id = p.tenant_id AND f.property_id = p.id AND f.status = 'OPEN' AND f.folio_type = 'GUEST' AND f.balance_minor > 0)::text AS owing
      FROM property p WHERE p.tenant_id = ${c.tenantId} AND p.id = ANY(${c.ids}::uuid[]) ORDER BY p.name`.execute(c.trx);
    const rows: Row[] = r.rows.map((x): Row => ({ prop: name(c, x.id), bd: x.bd, rooms: x.rooms, arr: x.arr, dep: x.dep, inh: x.inh, occ: pctOf(x.inh, x.rooms), rev: x.rev, cash: x.cash, owing: x.owing }));
    const s = (k: string) => rows.reduce((t, x) => t + num(x[k]), 0);
    return { kpis: [{ key: 'p', label: 'Properties', value: rows.length, type: 'int', definition: 'Properties you can see.' }, { key: 'inh', label: 'Guests in house', value: s('inh'), type: 'int', definition: 'Occupied rooms across all properties.' }, { key: 'occ', label: 'Occupancy now', value: pctOf(s('inh'), s('rooms')), type: 'pct', definition: 'Occupied ÷ active rooms, all properties.' }, { key: 'arr', label: 'Arrivals today', value: s('arr'), type: 'int', definition: 'Arrivals on each property’s business date.' }],
      columns: [{ key: 'prop', label: 'Property' }, { key: 'bd', label: 'Business date', type: 'date' }, { key: 'rooms', label: 'Rooms', type: 'int', total: true }, { key: 'arr', label: 'Arrivals', type: 'int', total: true }, { key: 'dep', label: 'Departures', type: 'int', total: true }, { key: 'inh', label: 'In house', type: 'int', total: true }, { key: 'occ', label: 'Occupancy %', type: 'pct' }, { key: 'rev', label: 'Room revenue', type: 'money', total: true }, { key: 'cash', label: 'Money taken', type: 'money', total: true }, { key: 'owing', label: 'Guests owe', type: 'money', total: true }], rows,
      notes: ['The total row adds up properties; occupancy is shown per property only.'] };
  },
};

export const comparison: PDef = {
  id: 'portfolio-comparison', name: 'Property comparison: occupancy, ADR and RevPAR', kind: 'analytical', range: 'month',
  purpose: 'Properties side by side for the period, with the consolidated figures for the whole portfolio on the last line.',
  definitions: [{ term: 'Rooms sold', text: 'Confirmed, in-house and checked-out room nights with a stay date in the period.' }, { term: 'Sellable', text: 'Active rooms × days, less nights blocked out of order or service.' }, { term: 'Occupancy', text: 'Rooms sold ÷ sellable.' }, { term: 'ADR', text: 'Room revenue ÷ rooms sold, before tax.' }, { term: 'RevPAR', text: 'Room revenue ÷ sellable room nights.' }, { term: 'Consolidated', text: 'Worked out from the portfolio’s total nights and revenue, not by averaging property percentages.' }],
  async run(c) {
    const d = days(c);
    const r = await sql<Record<string, any>>`SELECT p.id, (SELECT count(*) FROM room WHERE tenant_id = p.tenant_id AND property_id = p.id AND status = 'ACTIVE')::int AS rooms,
        (SELECT coalesce(sum(least(b.end_date, ${c.to}::date + 1) - greatest(b.start_date, ${c.from}::date)), 0) FROM room_block b WHERE b.tenant_id = p.tenant_id AND b.property_id = p.id AND b.cancelled_at IS NULL AND b.start_date <= ${c.to}::date AND b.end_date > ${c.from}::date)::int AS blocked,
        (SELECT count(*) FROM stay_night n JOIN reservation_room l ON l.id = n.reservation_room_id WHERE n.tenant_id = p.tenant_id AND n.property_id = p.id AND n.business_date BETWEEN ${c.from}::date AND ${c.to}::date AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT'))::int AS sold,
        (SELECT coalesce(sum(n.total_minor), 0) FROM stay_night n JOIN reservation_room l ON l.id = n.reservation_room_id WHERE n.tenant_id = p.tenant_id AND n.property_id = p.id AND n.business_date BETWEEN ${c.from}::date AND ${c.to}::date AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT'))::text AS rev
      FROM property p WHERE p.tenant_id = ${c.tenantId} AND p.id = ANY(${c.ids}::uuid[]) ORDER BY p.name`.execute(c.trx);
    const one = (x: Record<string, any>) => { const sell = Math.max(0, Number(x.rooms) * d - Number(x.blocked)); const rev = BigInt(x.rev); return { sell, occ: pctOf(Number(x.sold), sell), adr: Number(x.sold) ? (rev / BigInt(x.sold)).toString() : '0', revpar: sell ? (rev / BigInt(sell)).toString() : '0' }; };
    const rows: Row[] = r.rows.map((x): Row => { const o = one(x); return { prop: name(c, x.id), rooms: x.rooms, sell: o.sell, sold: x.sold, occ: o.occ, rev: x.rev, adr: o.adr, revpar: o.revpar }; });
    const tot = r.rows.reduce((t, x) => ({ rooms: t.rooms + x.rooms, blocked: t.blocked + x.blocked, sold: t.sold + x.sold, rev: (BigInt(t.rev) + BigInt(x.rev)).toString() }), { rooms: 0, blocked: 0, sold: 0, rev: '0' }); const o = one(tot);
    const all: Row = { prop: 'All properties', rooms: tot.rooms, sell: o.sell, sold: tot.sold, occ: o.occ, rev: tot.rev, adr: o.adr, revpar: o.revpar };
    return { kpis: [{ key: 'occ', label: 'Portfolio occupancy', value: o.occ, type: 'pct', definition: 'Total rooms sold ÷ total sellable.' }, { key: 'adr', label: 'Portfolio ADR', value: dec(o.adr), type: 'money', definition: 'Total room revenue ÷ total rooms sold.' }, { key: 'revpar', label: 'Portfolio RevPAR', value: dec(o.revpar), type: 'money', definition: 'Total room revenue ÷ total sellable nights.' }, { key: 'rev', label: 'Room revenue', value: dec(tot.rev), type: 'money', definition: 'Room revenue across properties, before tax.' }],
      columns: [{ key: 'prop', label: 'Property' }, { key: 'rooms', label: 'Rooms', type: 'int' }, { key: 'sell', label: 'Sellable nights', type: 'int' }, { key: 'sold', label: 'Rooms sold', type: 'int' }, { key: 'occ', label: 'Occupancy %', type: 'pct' }, { key: 'rev', label: 'Room revenue', type: 'money' }, { key: 'adr', label: 'ADR', type: 'money' }, { key: 'revpar', label: 'RevPAR', type: 'money' }], rows: [...rows, all],
      chart: { kind: 'bar', x: 'prop', series: [{ key: 'occ', label: 'Occupancy %' }] }, notes: ['Forecast and budget comparisons are not available: no budget is recorded and the forecast is per property (see its own report).'] };
  },
};

export const cash: PDef = {
  id: 'portfolio-cash', name: 'Portfolio cash and receivables', kind: 'financial', range: 'month',
  purpose: 'Money collected in the period, what in-house and departed guests owe, and what companies owe, for each property and in total.',
  definitions: [{ term: 'Collected', text: 'Captured payments and deposits less refunds in the period. Cash and non-cash are not separated here.' }, { term: 'Guests owe', text: 'Open guest bills with a balance, as of now.' }, { term: 'Companies owe', text: 'Company billings less money applied to them, cancelled billings left out.' }, { term: 'Overdue', text: 'The part of company billings past their due date.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT p.id, p.business_date::text AS bd,
        (SELECT coalesce(sum(CASE WHEN y.kind = 'REFUND' THEN -y.amount_minor ELSE y.amount_minor END), 0) FROM payment y WHERE y.tenant_id = p.tenant_id AND y.property_id = p.id AND y.business_date BETWEEN ${c.from}::date AND ${c.to}::date AND y.status = 'CAPTURED')::text AS coll,
        (SELECT coalesce(sum(y.amount_minor), 0) FROM payment y WHERE y.tenant_id = p.tenant_id AND y.property_id = p.id AND y.status = 'PENDING_VERIFICATION')::text AS pend,
        (SELECT coalesce(sum(f.balance_minor), 0) FROM folio f WHERE f.tenant_id = p.tenant_id AND f.property_id = p.id AND f.status = 'OPEN' AND f.folio_type = 'GUEST' AND f.balance_minor > 0)::text AS owing,
        (SELECT coalesce(sum(i.amount_minor - coalesce((SELECT sum(a.applied_minor) FROM ar_allocation a WHERE a.tenant_id = i.tenant_id AND a.item_id = i.id), 0)), 0) FROM ar_item i WHERE i.tenant_id = p.tenant_id AND i.property_id = p.id AND NOT EXISTS (SELECT 1 FROM ar_item_void v WHERE v.tenant_id = i.tenant_id AND v.item_id = i.id))::text AS ar,
        (SELECT coalesce(sum(i.amount_minor - coalesce((SELECT sum(a.applied_minor) FROM ar_allocation a WHERE a.tenant_id = i.tenant_id AND a.item_id = i.id), 0)), 0) FROM ar_item i WHERE i.tenant_id = p.tenant_id AND i.property_id = p.id AND i.due_date < p.business_date AND NOT EXISTS (SELECT 1 FROM ar_item_void v WHERE v.tenant_id = i.tenant_id AND v.item_id = i.id))::text AS ar_late
      FROM property p WHERE p.tenant_id = ${c.tenantId} AND p.id = ANY(${c.ids}::uuid[]) ORDER BY p.name`.execute(c.trx);
    const rows: Row[] = r.rows.map((x): Row => ({ prop: name(c, x.id), coll: x.coll, pend: x.pend, owing: x.owing, ar: x.ar, late: x.ar_late }));
    const s = (k: string) => rows.reduce((t, x) => t + BigInt(x[k] as string), 0n);
    return { kpis: [{ key: 'coll', label: 'Collected', value: dec(s('coll')), type: 'money', definition: 'Net collected in the period.' }, { key: 'owing', label: 'Guests owe', value: dec(s('owing')), type: 'money', definition: 'Open guest bills with a balance.' }, { key: 'ar', label: 'Companies owe', value: dec(s('ar')), type: 'money', definition: 'Open company billings.' }, { key: 'late', label: 'Company overdue', value: dec(s('late')), type: 'money', tone: s('late') > 0n ? 'warn' : 'ok', definition: 'Company billings past due.' }],
      columns: [{ key: 'prop', label: 'Property' }, { key: 'coll', label: 'Collected', type: 'money', total: true }, { key: 'pend', label: 'Waiting to be verified', type: 'money', total: true }, { key: 'owing', label: 'Guests owe', type: 'money', total: true }, { key: 'ar', label: 'Companies owe', type: 'money', total: true }, { key: 'late', label: 'Company overdue', type: 'money', total: true }], rows,
      notes: ['Bank deposits, gateway and OTA settlements are not recorded, so this is what the desks entered.'] };
  },
};

export const mix: PDef = {
  id: 'portfolio-mix', name: 'Portfolio revenue mix', kind: 'analytical', range: 'month',
  purpose: 'Where each property’s revenue comes from: rooms, food and beverage, halls and other charges, with discounts shown apart.',
  definitions: [{ term: 'Rooms', text: 'Room and room-extras charges posted to bills.' }, { term: 'Food and beverage', text: 'Delivered orders charged to guest bills.' }, { term: 'Halls', text: 'Hall and space bookings charged to bills.' }, { term: 'Other', text: 'Every other charge (transport, miscellaneous and so on).' }, { term: 'Discounts', text: 'Discounts posted on bills, shown as negative and not netted into the groups.' }, { term: 'Posted revenue', text: 'Before tax; not cash collected.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT p.property_id AS id, CASE WHEN p.posting_type = 'DISCOUNT' THEN 'disc' WHEN p.txn_code IN ('ROOM','ROOM_EXTRAS') THEN 'room' WHEN p.txn_code = 'FNB' THEN 'fnb' WHEN p.txn_code = 'HALL' THEN 'hall' ELSE 'other' END AS grp, sum(p.amount_minor)::text AS amt
      FROM folio_posting p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id WHERE p.tenant_id = ${c.tenantId} AND p.property_id = ANY(${c.ids}::uuid[]) AND f.folio_type <> 'HOUSE' AND p.posting_type IN ('CHARGE','DISCOUNT') AND p.business_date BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY 1, 2`.execute(c.trx);
    const rows: Row[] = c.props.map((p): Row => { const g = (k: string) => BigInt(r.rows.find((x) => x.id === p.id && x.grp === k)?.amt ?? 0); const gross = g('room') + g('fnb') + g('hall') + g('other'); const pc = (v: bigint) => (gross > 0n ? Math.round(Number((v * 1000n) / gross)) / 10 : 0);
      return { prop: p.name, room: g('room').toString(), fnb: g('fnb').toString(), hall: g('hall').toString(), other: g('other').toString(), gross: gross.toString(), disc: g('disc').toString(), roomPct: pc(g('room')), fnbPct: pc(g('fnb')) }; });
    const s = (k: string) => rows.reduce((t, x) => t + BigInt(x[k] as string), 0n);
    return { kpis: [{ key: 'gross', label: 'Charges posted', value: dec(s('gross')), type: 'money', definition: 'Room, F&B, hall and other charges, before tax.' }, { key: 'room', label: 'Rooms', value: dec(s('room')), type: 'money', definition: 'Room and extras.' }, { key: 'fnb', label: 'Food and beverage', value: dec(s('fnb')), type: 'money', definition: 'F&B charges.' }, { key: 'disc', label: 'Discounts', value: dec(s('disc')), type: 'money', definition: 'Discounts posted on bills.' }],
      columns: [{ key: 'prop', label: 'Property' }, { key: 'room', label: 'Rooms', type: 'money', total: true }, { key: 'fnb', label: 'Food and beverage', type: 'money', total: true }, { key: 'hall', label: 'Halls', type: 'money', total: true }, { key: 'other', label: 'Other', type: 'money', total: true }, { key: 'gross', label: 'Total charges', type: 'money', total: true }, { key: 'disc', label: 'Discounts', type: 'money', total: true }, { key: 'roomPct', label: 'Rooms %', type: 'pct' }, { key: 'fnbPct', label: 'F&B %', type: 'pct' }], rows,
      chart: { kind: 'bar', x: 'prop', series: [{ key: 'roomPct', label: 'Rooms %' }, { key: 'fnbPct', label: 'F&B %' }] } };
  },
};

const SRC: Record<string, string> = { WALK_IN: 'Walk-in', PHONE: 'Phone', WHATSAPP: 'WhatsApp', WEBSITE: 'Website', OTA_BOOKING_COM: 'Booking.com', OTA_OTHER: 'Other OTA', CORPORATE: 'Corporate', TRAVEL_AGENT: 'Travel agent', CRS: 'Reservation system', OTHER: 'Other' };
export const channels: PDef = {
  id: 'portfolio-channels', name: 'Cross-property channel and corporate performance', kind: 'analytical', range: 'month',
  params: [{ key: 'group', label: 'Show', default: 'source', options: [{ value: 'source', label: 'Booking source' }, { value: 'company', label: 'Company' }] }],
  purpose: 'Which sources, or which companies, bring business across the portfolio: room nights, room revenue and ADR, with each property’s share.',
  definitions: [{ term: 'Room nights and revenue', text: 'Confirmed, in-house and checked-out nights with a stay date in the period; revenue before tax.' }, { term: 'Properties', text: 'How many properties the source or company booked nights at.' }, { term: 'Share', text: 'This row’s share of all room revenue.' }],
  async run(c) {
    const g = c.params.group === 'company' ? sql`coalesce(co.name, 'Not recorded')` : sql`r.source`;
    const r = await sql<Record<string, any>>`SELECT ${g} AS k, l.property_id AS pid, count(*)::int AS nights, coalesce(sum(n.total_minor), 0)::text AS rev
      FROM stay_night n JOIN reservation_room l ON l.tenant_id = n.tenant_id AND l.id = n.reservation_room_id JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id LEFT JOIN company co ON co.tenant_id = r.tenant_id AND co.id = r.company_id
      WHERE n.tenant_id = ${c.tenantId} AND n.property_id = ANY(${c.ids}::uuid[]) AND n.business_date BETWEEN ${c.from}::date AND ${c.to}::date AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT') GROUP BY 1, 2`.execute(c.trx);
    const company = c.params.group === 'company'; const map = new Map<string, { nights: number; rev: bigint; by: Map<string, bigint> }>();
    for (const x of r.rows) { const k = company ? x.k : SRC[x.k] ?? x.k; const e = map.get(k) ?? { nights: 0, rev: 0n, by: new Map() }; e.nights += x.nights; e.rev += BigInt(x.rev); e.by.set(x.pid, (e.by.get(x.pid) ?? 0n) + BigInt(x.rev)); map.set(k, e); }
    const total = [...map.values()].reduce((t, e) => t + e.rev, 0n);
    const rows: Row[] = [...map.entries()].sort((a, b) => (a[1].rev < b[1].rev ? 1 : -1)).map(([k, e]) => { const best = [...e.by.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1))[0]; return { what: k, props: e.by.size, nights: e.nights, rev: e.rev.toString(), adr: e.nights ? (e.rev / BigInt(e.nights)).toString() : '0', share: total > 0n ? Math.round(Number((e.rev * 1000n) / total)) / 10 : 0, top: best ? name(c, best[0]) : '' }; });
    const tn = rows.reduce((t, x) => t + num(x.nights), 0);
    return { kpis: [{ key: 'rev', label: 'Room revenue', value: dec(total), type: 'money', definition: 'Across properties, before tax.' }, { key: 'nights', label: 'Room nights', value: tn, type: 'int', definition: 'Nights sold.' }, { key: 'n', label: company ? 'Companies' : 'Sources', value: rows.length, type: 'int', definition: 'Rows in the view.' }],
      columns: [{ key: 'what', label: company ? 'Company' : 'Source' }, { key: 'props', label: 'Properties', type: 'int' }, { key: 'nights', label: 'Room nights', type: 'int', total: true }, { key: 'rev', label: 'Room revenue', type: 'money', total: true }, { key: 'adr', label: 'ADR', type: 'money' }, { key: 'share', label: 'Share', type: 'pct' }, { key: 'top', label: 'Biggest property' }], rows, chart: { kind: 'bar', x: 'what', series: [{ key: 'rev', label: 'Room revenue' }] } };
  },
};

export const risk: PDef = {
  id: 'portfolio-risk', name: 'Operational risk overview', kind: 'operational', range: 'month',
  purpose: 'One line per property for the things that go wrong quietly: overdue jobs and cases, bills that do not add up, payments left unverified, cash differences, rooms out of order and report deliveries that failed.',
  definitions: [{ term: 'Overdue jobs', text: 'Maintenance jobs open past their due date.' }, { term: 'Overdue cases', text: 'Open complaints and incidents past their response target. Restricted cases are not counted.' }, { term: 'Bills not adding up', text: 'Bills whose stored balance differs from their postings.' }, { term: 'Unverified payments', text: 'Bank transfers or slips waiting more than two days.' }, { term: 'Cash differences', text: 'Closed cashier shifts in the period where the count did not match.' }, { term: 'Rooms out of order', text: 'Rooms blocked out of order tonight.' }, { term: 'Failed deliveries', text: 'Scheduled reports that failed in the period.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT p.id, p.business_date::text AS bd,
        (SELECT count(*) FROM work_order w WHERE w.tenant_id = p.tenant_id AND w.property_id = p.id AND w.status IN ('REQUESTED','OPEN','ASSIGNED','IN_PROGRESS','WAITING') AND w.due_date < p.business_date)::int AS jobs,
        (SELECT count(*) FROM case_record k WHERE k.tenant_id = p.tenant_id AND k.property_id = p.id AND k.confidentiality = 'NORMAL' AND k.status IN ('OPEN','IN_PROGRESS') AND k.sla_due_at < now())::int AS cases,
        (SELECT count(*) FROM folio f WHERE f.tenant_id = p.tenant_id AND f.property_id = p.id AND f.folio_type <> 'HOUSE' AND f.balance_minor <> coalesce((SELECT sum(x.amount_minor) FROM folio_posting x WHERE x.tenant_id = f.tenant_id AND x.folio_id = f.id), 0))::int AS bills,
        (SELECT count(*) FROM payment y WHERE y.tenant_id = p.tenant_id AND y.property_id = p.id AND y.status = 'PENDING_VERIFICATION' AND y.business_date < p.business_date - 2)::int AS unver,
        (SELECT count(*) FROM cashier_session s WHERE s.tenant_id = p.tenant_id AND s.property_id = p.id AND s.status <> 'OPEN' AND coalesce(s.variance_minor, 0) <> 0 AND s.opened_business_date BETWEEN ${c.from}::date AND ${c.to}::date)::int AS cashdiff,
        (SELECT count(DISTINCT b.room_id) FROM room_block b WHERE b.tenant_id = p.tenant_id AND b.property_id = p.id AND b.cancelled_at IS NULL AND b.block_type = 'OUT_OF_ORDER' AND b.start_date <= p.business_date AND b.end_date > p.business_date)::int AS ooo,
        (SELECT count(*) FROM report_delivery d WHERE d.tenant_id = p.tenant_id AND d.property_id = p.id AND d.status = 'FAILED' AND d.for_date BETWEEN ${c.from}::date AND ${c.to}::date)::int AS failed
      FROM property p WHERE p.tenant_id = ${c.tenantId} AND p.id = ANY(${c.ids}::uuid[]) ORDER BY p.name`.execute(c.trx);
    const rows: Row[] = r.rows.map((x): Row => { const score = x.jobs + x.cases + x.bills * 3 + x.unver + x.cashdiff + x.failed; return { prop: name(c, x.id), jobs: x.jobs, cases: x.cases, bills: x.bills, unver: x.unver, cashdiff: x.cashdiff, ooo: x.ooo, failed: x.failed, level: x.bills > 0 ? 'Check bills' : score === 0 ? 'Clear' : score <= 3 ? 'Some' : 'Needs attention' }; });
    const s = (k: string) => rows.reduce((t, x) => t + num(x[k]), 0);
    return { kpis: [{ key: 'n', label: 'Properties needing attention', value: rows.filter((x) => x.level !== 'Clear').length, type: 'int', tone: rows.some((x) => x.level === 'Needs attention' || x.level === 'Check bills') ? 'bad' : rows.some((x) => x.level !== 'Clear') ? 'warn' : 'ok', definition: 'Properties with at least one open item.' }, { key: 'jobs', label: 'Overdue jobs', value: s('jobs'), type: 'int', definition: 'Maintenance jobs past due.' }, { key: 'cases', label: 'Overdue cases', value: s('cases'), type: 'int', definition: 'Cases past their response target.' }, { key: 'bills', label: 'Bills not adding up', value: s('bills'), type: 'int', tone: s('bills') ? 'bad' : 'ok', definition: 'Stored balance differs from postings.' }],
      columns: [{ key: 'prop', label: 'Property' }, { key: 'jobs', label: 'Overdue jobs', type: 'int', total: true }, { key: 'cases', label: 'Overdue cases', type: 'int', total: true }, { key: 'bills', label: 'Bills not adding up', type: 'int', total: true }, { key: 'unver', label: 'Unverified payments', type: 'int', total: true }, { key: 'cashdiff', label: 'Cash differences', type: 'int', total: true }, { key: 'ooo', label: 'Rooms out of order', type: 'int', total: true }, { key: 'failed', label: 'Failed deliveries', type: 'int', total: true }, { key: 'level', label: 'State', type: 'badge' }], rows,
      notes: ['This is a list of counts, not a score from a model: “State” only reflects how many items are open.'] };
  },
};

export const PORTFOLIO: PDef[] = [flash, comparison, cash, mix, channels, risk];
export type { Col, Kpi };
