import { sql, type RawBuilder } from 'kysely';
import type { Ctx, Def, Row } from './types.js';
import { dec, pctOf } from './util.js';

const SRC: Record<string, string> = { WALK_IN: 'Walk-in', PHONE: 'Phone', WHATSAPP: 'WhatsApp', WEBSITE: 'Website', OTA_BOOKING_COM: 'Booking.com', OTA_OTHER: 'Other OTA', CORPORATE: 'Corporate', TRAVEL_AGENT: 'Travel agent', CRS: 'Reservation system', OTHER: 'Other' };
const FROM = sql`stay_night n JOIN reservation_room l ON l.tenant_id = n.tenant_id AND l.id = n.reservation_room_id JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN room_type rt ON rt.id = l.room_type_id JOIN rate_plan rp ON rp.id = l.rate_plan_id LEFT JOIN company co ON co.tenant_id = r.tenant_id AND co.id = r.company_id`;
const LFROM = sql`reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN room_type rt ON rt.id = l.room_type_id JOIN rate_plan rp ON rp.id = l.rate_plan_id LEFT JOIN company co ON co.tenant_id = r.tenant_id AND co.id = r.company_id`;

interface Dim { id: string; name: string; purpose: string; label: string; expr: RawBuilder<unknown>; fix?: (v: string) => string; sort?: 'revenue' | 'key' }

/** Stay nights, revenue and cancellations grouped by one thing about the booking. Revenue is room revenue on the books for the stay dates chosen, before tax. */
function performance(d: Dim): Def {
  return {
    id: d.id, name: d.name, category: 'sales', kind: 'analytical', permissions: ['report.view', 'management.view'], roles: ['manager', 'accounts'],
    purpose: d.purpose, basis: [{ id: 'stay', label: 'Stay date' }], range: 'month',
    definitions: [
      { term: 'Room nights', text: 'Confirmed, in-house and checked-out nights with a stay date in the period.' }, { term: 'Room revenue', text: 'Room charges for those nights as booked, before tax. Not cash collected and not a forecast.' },
      { term: 'ADR', text: 'Room revenue ÷ room nights.' }, { term: 'Share', text: 'This row’s share of all room revenue in the period.' }, { term: 'Cancelled or no-show', text: 'Booking lines with an arrival in the period that were cancelled or did not arrive.' }, { term: 'Cancel rate', text: 'Cancelled or no-show lines ÷ (those + lines that stayed or are still booked) with an arrival in the period.' },
    ],
    async run(c: Ctx) {
      const a = await sql<Record<string, any>>`SELECT ${d.expr} AS k, count(DISTINCT l.id)::int AS lines, count(*)::int AS nights, coalesce(sum(n.total_minor), 0)::text AS rev
        FROM ${FROM} WHERE n.tenant_id = ${c.tenantId} AND n.property_id = ${c.propertyId} AND n.business_date BETWEEN ${c.from}::date AND ${c.to}::date AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT') GROUP BY 1`.execute(c.trx);
      const b = await sql<Record<string, any>>`SELECT ${d.expr} AS k, count(*) FILTER (WHERE l.status IN ('CANCELLED','NO_SHOW'))::int AS lost, count(*) FILTER (WHERE l.status <> 'OPTION')::int AS all_lines
        FROM ${LFROM} WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.arrival BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY 1`.execute(c.trx);
      const m = new Map<string, { lines: number; nights: number; rev: bigint; lost: number; all: number }>(); const key = (v: unknown) => (d.fix ?? ((x) => x))(String(v ?? '')) || 'Not recorded';
      for (const x of a.rows) { const k = key(x.k); const e = m.get(k) ?? { lines: 0, nights: 0, rev: 0n, lost: 0, all: 0 }; e.lines += x.lines; e.nights += x.nights; e.rev += BigInt(x.rev); m.set(k, e); }
      for (const x of b.rows) { const k = key(x.k); const e = m.get(k) ?? { lines: 0, nights: 0, rev: 0n, lost: 0, all: 0 }; e.lost += x.lost; e.all += x.all_lines; m.set(k, e); }
      const total = [...m.values()].reduce((s, e) => s + e.rev, 0n); const tn = [...m.values()].reduce((s, e) => s + e.nights, 0); const tl = [...m.values()].reduce((s, e) => s + e.lost, 0); const ta = [...m.values()].reduce((s, e) => s + e.all, 0);
      const rows: Row[] = [...m.entries()].sort((p, q) => (p[1].rev < q[1].rev ? 1 : p[1].rev > q[1].rev ? -1 : p[0].localeCompare(q[0]))).map(([k, e]) => ({ what: k, lines: e.lines, nights: e.nights, rev: e.rev.toString(), adr: e.nights ? (e.rev / BigInt(e.nights)).toString() : '0', share: total > 0n ? Math.round(Number((e.rev * 1000n) / total)) / 10 : 0, lost: e.lost, cancel: pctOf(e.lost, e.all) }));
      return { kpis: [{ key: 'rev', label: 'Room revenue', value: dec(total), type: 'money', definition: 'Room revenue for the stay dates, before tax.' }, { key: 'nights', label: 'Room nights', value: tn, type: 'int', definition: 'Nights sold in the period.' }, { key: 'adr', label: 'ADR', value: tn ? dec(total / BigInt(tn)) : '0.00', type: 'money', definition: 'Room revenue ÷ room nights.' }, { key: 'cancel', label: 'Cancel rate', value: pctOf(tl, ta), type: 'pct', definition: 'Cancelled or no-show lines ÷ lines with an arrival in the period.' }],
        columns: [{ key: 'what', label: d.label }, { key: 'lines', label: 'Bookings', type: 'int', total: true }, { key: 'nights', label: 'Room nights', type: 'int', total: true }, { key: 'rev', label: 'Room revenue', type: 'money', total: true }, { key: 'adr', label: 'ADR', type: 'money' }, { key: 'share', label: 'Share of revenue', type: 'pct' }, { key: 'lost', label: 'Cancelled or no-show', type: 'int', total: true }, { key: 'cancel', label: 'Cancel rate', type: 'pct' }],
        rows, chart: { kind: 'bar', x: 'what', series: [{ key: 'rev', label: 'Room revenue' }] }, notes: ['Room revenue only: extras, food and beverage and tax are not included. Channel commission and net revenue are not recorded yet.'] };
    },
  };
}

export const channel = performance({ id: 'channel-performance', name: 'Booking source and channel performance', label: 'Source', purpose: 'Where bookings come from: phone, walk-in, website, agents and online travel agencies, with nights, revenue, ADR and cancellations.', expr: sql`r.source`, fix: (v) => SRC[v] ?? v });
export const segment = performance({ id: 'segment-performance', name: 'Market-segment performance', label: 'Market segment', purpose: 'Room nights and revenue by market segment, where one was recorded on the booking.', expr: sql`r.market_segment` });
export const corporate = performance({ id: 'corporate-production', name: 'Corporate-account production', label: 'Company', purpose: 'Room nights, revenue and cancellations by company. Bookings with no company are shown as “Not recorded”.', expr: sql`co.name` });
export const roomType = performance({ id: 'roomtype-performance', name: 'Room-type performance', label: 'Room type', purpose: 'Which room types sell, at what average price, and how many are cancelled.', expr: sql`rt.name` });
export const ratePlan = performance({ id: 'rateplan-performance', name: 'Rate-plan performance', label: 'Rate plan', purpose: 'Nights, revenue and ADR by rate plan.', expr: sql`rp.name` });

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const bucket = (n: number, edges: number[], labels: string[]) => { const i = edges.findIndex((e) => n <= e); return labels[i < 0 ? labels.length - 1 : i]!; };

/** How guests book and stay: how far ahead, how long, and which days. */
export const behaviour: Def = {
  id: 'booking-behaviour', name: 'Booking window, length of stay and day of week', category: 'sales', kind: 'analytical', permissions: ['report.view', 'management.view'], roles: ['manager', 'accounts'],
  purpose: 'How far ahead guests book, how long they stay, and which days of the week sell, with nights, revenue and ADR.',
  basis: [{ id: 'stay', label: 'Arrival date' }], range: 'month',
  params: [{ key: 'group', label: 'Show', default: 'window', options: [{ value: 'window', label: 'Booking window' }, { value: 'los', label: 'Length of stay' }, { value: 'dow', label: 'Day of week (stay date)' }] }],
  definitions: [{ term: 'Booking window', text: 'Days between the day the booking was made and the arrival date.' }, { term: 'Length of stay', text: 'Nights on the booking line.' }, { term: 'Day of week', text: 'Each night sold, by the day of the week it falls on.' }, { term: 'Revenue', text: 'Room revenue as booked, before tax. Cancelled lines are left out.' }],
  async run(c) {
    const by = c.params.group ?? 'window'; const tz = c.prop.timezone.replace(/[^A-Za-z_\/+-]/g, '');
    let items: Array<{ k: string; order: number; lines: number; nights: number; rev: bigint }> = [];
    if (by === 'dow') {
      const r = await sql<Record<string, any>>`SELECT extract(dow FROM n.business_date)::int AS d, count(*)::int AS nights, count(DISTINCT l.id)::int AS lines, coalesce(sum(n.total_minor),0)::text AS rev FROM stay_night n JOIN reservation_room l ON l.tenant_id = n.tenant_id AND l.id = n.reservation_room_id WHERE n.tenant_id = ${c.tenantId} AND n.property_id = ${c.propertyId} AND n.business_date BETWEEN ${c.from}::date AND ${c.to}::date AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT') GROUP BY 1`.execute(c.trx);
      items = r.rows.map((x) => ({ k: DOW[x.d]!, order: x.d, lines: x.lines, nights: x.nights, rev: BigInt(x.rev) }));
    } else {
      const r = await sql<Record<string, any>>`SELECT (l.arrival - (r.created_at AT TIME ZONE ${tz})::date)::int AS lead, (l.departure - l.arrival)::int AS los, l.total_minor::text AS rev FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.arrival BETWEEN ${c.from}::date AND ${c.to}::date AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT')`.execute(c.trx);
      const labels = by === 'window' ? ['Same day', '1–3 days', '4–7 days', '8–14 days', '15–30 days', '31–60 days', 'Over 60 days'] : ['1 night', '2 nights', '3 nights', '4–6 nights', '7–13 nights', '14–29 nights', '30 nights or more'];
      const edges = by === 'window' ? [0, 3, 7, 14, 30, 60] : [1, 2, 3, 6, 13, 29]; const map = new Map<string, { lines: number; nights: number; rev: bigint }>();
      for (const x of r.rows) { const k = bucket(by === 'window' ? Math.max(0, x.lead) : x.los, edges, labels); const e = map.get(k) ?? { lines: 0, nights: 0, rev: 0n }; e.lines++; e.nights += x.los; e.rev += BigInt(x.rev); map.set(k, e); }
      items = labels.filter((l) => map.has(l)).map((l) => ({ k: l, order: labels.indexOf(l), ...map.get(l)! }));
    }
    items.sort((a, b) => a.order - b.order);
    const rows: Row[] = items.map((x) => ({ what: x.k, lines: x.lines, nights: x.nights, rev: x.rev.toString(), adr: x.nights ? (x.rev / BigInt(x.nights)).toString() : '0' }));
    const tn = items.reduce((s, x) => s + x.nights, 0); const tr = items.reduce((s, x) => s + x.rev, 0n); const tl = items.reduce((s, x) => s + x.lines, 0);
    const avg = by === 'los' && tl ? { key: 'avg', label: 'Average stay (nights)', value: Math.round((tn / tl) * 10) / 10, type: 'int' as const, definition: 'Room nights ÷ bookings.' } : null;
    return { kpis: [{ key: 'lines', label: 'Bookings', value: tl, type: 'int', definition: 'Booking lines in the view.' }, { key: 'nights', label: 'Room nights', value: tn, type: 'int', definition: 'Nights sold.' }, { key: 'rev', label: 'Room revenue', value: dec(tr), type: 'money', definition: 'Room revenue as booked, before tax.' }, ...(avg ? [avg] : [])],
      columns: [{ key: 'what', label: by === 'window' ? 'Booked ahead' : by === 'los' ? 'Length of stay' : 'Day of week' }, { key: 'lines', label: 'Bookings', type: 'int', total: true }, { key: 'nights', label: 'Room nights', type: 'int', total: true }, { key: 'rev', label: 'Room revenue', type: 'money', total: true }, { key: 'adr', label: 'ADR', type: 'money' }],
      rows, chart: { kind: 'bar', x: 'what', series: [{ key: 'nights', label: 'Room nights' }] }, notes: by === 'dow' ? ['Each night sold counts on the day it falls.'] : ['Booking lines with an arrival in the period. Revenue is the line total as booked.'] };
  },
};

/** Holds that are not confirmed yet: who, for when, how much, and when they lapse. */
export const tentative: Def = {
  id: 'tentative-bookings', name: 'Tentative bookings', category: 'sales', kind: 'operational', permissions: ['report.view', 'reservation.view'], roles: ['manager', 'frontdesk'],
  purpose: 'Bookings held without confirmation: guest, dates, value and when the hold runs out, so they can be confirmed or released.',
  basis: [{ id: 'arrival', label: 'Arrival date' }], range: 'next30',
  definitions: [{ term: 'Tentative', text: 'A hold that is not confirmed. It reserves the room but is never counted as on the books.' }, { term: 'Lapses', text: 'When the hold is released automatically if nobody confirms it.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, co.name AS company, r.source, rt.name AS rtype, l.arrival::text AS arrival, l.departure::text AS departure, (l.departure - l.arrival)::int AS nights, l.total_minor::text AS val,
        to_char(r.option_expires_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI') AS lapses, (r.option_expires_at < now()) AS late
      FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id JOIN room_type rt ON rt.id = l.room_type_id LEFT JOIN company co ON co.tenant_id = r.tenant_id AND co.id = r.company_id
      WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.status = 'OPTION' AND l.arrival BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY r.option_expires_at NULLS LAST, l.arrival`.execute(c.trx);
    const rows: Row[] = r.rows.map((x): Row => ({ _res: x.rid, conf: x.conf, guest: x.guest, company: x.company ?? '', source: SRC[x.source] ?? x.source, rtype: x.rtype, arrival: x.arrival, departure: x.departure, nights: x.nights, val: x.val, lapses: x.lapses ?? '', state: x.late ? 'Past its time' : x.lapses ? 'Holding' : 'No time limit' }));
    const tv = rows.reduce((s, x) => s + BigInt(x.val as string), 0n); const late = rows.filter((x) => x.state === 'Past its time').length;
    return { kpis: [{ key: 'n', label: 'Tentative bookings', value: rows.length, type: 'int', definition: 'Holds with an arrival in the period.' }, { key: 'val', label: 'Value held', value: dec(tv), type: 'money', definition: 'Room value of the holds, before tax. Not on the books.' }, { key: 'late', label: 'Past their time', value: late, type: 'int', tone: late ? 'warn' : 'ok', definition: 'Holds whose time has passed and have not been released yet.' }],
      columns: [{ key: 'conf', label: 'Booking' }, { key: 'guest', label: 'Guest' }, { key: 'company', label: 'Company', hidden: true }, { key: 'source', label: 'Source', hidden: true }, { key: 'rtype', label: 'Room type' }, { key: 'arrival', label: 'Arrival', type: 'date' }, { key: 'departure', label: 'Departure', type: 'date', hidden: true }, { key: 'nights', label: 'Nights', type: 'int', total: true }, { key: 'val', label: 'Value', type: 'money', total: true }, { key: 'lapses', label: 'Lapses', type: 'datetime' }, { key: 'state', label: 'State', type: 'badge' }], rows };
  },
};
