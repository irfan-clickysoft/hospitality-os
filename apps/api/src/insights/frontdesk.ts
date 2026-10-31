import { sql } from 'kysely';
import type { Def, Result, Row } from './types.js';
import { ROOM_OF, dec, pctOf } from './util.js';
import { LABELS, type CancelCode } from '../reservations/cancel-reasons.js';
const INIT: Record<string, string> = { GUEST: 'Guest', PROPERTY: 'Property', CHANNEL: 'Booking channel', COMPANY: 'Company', SYSTEM: 'System' };

const REG = sql.raw(`(SELECT count(*) FROM stay_guest s WHERE s.reservation_room_id = l.id AND s.voided_at IS NULL)`);
const REG_ID = sql.raw(`(SELECT count(*) FROM stay_guest s WHERE s.reservation_room_id = l.id AND s.voided_at IS NULL AND s.id_hash IS NOT NULL)`);
const BAL = sql.raw(`(SELECT f.balance_minor FROM folio f WHERE f.reservation_id = r.id AND f.folio_type = 'GUEST' AND f.status <> 'VOID' LIMIT 1)`);
const BY = (status: string) => sql.raw(`(SELECT u.full_name FROM reservation_history h JOIN staff_user u ON u.id = h.actor_id WHERE h.reservation_room_id = l.id AND h.to_status = '${status}' ORDER BY h.occurred_at DESC LIMIT 1)`);
const FROM_JOIN = sql.raw(`reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id JOIN room_type rt ON rt.id = l.room_type_id JOIN rate_plan rp ON rp.id = l.rate_plan_id`);
const regState = (people: number, ids: number) => (people === 0 ? 'Not registered' : ids > 0 ? 'ID recorded' : 'ID missing');

export const checkins: Def = {
  id: 'checkins', name: 'Completed check-ins', category: 'frontdesk', kind: 'operational', permissions: ['reservation.view'], roles: ['frontdesk', 'manager'],
  purpose: 'Every guest who has actually checked in, with when, where, who did it, and what is still owed or missing.',
  basis: [{ id: 'checkin', label: 'Business date of check-in' }, { id: 'arrival', label: 'Arrival date' }], range: 'today',
  definitions: [{ term: 'Early check-in', text: 'Checked in on the arrival date before the property’s standard check-in time.' }, { term: 'Outstanding', text: 'The balance on the guest’s bill when the report was generated.' }, { term: 'Expected arrivals', text: 'Not shown here; see the Expected arrivals report.' }],
  async run(c) {
    const col = c.basis === 'arrival' ? sql.raw('l.arrival') : sql.raw('l.checked_in_business_date');
    const r = await sql<Record<string, any>>`SELECT l.id AS lid, r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, ${ROOM_OF} AS room, rt.name AS type, rp.name AS plan, l.arrival::text AS arrival, l.departure::text AS departure, l.adults, l.children,
        r.source, r.market_segment AS seg, to_char(l.checked_in_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI') AS at, l.checked_in_business_date::text AS bd, to_char(r.expected_arrival, 'HH24:MI') AS eta,
        (l.arrival = l.checked_in_business_date AND (l.checked_in_at AT TIME ZONE ${c.prop.timezone})::time < ${c.prop.checkIn}::time) AS early,
        floor(extract(epoch FROM (${c.prop.checkIn}::time - (l.checked_in_at AT TIME ZONE ${c.prop.timezone})::time)) / 60)::int AS early_min,
        r.deposit_paid_minor::text AS dep, coalesce(${BAL}, 0)::text AS bal, ${REG} AS people, ${REG_ID} AS ids, ${BY('CHECKED_IN')} AS by
      FROM ${FROM_JOIN} WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.checked_in_at IS NOT NULL AND ${col} BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY l.checked_in_at DESC`.execute(c.trx);
    const rows: Row[] = r.rows.map((x) => ({ _res: x.rid, at: x.at, conf: x.conf, guest: x.guest, room: x.room, type: x.type, arrival: x.arrival, departure: x.departure, eta: x.eta, adults: x.adults, children: x.children, source: x.source, segment: x.seg, plan: x.plan,
      deposit: x.dep, balance: x.bal, registration: regState(Number(x.people), Number(x.ids)), early: x.early ? `Early (${Math.max(0, x.early_min)} min)` : '', by: x.by, bd: x.bd }));
    const early = rows.filter((x) => x.early).length; const noId = rows.filter((x) => x.registration !== 'ID recorded').length; const owing = rows.filter((x) => BigInt(x.balance as string) > 0n).length;
    return { kpis: [{ key: 'n', label: 'Checked in', value: rows.length, type: 'int', definition: 'Room lines checked in within the period.' }, { key: 'early', label: 'Early check-ins', value: early, type: 'int', definition: 'Before the standard check-in time on the arrival date.' },
        { key: 'noid', label: 'Registration gaps', value: noId, type: 'int', tone: noId ? 'warn' : 'ok', definition: 'Lines where no guest has an ID recorded.' }, { key: 'owing', label: 'With a balance owing', value: owing, type: 'int', definition: 'Bills with a balance above zero now.' }],
      columns: [{ key: 'at', label: 'Checked in', type: 'datetime' }, { key: 'conf', label: 'Booking' }, { key: 'guest', label: 'Guest' }, { key: 'room', label: 'Room' }, { key: 'type', label: 'Room type', hidden: true }, { key: 'arrival', label: 'Arrival', type: 'date' }, { key: 'departure', label: 'Departure', type: 'date' },
        { key: 'eta', label: 'Expected at', type: 'time', hidden: true }, { key: 'adults', label: 'Adults', type: 'int', total: true, hidden: true }, { key: 'children', label: 'Children', type: 'int', total: true, hidden: true }, { key: 'source', label: 'Source' }, { key: 'segment', label: 'Segment', hidden: true }, { key: 'plan', label: 'Rate plan', hidden: true },
        { key: 'deposit', label: 'Deposit paid', type: 'money', total: true }, { key: 'balance', label: 'Balance owing', type: 'money', total: true }, { key: 'registration', label: 'Registration', type: 'badge' }, { key: 'early', label: 'Early', type: 'badge' }, { key: 'by', label: 'Checked in by' }],
      rows, notes: ['Early-check-in fees and waivers are not recorded by the system yet, so no fee column is shown.'] };
  },
};

export const expectedArrivals: Def = {
  id: 'expected-arrivals', name: 'Expected arrivals', category: 'frontdesk', kind: 'operational', permissions: ['reservation.view'], roles: ['frontdesk', 'manager', 'housekeeping'],
  purpose: 'Guests due to arrive and not yet checked in, with what must be sorted before they walk in.',
  basis: [{ id: 'arrival', label: 'Arrival date' }], range: 'today',
  definitions: [{ term: 'Unassigned', text: 'No room is assigned to the line yet.' }, { term: 'Deposit gap', text: 'A deposit is required and what was paid is less.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, g.vip, ${ROOM_OF} AS room, rt.name AS type, rp.name AS plan, l.arrival::text AS arrival, l.departure::text AS departure, l.adults, l.children, r.source, r.market_segment AS seg,
        to_char(r.expected_arrival, 'HH24:MI') AS eta, r.deposit_required_minor::text AS dep_req, r.deposit_paid_minor::text AS dep, r.at_risk, l.status
      FROM ${FROM_JOIN} WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.status IN ('CONFIRMED','OPTION') AND l.arrival BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY l.arrival, r.expected_arrival NULLS LAST, g.full_name`.execute(c.trx);
    const rows: Row[] = r.rows.map((x) => ({ _res: x.rid, arrival: x.arrival, eta: x.eta, conf: x.conf, guest: `${x.guest}${x.vip ? ' ★' : ''}`, room: x.room ?? '', type: x.type, departure: x.departure, adults: x.adults, children: x.children, source: x.source, segment: x.seg, plan: x.plan,
      depositDue: x.dep_req, deposit: x.dep, flag: x.status === 'OPTION' ? 'Tentative' : x.at_risk ? 'Guarantee at risk' : BigInt(x.dep_req) > BigInt(x.dep) ? 'Deposit gap' : !x.room ? 'No room' : '' }));
    return { kpis: [{ key: 'n', label: 'Expected', value: rows.length, type: 'int', definition: 'Confirmed and tentative lines arriving in the period, not yet checked in.' }, { key: 'noroom', label: 'No room yet', value: rows.filter((x) => !x.room).length, type: 'int', tone: rows.some((x) => !x.room) ? 'warn' : 'ok', definition: 'Lines with no room assigned.' },
        { key: 'risk', label: 'Guarantee at risk', value: r.rows.filter((x) => x.at_risk).length, type: 'int', definition: 'Bookings flagged at risk because the deposit or guarantee is missing.' }],
      columns: [{ key: 'arrival', label: 'Arrival', type: 'date' }, { key: 'eta', label: 'Expected at', type: 'time' }, { key: 'conf', label: 'Booking' }, { key: 'guest', label: 'Guest' }, { key: 'room', label: 'Room' }, { key: 'type', label: 'Room type' }, { key: 'departure', label: 'Departure', type: 'date' },
        { key: 'adults', label: 'Adults', type: 'int', total: true, hidden: true }, { key: 'children', label: 'Children', type: 'int', total: true, hidden: true }, { key: 'source', label: 'Source', hidden: true }, { key: 'segment', label: 'Segment', hidden: true }, { key: 'plan', label: 'Rate plan', hidden: true },
        { key: 'depositDue', label: 'Deposit required', type: 'money', total: true }, { key: 'deposit', label: 'Deposit paid', type: 'money', total: true }, { key: 'flag', label: 'Needs attention', type: 'badge' }], rows };
  },
};

export const roomMoves: Def = {
  id: 'room-moves', name: 'Room moves', category: 'frontdesk', kind: 'audit', permissions: ['reservation.view'], roles: ['frontdesk', 'manager', 'housekeeping'],
  purpose: 'Every time an in-house guest was moved to another room, who did it and why. A change of room before arrival is reported separately.',
  basis: [{ id: 'moved', label: 'Date of the move' }], range: 'month',
  definitions: [{ term: 'Room move', text: 'A guest already checked in is moved to a different room. A room assigned or changed before arrival is not a move.' }, { term: 'Rate', text: 'A move keeps the booked nightly rates, so it creates no charge, refund or extra room night.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT h.reservation_id AS rid, h.occurred_at, to_char(h.occurred_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI') AS at, r.confirmation_no AS conf, g.full_name AS guest, h.details->>'from' AS from_room, h.details->>'to' AS to_room, h.reason, u.full_name AS by,
        (SELECT rt.name FROM room x JOIN room_type rt ON rt.id = x.room_type_id WHERE x.property_id = h.property_id AND x.number = h.details->>'from') AS from_type, (SELECT rt.name FROM room x JOIN room_type rt ON rt.id = x.room_type_id WHERE x.property_id = h.property_id AND x.number = h.details->>'to') AS to_type
      FROM reservation_history h JOIN reservation r ON r.tenant_id = h.tenant_id AND r.id = h.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id JOIN reservation_room l ON l.id = h.reservation_room_id LEFT JOIN staff_user u ON u.id = h.actor_id
      WHERE h.tenant_id = ${c.tenantId} AND h.property_id = ${c.propertyId} AND h.action = 'ROOM_MOVED' AND l.status IN ('CHECKED_IN','CHECKED_OUT') AND (h.occurred_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY h.occurred_at DESC`.execute(c.trx);
    const rows: Row[] = r.rows.map((x) => ({ _res: x.rid, at: x.at, conf: x.conf, guest: x.guest, from: x.from_room, fromType: x.from_type, to: x.to_room, toType: x.to_type, change: x.from_type && x.to_type ? (x.from_type === x.to_type ? 'Same type' : 'Different type') : '', reason: x.reason, by: x.by }));
    return { kpis: [{ key: 'n', label: 'Room moves', value: rows.length, type: 'int', definition: 'Moves of checked-in guests in the period.' }, { key: 'dt', label: 'To a different room type', value: rows.filter((x) => x.change === 'Different type').length, type: 'int', definition: 'The new room is of another type than the old.' }],
      columns: [{ key: 'at', label: 'Moved', type: 'datetime' }, { key: 'conf', label: 'Booking' }, { key: 'guest', label: 'Guest' }, { key: 'from', label: 'From room' }, { key: 'fromType', label: 'From type', hidden: true }, { key: 'to', label: 'To room' }, { key: 'toType', label: 'To type', hidden: true }, { key: 'change', label: 'Type change', type: 'badge' }, { key: 'reason', label: 'Reason' }, { key: 'by', label: 'Moved by' }],
      rows, notes: ['Guest-requested versus property-initiated, approvals, and links to complaints are not captured yet; the reason is the free text entered at the desk.'] };
  },
};

export const roomReassignments: Def = {
  id: 'room-reassignments', name: 'Room reassignments before arrival', category: 'frontdesk', kind: 'audit', permissions: ['reservation.view'], roles: ['frontdesk', 'manager'],
  purpose: 'Rooms that were changed or taken away from a booking before the guest arrived. These are not guest room moves.',
  basis: [{ id: 'changed', label: 'Date of the change' }], range: 'month',
  definitions: [{ term: 'Reassignment', text: 'A room assigned to a booking was ended before check-in (replaced, unassigned, or lost to a date or room-type change).' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT r.id AS rid, to_char(a.ended_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI') AS at, r.confirmation_no AS conf, g.full_name AS guest, rm.number AS room, a.end_reason AS why, l.arrival::text AS arrival, l.status
      FROM room_assignment a JOIN reservation_room l ON l.id = a.assignment_ref JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id JOIN room rm ON rm.id = a.room_id
      WHERE a.tenant_id = ${c.tenantId} AND a.property_id = ${c.propertyId} AND a.status = 'ENDED' AND a.end_reason IN ('REASSIGNED','ROOM_TYPE_CHANGED','DATES_CHANGED','UNASSIGNED') AND a.ended_at IS NOT NULL AND l.checked_in_at IS NULL
        AND (a.ended_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY a.ended_at DESC`.execute(c.trx);
    const label: Record<string, string> = { REASSIGNED: 'Another room chosen', ROOM_TYPE_CHANGED: 'Room type changed', DATES_CHANGED: 'Dates changed', UNASSIGNED: 'Room taken away' };
    return { kpis: [{ key: 'n', label: 'Reassignments', value: r.rows.length, type: 'int', definition: 'Pre-arrival room changes in the period.' }],
      columns: [{ key: 'at', label: 'Changed', type: 'datetime' }, { key: 'conf', label: 'Booking' }, { key: 'guest', label: 'Guest' }, { key: 'room', label: 'Room taken off' }, { key: 'arrival', label: 'Arrival', type: 'date' }, { key: 'why', label: 'Why' }],
      rows: r.rows.map((x) => ({ _res: x.rid, at: x.at, conf: x.conf, guest: x.guest, room: x.room, arrival: x.arrival, why: label[x.why] ?? x.why })) };
  },
};

export const cancellations: Def = {
  id: 'cancellations', name: 'Cancellations and no-shows', category: 'frontdesk', kind: 'operational', permissions: ['reservation.view'], roles: ['manager', 'frontdesk', 'accounts'],
  purpose: 'Lost bookings, why they were lost, what it cost, and what was charged or kept.',
  basis: [{ id: 'cancelled', label: 'Date cancelled or marked no-show' }, { id: 'arrival', label: 'Arrival date' }, { id: 'created', label: 'Booking-created date' }], range: 'month',
  params: [{ key: 'view', label: 'Show', default: 'all', options: [{ value: 'all', label: 'Cancellations and no-shows' }, { value: 'cancelled', label: 'Cancellations only' }, { value: 'noshow', label: 'No-shows only' }] },
    { key: 'group', label: 'Group by', default: 'list', options: [{ value: 'list', label: 'Each booking' }, { value: 'reason', label: 'Reason' }, { value: 'initiator', label: 'Who started it' }, { value: 'source', label: 'Booking source' }] }],
  definitions: [{ term: 'No-show', text: 'Confirmed by staff after the property’s cutoff; passing the expected arrival time alone is not a no-show.' }, { term: 'Expected room revenue', text: 'The room total of the line before it was lost, excluding tax.' }, { term: 'Lost revenue', text: 'Expected room revenue less any fee charged and not waived.' }, { term: 'Reason and who started it', text: 'The standard reason the desk chose, and who it is taken to have come from: the guest, the property, the booking channel, the company or the system (night audit, expired holds). Records made before reasons were kept show “Not recorded”.' }],
  async run(c) {
    const status = c.params.view === 'cancelled' ? ['CANCELLED'] : c.params.view === 'noshow' ? ['NO_SHOW'] : ['CANCELLED', 'NO_SHOW'];
    const col = c.basis === 'arrival' ? sql.raw('l.arrival') : c.basis === 'created' ? sql.raw(`(r.created_at AT TIME ZONE '${c.prop.timezone.replace(/[^A-Za-z_\/+-]/g, '')}')::date`) : sql.raw(`(coalesce(h.occurred_at, r.cancelled_at) AT TIME ZONE '${c.prop.timezone.replace(/[^A-Za-z_\/+-]/g, '')}')::date`);
    const r = await sql<Record<string, any>>`SELECT r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, to_char(r.created_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD') AS created, l.arrival::text AS arrival, l.departure::text AS departure, l.status,
        to_char(coalesce(h.occurred_at, r.cancelled_at) AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI') AS at, r.source, r.channel, rt.name AS type, rp.name AS plan, r.market_segment AS seg, coalesce(h.reason, r.cancel_reason) AS why, l.cancel_code AS code, l.cancel_initiator AS init, l.total_minor::text AS total, r.deposit_paid_minor::text AS dep,
        r.penalty_minor::text AS fee, r.penalty_waived AS waived, r.penalty_reason, u.full_name AS by
      FROM ${FROM_JOIN} LEFT JOIN LATERAL (SELECT hh.occurred_at, hh.reason, hh.actor_id FROM reservation_history hh WHERE hh.reservation_room_id = l.id AND hh.to_status IN ('CANCELLED','NO_SHOW') ORDER BY hh.occurred_at DESC LIMIT 1) h ON true LEFT JOIN staff_user u ON u.id = h.actor_id
      WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.status IN (${sql.join(status)}) AND ${col} BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY coalesce(h.occurred_at, r.cancelled_at) DESC NULLS LAST`.execute(c.trx);
    const rows: Row[] = r.rows.map((x) => { const charged = x.waived ? 0n : BigInt(x.fee); return { _res: x.rid, at: x.at, conf: x.conf, guest: x.guest, type: x.status === 'NO_SHOW' ? 'No-show' : 'Cancelled', created: x.created, arrival: x.arrival, departure: x.departure, source: x.source, channel: x.channel, room: x.type, plan: x.plan, segment: x.seg,
      why: x.why, reason: x.code ? (LABELS[x.code as CancelCode] ?? x.code) : 'Not recorded', initiator: x.init ? INIT[x.init] ?? x.init : 'Not recorded', expected: x.total, deposit: x.dep, fee: x.fee, feeStatus: BigInt(x.fee) === 0n ? '' : x.waived ? 'Waived' : 'Charged', lost: (BigInt(x.total) - charged).toString(), by: x.by }; });
    const sum = (k: string) => rows.reduce((s, x) => s + BigInt(x[k] as string), 0n);
    const out: Result = { kpis: [{ key: 'c', label: 'Cancelled', value: rows.filter((x) => x.type === 'Cancelled').length, type: 'int', definition: 'Room lines cancelled in the period.' }, { key: 'n', label: 'No-shows', value: rows.filter((x) => x.type === 'No-show').length, type: 'int', definition: 'Room lines marked no-show in the period.' },
        { key: 'lost', label: 'Lost revenue', value: dec(sum('lost')), type: 'money', definition: 'Expected room revenue minus fees charged (waived fees count as lost).' }, { key: 'fees', label: 'Fees charged', value: dec(rows.reduce((s, x) => s + (x.feeStatus === 'Charged' ? BigInt(x.fee as string) : 0n), 0n)), type: 'money', definition: 'Cancellation and no-show fees not waived.' }],
      columns: [{ key: 'at', label: 'When', type: 'datetime' }, { key: 'conf', label: 'Booking' }, { key: 'guest', label: 'Guest' }, { key: 'type', label: 'Outcome', type: 'badge' }, { key: 'created', label: 'Booked on', type: 'date', hidden: true }, { key: 'arrival', label: 'Arrival', type: 'date' }, { key: 'departure', label: 'Departure', type: 'date', hidden: true },
        { key: 'source', label: 'Source' }, { key: 'channel', label: 'Channel', hidden: true }, { key: 'room', label: 'Room type', hidden: true }, { key: 'plan', label: 'Rate plan', hidden: true }, { key: 'segment', label: 'Segment', hidden: true }, { key: 'reason', label: 'Reason' }, { key: 'initiator', label: 'Started by' }, { key: 'why', label: 'Note' },
        { key: 'expected', label: 'Expected room revenue', type: 'money', total: true }, { key: 'deposit', label: 'Deposit received', type: 'money', total: true }, { key: 'fee', label: 'Fee', type: 'money', total: true }, { key: 'feeStatus', label: 'Fee status', type: 'badge' }, { key: 'lost', label: 'Lost revenue', type: 'money', total: true }, { key: 'by', label: 'Done by' }],
      rows, notes: ['Commission impact is not recorded. Bookings cancelled before reasons were kept show “Not recorded”.'] };
    const g = c.params.group ?? 'list'; if (g === 'list') return out;
    const key = g === 'reason' ? 'reason' : g === 'initiator' ? 'initiator' : 'source';
    const map = new Map<string, { n: number; c: number; ns: number; expected: bigint; fee: bigint; lost: bigint }>();
    for (const x of rows) { const k = String(x[key] ?? '') || 'Not recorded'; const m = map.get(k) ?? { n: 0, c: 0, ns: 0, expected: 0n, fee: 0n, lost: 0n }; m.n++; if (x.type === 'No-show') m.ns++; else m.c++; m.expected += BigInt(x.expected as string); m.fee += x.feeStatus === 'Charged' ? BigInt(x.fee as string) : 0n; m.lost += BigInt(x.lost as string); map.set(k, m); }
    const grouped: Row[] = [...map.entries()].sort((a2, b2) => (a2[1].lost < b2[1].lost ? 1 : a2[1].lost > b2[1].lost ? -1 : b2[1].n - a2[1].n)).map(([k, m]) => ({ what: k, n: m.n, share: pctOf(m.n, rows.length), cancelled: m.c, noShows: m.ns, expected: m.expected.toString(), fee: m.fee.toString(), lost: m.lost.toString() }));
    return { kpis: out.kpis, rows: grouped, notes: out.notes, chart: { kind: 'bar', x: 'what', series: [{ key: 'n', label: 'Lost bookings' }] },
      columns: [{ key: 'what', label: g === 'reason' ? 'Reason' : g === 'initiator' ? 'Started by' : 'Booking source' }, { key: 'n', label: 'Bookings lost', type: 'int', total: true }, { key: 'share', label: 'Share %', type: 'pct' }, { key: 'cancelled', label: 'Cancelled', type: 'int', total: true }, { key: 'noShows', label: 'No-shows', type: 'int', total: true },
        { key: 'expected', label: 'Expected room revenue', type: 'money', total: true }, { key: 'fee', label: 'Fees charged', type: 'money', total: true }, { key: 'lost', label: 'Lost revenue', type: 'money', total: true }] };
  },
};

export const earlyLate: Def = {
  id: 'early-late', name: 'Early check-in and late checkout', category: 'frontdesk', kind: 'operational', permissions: ['reservation.view'], roles: ['frontdesk', 'manager', 'housekeeping'],
  purpose: 'How far actual check-in and checkout times were from the standard times, and what guests asked for.',
  basis: [{ id: 'event', label: 'Business date of the event' }], range: 'month',
  definitions: [{ term: 'Standard times', text: 'The property’s check-in and check-out times in its settings.' }, { term: 'Minutes early / late', text: 'Actual local time against the standard time on the arrival or departure date.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT * FROM (
        SELECT r.id AS rid, 'Early check-in' AS kind, l.checked_in_business_date::text AS bd, to_char(l.checked_in_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI') AS at, r.confirmation_no AS conf, g.full_name AS guest, ${ROOM_OF} AS room, ${c.prop.checkIn} AS std,
          to_char(l.checked_in_at AT TIME ZONE ${c.prop.timezone}, 'HH24:MI') AS actual, floor(extract(epoch FROM (${c.prop.checkIn}::time - (l.checked_in_at AT TIME ZONE ${c.prop.timezone})::time)) / 60)::int AS mins,
          (SELECT gr.status FROM guest_request gr WHERE gr.reservation_id = r.id AND gr.kind = 'EARLY_CHECKIN' ORDER BY gr.created_at DESC LIMIT 1) AS ask, (SELECT gr.needed_time FROM guest_request gr WHERE gr.reservation_id = r.id AND gr.kind = 'EARLY_CHECKIN' ORDER BY gr.created_at DESC LIMIT 1) AS asked_time,
          te.suggested_minor::text AS sug, te.charged_minor::text AS chg, te.waived_minor::text AS wv, te.reason AS why, du.full_name AS decider
        FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id LEFT JOIN timing_fee_event te ON te.reservation_room_id = l.id AND te.kind = 'EARLY_CHECKIN' LEFT JOIN staff_user du ON du.id = te.decided_by
        WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.checked_in_at IS NOT NULL AND l.arrival = l.checked_in_business_date AND (l.checked_in_at AT TIME ZONE ${c.prop.timezone})::time < ${c.prop.checkIn}::time
        UNION ALL
        SELECT r.id, 'Late checkout', l.checked_out_business_date::text, to_char(l.checked_out_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI'), r.confirmation_no, g.full_name, ${ROOM_OF}, ${c.prop.checkOut},
          to_char(l.checked_out_at AT TIME ZONE ${c.prop.timezone}, 'HH24:MI'), floor(extract(epoch FROM ((l.checked_out_at AT TIME ZONE ${c.prop.timezone})::time - ${c.prop.checkOut}::time)) / 60)::int,
          (SELECT gr.status FROM guest_request gr WHERE gr.reservation_id = r.id AND gr.kind = 'LATE_CHECKOUT' ORDER BY gr.created_at DESC LIMIT 1), (SELECT gr.needed_time FROM guest_request gr WHERE gr.reservation_id = r.id AND gr.kind = 'LATE_CHECKOUT' ORDER BY gr.created_at DESC LIMIT 1),
          te.suggested_minor::text, te.charged_minor::text, te.waived_minor::text, te.reason, du.full_name
        FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id LEFT JOIN timing_fee_event te ON te.reservation_room_id = l.id AND te.kind = 'LATE_CHECKOUT' LEFT JOIN staff_user du ON du.id = te.decided_by
        WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.checked_out_at IS NOT NULL AND l.checked_out_business_date = l.departure AND (l.checked_out_at AT TIME ZONE ${c.prop.timezone})::time > ${c.prop.checkOut}::time
      ) e WHERE e.bd BETWEEN ${c.from} AND ${c.to} ORDER BY e.at DESC`.execute(c.trx);
    const rows: Row[] = r.rows.map((x) => ({ _res: x.rid, at: x.at, kind: x.kind, conf: x.conf, guest: x.guest, room: x.room, std: String(x.std).slice(0, 5), asked: x.asked_time ? String(x.asked_time).slice(0, 5) : '', request: x.ask ?? '', actual: x.actual, mins: x.mins, suggested: x.sug, charged: x.chg, waived: x.wv, status: x.chg === null ? '' : BigInt(x.chg) > 0n ? 'Charged' : 'Waived', why: x.why ?? '', decider: x.decider ?? '' }));
    return { kpis: [{ key: 'e', label: 'Early check-ins', value: rows.filter((x) => x.kind === 'Early check-in').length, type: 'int', definition: 'Checked in before the standard time on the arrival date.' }, { key: 'l', label: 'Late checkouts', value: rows.filter((x) => x.kind === 'Late checkout').length, type: 'int', definition: 'Checked out after the standard time on the departure date.' },
        { key: 'avg', label: 'Average minutes off standard', value: rows.length ? Math.round(rows.reduce((s, x) => s + Number(x.mins), 0) / rows.length) : 0, type: 'int', definition: 'Mean of minutes early or late.' },
        { key: 'fees', label: 'Fees charged', value: dec(rows.reduce((s, x) => s + BigInt((x.charged as string | null) ?? 0), 0n)), type: 'money', definition: 'Early check-in and late checkout fees posted to bills.' }, { key: 'wv', label: 'Fees waived', value: dec(rows.reduce((s, x) => s + BigInt((x.waived as string | null) ?? 0), 0n)), type: 'money', definition: 'Suggested fees the desk waived.' }],
      columns: [{ key: 'at', label: 'When', type: 'datetime' }, { key: 'kind', label: 'Event', type: 'badge' }, { key: 'conf', label: 'Booking' }, { key: 'guest', label: 'Guest' }, { key: 'room', label: 'Room' }, { key: 'std', label: 'Standard time', type: 'time' }, { key: 'asked', label: 'Asked for', type: 'time' }, { key: 'request', label: 'Request status', type: 'badge', hidden: true }, { key: 'actual', label: 'Actual time', type: 'time' }, { key: 'mins', label: 'Minutes off', type: 'int' },
        { key: 'suggested', label: 'Fee suggested', type: 'money', total: true }, { key: 'charged', label: 'Fee charged', type: 'money', total: true }, { key: 'waived', label: 'Fee waived', type: 'money', total: true }, { key: 'status', label: 'Fee', type: 'badge' }, { key: 'why', label: 'Reason', hidden: true }, { key: 'decider', label: 'Decided by', hidden: true }],
      rows, notes: ['A fee is recorded when the desk charges or waives it. Rows with no fee recorded had no fee suggested by the property’s steps (or none are set). Approved times and the impact on the next arrival are not recorded.'] };
  },
};

export const rateChanges: Def = {
  id: 'rate-changes', name: 'Room rate changes', category: 'frontdesk', kind: 'audit', permissions: ['report.view', 'reservation.view'], roles: ['manager', 'accounts', 'frontdesk'],
  purpose: 'Every change to a booking’s stay total, with before and after, the reason and who made it. History is never overwritten.',
  basis: [{ id: 'changed', label: 'Date of the change' }], range: 'month',
  definitions: [{ term: 'Revenue impact', text: 'New stay total minus the old, room charges excluding tax.' }, { term: 'Rate kept', text: 'The change was made keeping the originally quoted nightly prices.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT r.id AS rid, to_char(h.occurred_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI') AS at, r.confirmation_no AS conf, g.full_name AS guest, h.details->'before'->>'arrival' AS b_arr, h.details->'before'->>'departure' AS b_dep, h.details->'after'->>'arrival' AS a_arr, h.details->'after'->>'departure' AS a_dep,
        h.details->'before'->>'total' AS b_tot, h.details->'after'->>'total' AS a_tot, (h.details->>'keepRate')::boolean AS keep, h.reason, u.full_name AS by, ${ROOM_OF} AS room
      FROM reservation_history h JOIN reservation_room l ON l.id = h.reservation_room_id JOIN reservation r ON r.tenant_id = h.tenant_id AND r.id = h.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id LEFT JOIN staff_user u ON u.id = h.actor_id
      WHERE h.tenant_id = ${c.tenantId} AND h.property_id = ${c.propertyId} AND h.action = 'MODIFY' AND (h.occurred_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY h.occurred_at DESC`.execute(c.trx);
    const minor = (v: string | null) => (v ? BigInt(Math.round(Number(v) * 100)).toString() : '0');
    const rows: Row[] = r.rows.map((x) => ({ _res: x.rid, at: x.at, conf: x.conf, guest: x.guest, room: x.room, before: `${x.b_arr} → ${x.b_dep}`, after: `${x.a_arr} → ${x.a_dep}`, oldTotal: minor(x.b_tot), newTotal: minor(x.a_tot), impact: (BigInt(minor(x.a_tot)) - BigInt(minor(x.b_tot))).toString(), kept: x.keep ? 'Rate kept' : '', reason: x.reason, by: x.by }));
    const net = rows.reduce((s, x) => s + BigInt(x.impact as string), 0n);
    return { kpis: [{ key: 'n', label: 'Changes', value: rows.length, type: 'int', definition: 'Booking modifications in the period.' }, { key: 'net', label: 'Net revenue impact', value: dec(net), type: 'money', tone: net < 0n ? 'warn' : undefined, definition: 'Sum of new totals minus old totals, excluding tax.' }],
      columns: [{ key: 'at', label: 'Changed', type: 'datetime' }, { key: 'conf', label: 'Booking' }, { key: 'guest', label: 'Guest' }, { key: 'room', label: 'Room', hidden: true }, { key: 'before', label: 'Dates before' }, { key: 'after', label: 'Dates after' }, { key: 'oldTotal', label: 'Old stay total', type: 'money', total: true }, { key: 'newTotal', label: 'New stay total', type: 'money', total: true }, { key: 'impact', label: 'Revenue impact', type: 'money', total: true }, { key: 'kept', label: '', type: 'badge' }, { key: 'reason', label: 'Reason' }, { key: 'by', label: 'Changed by' }],
      rows, notes: ['Nightly-rate before and after, tax impact, and approvals are not captured per change yet. The stay total is.'] };
  },
};

export const _unused = pctOf;
