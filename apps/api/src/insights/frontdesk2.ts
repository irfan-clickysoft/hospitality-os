import { sql } from 'kysely';
import type { Def, Row } from './types.js';
import { dec, local, pctOf } from './util.js';

const ROOM = sql.raw(`(SELECT rm.number FROM room_assignment a JOIN room rm ON rm.id = a.room_id WHERE a.assignment_ref = l.id AND a.status IN ('IN_HOUSE','ASSIGNED') ORDER BY a.created_at DESC LIMIT 1)`);
/** The last room the line had, even after the guest left. */
const ROOM_EVER = sql.raw(`(SELECT rm.number FROM room_assignment a JOIN room rm ON rm.id = a.room_id WHERE a.assignment_ref = l.id ORDER BY a.created_at DESC LIMIT 1)`);
const SRC: Record<string, string> = { WALK_IN: 'Walk-in', PHONE: 'Phone', WHATSAPP: 'WhatsApp', WEBSITE: 'Website', OTA_BOOKING_COM: 'Booking.com', OTA_OTHER: 'Other OTA', CORPORATE: 'Corporate', TRAVEL_AGENT: 'Travel agent', CRS: 'Reservation system', OTHER: 'Other' };
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

export const inHouse: Def = {
  id: 'in-house', name: 'In-house guests and expected departures', category: 'frontdesk', kind: 'operational', permissions: ['reservation.view', 'report.view'], roles: ['frontdesk', 'manager', 'housekeeping'],
  purpose: 'Everyone staying now: room, nights left, balance, and who is due out today or is overdue to leave.',
  basis: [{ id: 'now', label: 'Right now' }], range: 'none',
  params: [{ key: 'view', label: 'Show', default: 'all', options: [{ value: 'all', label: 'All in-house' }, { value: 'dueout', label: 'Due out today' }, { value: 'overdue', label: 'Overdue to leave' }, { value: 'balance', label: 'With a balance to pay' }] }],
  definitions: [{ term: 'In house', text: 'Checked in and not yet checked out.' }, { term: 'Due out', text: 'Departure date is today.' }, { term: 'Overdue', text: 'Departure date has passed and the guest has not left.' }, { term: 'Balance', text: 'Open balance on the guest’s bill; a credit is shown as negative.' }],
  async run(c) {
    const bd = c.prop.businessDate;
    const r = await sql<Record<string, any>>`SELECT r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, g.vip, co.name AS company, l.arrival::text AS arrival, l.departure::text AS departure, l.adults, l.children, ${ROOM} AS room, rt.name AS rtype,
        coalesce((SELECT f.balance_minor FROM folio f WHERE f.tenant_id = r.tenant_id AND f.reservation_id = r.id AND f.folio_type = 'GUEST' AND f.status = 'OPEN' LIMIT 1), 0)::text AS bal, r.special_requests AS req
      FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id JOIN room_type rt ON rt.id = l.room_type_id LEFT JOIN company co ON co.tenant_id = r.tenant_id AND co.id = r.company_id
      WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.status = 'CHECKED_IN' ORDER BY l.departure, 5`.execute(c.trx);
    let rows: Row[] = r.rows.map((x): Row => ({ _res: x.rid, room: x.room ?? '', guest: x.guest, vip: x.vip ? 'VIP' : '', conf: x.conf, company: x.company ?? '', rtype: x.rtype, arrival: x.arrival, departure: x.departure, left: dayDiff(x.departure, bd), pax: `${x.adults}+${x.children}`, bal: x.bal, state: x.departure < bd ? 'Overdue' : x.departure === bd ? 'Due out' : 'Staying', req: x.req ?? '' }));
    const v = c.params.view ?? 'all'; if (v === 'dueout') rows = rows.filter((x) => x.state === 'Due out'); else if (v === 'overdue') rows = rows.filter((x) => x.state === 'Overdue'); else if (v === 'balance') rows = rows.filter((x) => BigInt(x.bal as string) > 0n);
    const n = (s: string) => rows.filter((x) => x.state === s).length;
    return { kpis: [{ key: 'n', label: 'In-house rooms', value: rows.length, type: 'int', definition: 'Rooms with a guest in the view.' }, { key: 'due', label: 'Due out today', value: n('Due out'), type: 'int', definition: 'Departing today.' }, { key: 'od', label: 'Overdue to leave', value: n('Overdue'), type: 'int', tone: n('Overdue') ? 'bad' : 'ok', definition: 'Past their departure date.' }, { key: 'bal', label: 'Owing', value: dec(rows.reduce((s, x) => s + (BigInt(x.bal as string) > 0n ? BigInt(x.bal as string) : 0n), 0n)), type: 'money', definition: 'Balances to pay.' }],
      columns: [{ key: 'room', label: 'Room' }, { key: 'guest', label: 'Guest' }, { key: 'vip', label: '', type: 'badge' }, { key: 'conf', label: 'Booking' }, { key: 'company', label: 'Company', hidden: true }, { key: 'rtype', label: 'Type', hidden: true }, { key: 'arrival', label: 'Arrived', type: 'date' }, { key: 'departure', label: 'Departure', type: 'date' }, { key: 'left', label: 'Nights left', type: 'int' }, { key: 'pax', label: 'Adults+children' }, { key: 'bal', label: 'Balance', type: 'money', total: true }, { key: 'state', label: 'State', type: 'badge' }, { key: 'req', label: 'Special requests', hidden: true }], rows };
  },
};

export const checkouts: Def = {
  id: 'checkouts', name: 'Checkouts, extensions and early departures', category: 'frontdesk', kind: 'operational', permissions: ['reservation.view', 'report.view'], roles: ['frontdesk', 'manager'],
  purpose: 'Guests who left in the period, and stays that were lengthened or cut short: original and actual departure, nights, and what was charged.',
  basis: [{ id: 'checkout', label: 'Business date of check-out' }], range: 'today',
  params: [{ key: 'view', label: 'Show', default: 'all', options: [{ value: 'all', label: 'All checkouts' }, { value: 'early', label: 'Left early' }, { value: 'late', label: 'Left after the booked date' }, { value: 'extended', label: 'Stay was extended' }, { value: 'shortened', label: 'Stay was shortened' }] }],
  definitions: [{ term: 'Left early', text: 'Checked out before the departure date the booking ended with.' }, { term: 'Left late', text: 'Checked out after it.' }, { term: 'Extended or shortened', text: 'The departure date was changed after booking. Compared with the original departure kept on the booking.' }, { term: 'Charged', text: 'Room total for the booking line, before tax.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, ${ROOM_EVER} AS room, l.arrival::text AS arrival, l.departure::text AS departure, l.original_departure::text AS orig, l.checked_out_business_date::text AS out, (l.departure - l.arrival)::int AS nights, l.total_minor::text AS total, ${local(sql.raw('l.checked_out_at'), c)} AS at
      FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id
      WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.status = 'CHECKED_OUT' AND l.checked_out_business_date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY l.checked_out_at DESC`.execute(c.trx);
    let rows: Row[] = r.rows.map((x): Row => ({ _res: x.rid, out: x.out, at: x.at, room: x.room ?? '', guest: x.guest, conf: x.conf, arrival: x.arrival, booked: x.orig ?? x.departure, departure: x.departure, nights: x.nights, total: x.total, how: x.out < x.departure ? 'Left early' : x.out > x.departure ? 'Left late' : 'On the day', change: x.orig && x.orig < x.departure ? 'Extended' : x.orig && x.orig > x.departure ? 'Shortened' : '' }));
    const v = c.params.view ?? 'all'; if (v === 'early') rows = rows.filter((x) => x.how === 'Left early'); else if (v === 'late') rows = rows.filter((x) => x.how === 'Left late'); else if (v === 'extended') rows = rows.filter((x) => x.change === 'Extended'); else if (v === 'shortened') rows = rows.filter((x) => x.change === 'Shortened');
    return { kpis: [{ key: 'n', label: 'Checkouts', value: rows.length, type: 'int', definition: 'Check-outs in the view.' }, { key: 'early', label: 'Left early', value: rows.filter((x) => x.how === 'Left early').length, type: 'int', definition: 'Before the departure date.' }, { key: 'ext', label: 'Extended stays', value: rows.filter((x) => x.change === 'Extended').length, type: 'int', definition: 'Stays lengthened after booking.' }, { key: 'sh', label: 'Shortened stays', value: rows.filter((x) => x.change === 'Shortened').length, type: 'int', definition: 'Stays cut short after booking.' }],
      columns: [{ key: 'out', label: 'Checked out', type: 'date' }, { key: 'at', label: 'Time', type: 'datetime', hidden: true }, { key: 'room', label: 'Room' }, { key: 'guest', label: 'Guest' }, { key: 'conf', label: 'Booking' }, { key: 'arrival', label: 'Arrived', type: 'date', hidden: true }, { key: 'booked', label: 'First booked until', type: 'date' }, { key: 'departure', label: 'Booked until', type: 'date' }, { key: 'nights', label: 'Nights', type: 'int', total: true }, { key: 'how', label: 'Left', type: 'badge' }, { key: 'change', label: 'Stay', type: 'badge' }, { key: 'total', label: 'Charged', type: 'money', total: true }], rows,
      notes: ['An early departure that was not changed on the booking shows as “Left early” with no “Shortened” mark.'] };
  },
};

export const walkIns: Def = {
  id: 'walk-ins', name: 'Walk-ins', category: 'frontdesk', kind: 'operational', permissions: ['reservation.view', 'report.view'], roles: ['frontdesk', 'manager'],
  purpose: 'Guests who arrived without a booking and were checked in on the spot: price charged against the standard price, who took them, and how many came.',
  basis: [{ id: 'created', label: 'Date the walk-in was entered' }], range: 'month',
  definitions: [{ term: 'Walk-in', text: 'A booking whose source is walk-in.' }, { term: 'Standard price', text: 'Room charges before any discount.' }, { term: 'Given up', text: 'Standard price minus what was charged: the negotiated discount.' }, { term: 'Conversion', text: 'Not available: the system does not record people who walked in and did not stay.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, ${ROOM_EVER} AS room, rt.name AS rtype, l.arrival::text AS arrival, (l.departure - l.arrival)::int AS nights, l.subtotal_minor::text AS std, l.total_minor::text AS total, l.discount_code AS code, u.full_name AS by, ${local(sql.raw('r.created_at'), c)} AS at
      FROM reservation r JOIN reservation_room l ON l.tenant_id = r.tenant_id AND l.reservation_id = r.id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id JOIN room_type rt ON rt.id = l.room_type_id LEFT JOIN staff_user u ON u.id = r.created_by
      WHERE r.tenant_id = ${c.tenantId} AND r.property_id = ${c.propertyId} AND r.source = 'WALK_IN' AND (r.created_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY r.created_at DESC`.execute(c.trx);
    const rows: Row[] = r.rows.map((x): Row => ({ _res: x.rid, at: x.at, guest: x.guest, conf: x.conf, room: x.room ?? '', rtype: x.rtype, nights: x.nights, std: x.std, total: x.total, given: (BigInt(x.std) - BigInt(x.total)).toString(), code: x.code ?? '', by: x.by ?? '' }));
    const s = (k: string) => rows.reduce((t, x) => t + BigInt(x[k] as string), 0n);
    return { kpis: [{ key: 'n', label: 'Walk-ins', value: rows.length, type: 'int', definition: 'Walk-in bookings in the period.' }, { key: 'rev', label: 'Charged', value: dec(s('total')), type: 'money', definition: 'Room revenue charged, before tax.' }, { key: 'given', label: 'Given up in discounts', value: dec(s('given')), type: 'money', definition: 'Standard price minus charged.' }, { key: 'pct', label: 'Discounted', value: pctOf(rows.filter((x) => BigInt(x.given as string) > 0n).length, rows.length), type: 'pct', definition: 'Share of walk-ins that got a discount.' }],
      columns: [{ key: 'at', label: 'Entered', type: 'datetime' }, { key: 'guest', label: 'Guest' }, { key: 'conf', label: 'Booking' }, { key: 'room', label: 'Room' }, { key: 'rtype', label: 'Type', hidden: true }, { key: 'nights', label: 'Nights', type: 'int', total: true }, { key: 'std', label: 'Standard price', type: 'money', total: true }, { key: 'total', label: 'Charged', type: 'money', total: true }, { key: 'given', label: 'Given up', type: 'money', total: true }, { key: 'code', label: 'Reason', hidden: true }, { key: 'by', label: 'Taken by' }], rows };
  },
};

export const unassigned: Def = {
  id: 'unassigned-rooms', name: 'Unassigned rooms', category: 'frontdesk', kind: 'operational', permissions: ['reservation.view', 'report.view'], roles: ['frontdesk', 'manager'],
  purpose: 'Confirmed bookings arriving soon that have no room chosen yet, soonest first.',
  basis: [{ id: 'arrival', label: 'Arrival date' }], range: 'next30',
  definitions: [{ term: 'Unassigned', text: 'Confirmed, with no room assigned to the booking line.' }, { term: 'Days to arrival', text: 'From the business date.' }],
  async run(c) {
    const bd = c.prop.businessDate;
    const r = await sql<Record<string, any>>`SELECT r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, rt.name AS rtype, l.arrival::text AS arrival, l.departure::text AS departure, l.adults, l.children, co.name AS company, to_char(r.expected_arrival, 'HH24:MI') AS eta
      FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id JOIN room_type rt ON rt.id = l.room_type_id LEFT JOIN company co ON co.tenant_id = r.tenant_id AND co.id = r.company_id
      WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.status = 'CONFIRMED' AND l.arrival BETWEEN ${c.from}::date AND ${c.to}::date AND NOT EXISTS (SELECT 1 FROM room_assignment a WHERE a.assignment_ref = l.id AND a.status IN ('ASSIGNED','IN_HOUSE')) ORDER BY l.arrival, r.expected_arrival NULLS LAST`.execute(c.trx);
    const rows: Row[] = r.rows.map((x): Row => ({ _res: x.rid, arrival: x.arrival, eta: x.eta ?? '', guest: x.guest, conf: x.conf, company: x.company ?? '', rtype: x.rtype, departure: x.departure, pax: `${x.adults}+${x.children}`, days: dayDiff(x.arrival, bd) }));
    return { kpis: [{ key: 'n', label: 'Unassigned', value: rows.length, type: 'int', tone: rows.some((x) => Number(x.days) <= 1) ? 'warn' : 'ok', definition: 'Bookings with no room.' }, { key: 'today', label: 'Arriving today or tomorrow', value: rows.filter((x) => Number(x.days) <= 1).length, type: 'int', definition: 'Most urgent.' }],
      columns: [{ key: 'arrival', label: 'Arrival', type: 'date' }, { key: 'eta', label: 'Expected', type: 'time' }, { key: 'days', label: 'Days to arrival', type: 'int' }, { key: 'guest', label: 'Guest' }, { key: 'conf', label: 'Booking' }, { key: 'company', label: 'Company', hidden: true }, { key: 'rtype', label: 'Room type' }, { key: 'departure', label: 'Departure', type: 'date', hidden: true }, { key: 'pax', label: 'Adults+children' }], rows };
  },
};

export const overbooking: Def = {
  id: 'overbooking-risk', name: 'Overbooking risk', category: 'frontdesk', kind: 'operational', permissions: ['reservation.view', 'report.view'], roles: ['frontdesk', 'manager'],
  purpose: 'Nights where bookings and holds use up the rooms of a type, or go over, so the desk can act before the guest arrives.',
  basis: [{ id: 'stay', label: 'Stay date' }], range: 'next30',
  params: [{ key: 'view', label: 'Show', default: 'tight', options: [{ value: 'tight', label: 'Full or over' }, { value: 'near', label: 'One room or fewer left' }, { value: 'all', label: 'Every night' }] }],
  definitions: [{ term: 'Sellable', text: 'Rooms of the type, less rooms out of order, out of service or blocked for a group.' }, { term: 'Used', text: 'Rooms booked plus unexpired holds.' }, { term: 'Left', text: 'Sellable minus used. Negative means overbooked. A permitted overbooking limit is shown apart and not counted as sellable.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT i.business_date::text AS d, rt.name AS rtype, i.physical, i.out_of_order AS ooo, i.out_of_service AS oos, i.blocked, i.reserved, i.held, i.overbook_limit AS lim
      FROM inventory_day i JOIN room_type rt ON rt.id = i.room_type_id WHERE i.tenant_id = ${c.tenantId} AND i.property_id = ${c.propertyId} AND i.business_date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY i.business_date, rt.name`.execute(c.trx);
    let rows: Row[] = r.rows.map((x): Row => { const sell = x.physical - x.ooo - x.oos - x.blocked; const used = x.reserved + x.held; const left = sell - used; return { d: x.d, rtype: x.rtype, sell, used, held: x.held, left, lim: x.lim, state: left < 0 ? 'Overbooked' : left === 0 ? 'Full' : left <= 1 ? 'Nearly full' : 'Open' }; });
    const v = c.params.view ?? 'tight'; if (v === 'tight') rows = rows.filter((x) => Number(x.left) <= 0); else if (v === 'near') rows = rows.filter((x) => Number(x.left) <= 1);
    return { kpis: [{ key: 'n', label: 'Nights in the view', value: rows.length, type: 'int', definition: 'Room-type nights listed.' }, { key: 'over', label: 'Overbooked', value: rows.filter((x) => x.state === 'Overbooked').length, type: 'int', tone: rows.some((x) => x.state === 'Overbooked') ? 'bad' : 'ok', definition: 'More used than sellable.' }, { key: 'full', label: 'Full', value: rows.filter((x) => x.state === 'Full').length, type: 'int', definition: 'Nothing left.' }],
      columns: [{ key: 'd', label: 'Night', type: 'date' }, { key: 'rtype', label: 'Room type' }, { key: 'sell', label: 'Sellable', type: 'int' }, { key: 'used', label: 'Used', type: 'int' }, { key: 'held', label: 'Of which holds', type: 'int', hidden: true }, { key: 'left', label: 'Left', type: 'int' }, { key: 'lim', label: 'Allowed over', type: 'int', hidden: true }, { key: 'state', label: 'State', type: 'badge' }], rows, notes: ['Demand that was turned away is not recorded, so lost business is not shown.'] };
  },
};

export const guarantees: Def = {
  id: 'missing-guarantees', name: 'Missing deposits and guarantees', category: 'frontdesk', kind: 'operational', permissions: ['reservation.view', 'report.view'], roles: ['frontdesk', 'manager', 'accounts'],
  purpose: 'Bookings whose deposit has not been paid or whose guarantee has not been secured, with the deadline and how close arrival is.',
  basis: [{ id: 'arrival', label: 'Arrival date' }], range: 'next30',
  definitions: [{ term: 'Deposit due', text: 'Deposit required minus deposit paid.' }, { term: 'At risk', text: 'The booking has passed or is near its guarantee deadline without the guarantee, and may be released.' }, { term: 'Guarantee', text: 'None, deposit, card, company or OTA prepaid.' }],
  async run(c) {
    const bd = c.prop.businessDate;
    const r = await sql<Record<string, any>>`SELECT r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, r.source, r.guarantee_type AS gt, r.at_risk AS risk, r.deposit_required_minor::text AS req, r.deposit_paid_minor::text AS paid, ${local(sql.raw('r.guarantee_deadline'), c)} AS dl, min(l.arrival)::text AS arrival
      FROM reservation r JOIN reservation_room l ON l.tenant_id = r.tenant_id AND l.reservation_id = r.id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id
      WHERE r.tenant_id = ${c.tenantId} AND r.property_id = ${c.propertyId} AND l.status = 'CONFIRMED' AND (r.deposit_paid_minor < r.deposit_required_minor OR r.at_risk) GROUP BY r.tenant_id, r.id, g.full_name HAVING min(l.arrival) BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY min(l.arrival)`.execute(c.trx);
    const G: Record<string, string> = { NONE: 'None', DEPOSIT: 'Deposit', CARD: 'Card', COMPANY: 'Company', OTA_PREPAID: 'OTA prepaid' };
    const rows: Row[] = r.rows.map((x): Row => ({ _res: x.rid, arrival: x.arrival, days: dayDiff(x.arrival, bd), guest: x.guest, conf: x.conf, source: SRC[x.source] ?? x.source, guar: G[x.gt] ?? x.gt, req: x.req, paid: x.paid, due: (BigInt(x.req) - BigInt(x.paid)).toString(), dl: x.dl ?? '', risk: x.risk ? 'At risk' : '' }));
    return { kpis: [{ key: 'n', label: 'Bookings', value: rows.length, type: 'int', definition: 'Bookings missing a deposit or guarantee.' }, { key: 'due', label: 'Deposits due', value: dec(rows.reduce((s, x) => s + (BigInt(x.due as string) > 0n ? BigInt(x.due as string) : 0n), 0n)), type: 'money', definition: 'Required minus paid.' }, { key: 'risk', label: 'At risk', value: rows.filter((x) => x.risk).length, type: 'int', tone: rows.some((x) => x.risk) ? 'warn' : 'ok', definition: 'May be released.' }],
      columns: [{ key: 'arrival', label: 'Arrival', type: 'date' }, { key: 'days', label: 'Days to arrival', type: 'int' }, { key: 'guest', label: 'Guest' }, { key: 'conf', label: 'Booking' }, { key: 'source', label: 'Source', hidden: true }, { key: 'guar', label: 'Guarantee' }, { key: 'req', label: 'Deposit required', type: 'money', total: true }, { key: 'paid', label: 'Paid', type: 'money', total: true }, { key: 'due', label: 'Still due', type: 'money', total: true }, { key: 'dl', label: 'Deadline', type: 'datetime' }, { key: 'risk', label: '', type: 'badge' }], rows };
  },
};

export const rooming: Def = {
  id: 'rooming-list', name: 'Group rooming lists', category: 'frontdesk', kind: 'operational', permissions: ['reservation.view', 'report.view'], roles: ['frontdesk', 'manager'],
  purpose: 'Bookings with two or more rooms: every room line, its guest count, dates and the room chosen, so a group can be checked in room by room.',
  basis: [{ id: 'arrival', label: 'Arrival date' }], range: 'next30',
  definitions: [{ term: 'Group', text: 'A booking with two or more room lines. Group blocks and allotments are not recorded separately.' }, { term: 'Room', text: 'The room chosen for that line, if any.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT r.id AS rid, r.confirmation_no AS conf, g.full_name AS lead, co.name AS company, l.line_no AS line, rt.name AS rtype, l.arrival::text AS arrival, l.departure::text AS departure, l.adults, l.children, l.status, ${ROOM} AS room, (count(*) OVER (PARTITION BY r.id))::int AS rooms
      FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id JOIN room_type rt ON rt.id = l.room_type_id LEFT JOIN company co ON co.tenant_id = r.tenant_id AND co.id = r.company_id
      WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.status NOT IN ('CANCELLED','NO_SHOW') AND l.arrival BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY r.confirmation_no, l.line_no`.execute(c.trx);
    const ST: Record<string, string> = { OPTION: 'Tentative', CONFIRMED: 'Confirmed', CHECKED_IN: 'In house', CHECKED_OUT: 'Left' };
    const rows: Row[] = r.rows.filter((x) => x.rooms >= 2).map((x): Row => ({ _res: x.rid, conf: x.conf, lead: x.lead, company: x.company ?? '', line: x.line, rtype: x.rtype, room: x.room ?? '', arrival: x.arrival, departure: x.departure, pax: `${x.adults}+${x.children}`, status: ST[x.status] ?? x.status }));
    return { kpis: [{ key: 'g', label: 'Group bookings', value: new Set(rows.map((x) => x.conf)).size, type: 'int', definition: 'Bookings with two or more rooms.' }, { key: 'r', label: 'Rooms', value: rows.length, type: 'int', definition: 'Room lines across them.' }, { key: 'u', label: 'Rooms not chosen yet', value: rows.filter((x) => !x.room && x.status !== 'Left').length, type: 'int', tone: rows.some((x) => !x.room && x.status === 'Confirmed') ? 'warn' : 'ok', definition: 'Room lines with no room.' }],
      columns: [{ key: 'conf', label: 'Booking' }, { key: 'lead', label: 'Lead guest' }, { key: 'company', label: 'Company', hidden: true }, { key: 'line', label: 'Line', type: 'int' }, { key: 'rtype', label: 'Room type' }, { key: 'room', label: 'Room' }, { key: 'arrival', label: 'Arrival', type: 'date' }, { key: 'departure', label: 'Departure', type: 'date' }, { key: 'pax', label: 'Adults+children' }, { key: 'status', label: 'Status', type: 'badge' }], rows };
  },
};

export const idCompliance: Def = {
  id: 'id-compliance', name: 'Guest identification compliance', category: 'frontdesk', kind: 'audit', permissions: ['reservation.view', 'report.view'], roles: ['frontdesk', 'manager'],
  purpose: 'Guests in the house or checking in with an ID missing, an expired document, or no signature on the registration card.',
  basis: [{ id: 'stay', label: 'In house or arriving in the period' }], range: 'today',
  params: [{ key: 'view', label: 'Show', default: 'problems', options: [{ value: 'problems', label: 'Problems only' }, { value: 'all', label: 'Every adult' }] }],
  definitions: [{ term: 'ID missing', text: 'An adult staying with no identity document type or number recorded.' }, { term: 'Expired', text: 'The document’s expiry date is before the business date.' }, { term: 'Unsigned', text: 'The registration card has no signature (on screen or on paper recorded).' }, { term: 'Children', text: 'Children are not required to have an ID and are left out.' }],
  async run(c) {
    const bd = c.prop.businessDate;
    const r = await sql<Record<string, any>>`SELECT r.id AS rid, r.confirmation_no AS conf, ${ROOM} AS room, s.full_name AS guest, s.is_primary AS prim, s.id_type, s.id_last4, s.id_expiry::text AS exp, s.nationality, l.reg_signed_at IS NOT NULL OR l.reg_signature IS NOT NULL AS signed, l.status
      FROM stay_guest s JOIN reservation_room l ON l.tenant_id = s.tenant_id AND l.id = s.reservation_room_id JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id
      WHERE s.tenant_id = ${c.tenantId} AND s.property_id = ${c.propertyId} AND s.voided_at IS NULL AND s.age_group = 'ADULT' AND (l.status = 'CHECKED_IN' OR (l.status IN ('CHECKED_OUT') AND l.checked_out_business_date BETWEEN ${c.from}::date AND ${c.to}::date)) ORDER BY 3, s.is_primary DESC`.execute(c.trx);
    let rows: Row[] = r.rows.map((x): Row => { const missing = !x.id_type || !x.id_last4; const expired = !!x.exp && x.exp < bd; const unsigned = x.prim && !x.signed; const issues = [missing ? 'ID missing' : '', expired ? 'Expired' : '', unsigned ? 'Unsigned' : ''].filter(Boolean).join(', ');
      return { _res: x.rid, room: x.room ?? '', guest: x.guest, conf: x.conf, who: x.prim ? 'Main guest' : 'Companion', idt: x.id_type ?? '', last4: x.id_last4 ? `…${x.id_last4}` : '', exp: x.exp ?? '', nat: x.nationality ?? '', status: x.status === 'CHECKED_IN' ? 'In house' : 'Left', issue: issues || 'OK' }; });
    if ((c.params.view ?? 'problems') === 'problems') rows = rows.filter((x) => x.issue !== 'OK');
    return { kpis: [{ key: 'n', label: 'Adults checked', value: r.rows.length, type: 'int', definition: 'Adults in the house, or who left in the period.' }, { key: 'bad', label: 'With a problem', value: r.rows.filter((x) => !x.id_type || !x.id_last4 || (x.exp && x.exp < bd) || (x.prim && !x.signed)).length, type: 'int', tone: rows.length ? 'bad' : 'ok', definition: 'Missing ID, expired document or unsigned card.' }],
      columns: [{ key: 'room', label: 'Room' }, { key: 'guest', label: 'Guest' }, { key: 'who', label: 'Role' }, { key: 'conf', label: 'Booking' }, { key: 'idt', label: 'ID type' }, { key: 'last4', label: 'ID (last digits)' }, { key: 'exp', label: 'Expires', type: 'date', hidden: true }, { key: 'nat', label: 'Nationality', hidden: true }, { key: 'status', label: 'Stay', type: 'badge' }, { key: 'issue', label: 'Issue', type: 'badge' }], rows,
      notes: ['Only the last digits of an ID are shown here. Government guest reporting status is not recorded, so it is not shown.'] };
  },
};
