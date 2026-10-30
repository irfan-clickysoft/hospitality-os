import { sql } from 'kysely';
import type { Def, Row } from './types.js';

export const roomStatus: Def = {
  id: 'room-status', name: 'Room status', category: 'rooms', kind: 'operational', permissions: ['housekeeping.view', 'reservation.view'], roles: ['housekeeping', 'frontdesk', 'manager', 'maintenance'],
  purpose: 'Every room right now, with occupancy, housekeeping and maintenance shown as three separate things, and where they disagree.',
  basis: [{ id: 'now', label: 'Current snapshot' }], range: 'none',
  definitions: [{ term: 'Occupancy', text: 'Occupied when a guest is checked in to the room; otherwise vacant.' }, { term: 'Housekeeping', text: 'Clean, dirty, cleaning or inspected, as set by housekeeping.' }, { term: 'Maintenance', text: 'Out of order or out of service when an active block covers the business date; otherwise available.' },
    { term: 'Discrepancy', text: 'Occupied but marked clean-and-ready for a new guest, vacant and dirty with an arrival today, or blocked but occupied.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT rm.id, rm.number, rt.name AS type, fl.name AS floor, rm.hk_status, rm.dnd, to_char(rm.hk_updated_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI') AS hk_at, floor(extract(epoch FROM (now() - rm.hk_updated_at)) / 3600)::int AS hk_hours,
        (SELECT g.full_name FROM room_assignment a JOIN reservation_room l ON l.id = a.assignment_ref JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id WHERE a.room_id = rm.id AND a.status = 'IN_HOUSE' LIMIT 1) AS guest,
        (SELECT l.departure::text FROM room_assignment a JOIN reservation_room l ON l.id = a.assignment_ref WHERE a.room_id = rm.id AND a.status = 'IN_HOUSE' LIMIT 1) AS dep,
        (SELECT min(lower(a.stay_range))::text FROM room_assignment a WHERE a.room_id = rm.id AND a.status = 'ASSIGNED' AND lower(a.stay_range) >= ${c.prop.businessDate}::date) AS next_arrival,
        (SELECT b.block_type FROM room_block b WHERE b.room_id = rm.id AND b.cancelled_at IS NULL AND b.start_date <= ${c.prop.businessDate}::date AND b.end_date > ${c.prop.businessDate}::date LIMIT 1) AS block,
        (SELECT b.reason FROM room_block b WHERE b.room_id = rm.id AND b.cancelled_at IS NULL AND b.start_date <= ${c.prop.businessDate}::date AND b.end_date > ${c.prop.businessDate}::date LIMIT 1) AS block_reason,
        (SELECT b.end_date::text FROM room_block b WHERE b.room_id = rm.id AND b.cancelled_at IS NULL AND b.start_date <= ${c.prop.businessDate}::date AND b.end_date > ${c.prop.businessDate}::date LIMIT 1) AS back_on,
        (SELECT w.number FROM work_order w WHERE w.room_id = rm.id AND w.status IN ('OPEN','ASSIGNED','IN_PROGRESS','WAITING') ORDER BY w.created_at DESC LIMIT 1) AS wo
      FROM room rm JOIN room_type rt ON rt.id = rm.room_type_id LEFT JOIN floor fl ON fl.id = rm.floor_id WHERE rm.tenant_id = ${c.tenantId} AND rm.property_id = ${c.propertyId} AND rm.status = 'ACTIVE' ORDER BY fl.name NULLS LAST, lpad(regexp_replace(rm.number, '\\D', '', 'g'), 8, '0'), rm.number`.execute(c.trx);
    const hk: Record<string, string> = { CLEAN: 'Clean', DIRTY: 'Dirty', CLEANING: 'Cleaning', INSPECTED: 'Inspected' };
    const rows: Row[] = r.rows.map((x) => {
      const occ = x.guest ? 'Occupied' : 'Vacant'; const mt = x.block === 'OUT_OF_ORDER' ? 'Out of order' : x.block === 'OUT_OF_SERVICE' ? 'Out of service' : 'Available';
      const issue = occ === 'Occupied' && mt !== 'Available' ? 'Blocked but occupied' : occ === 'Occupied' && x.hk_status === 'INSPECTED' ? 'Occupied but inspected' : occ === 'Vacant' && x.hk_status === 'DIRTY' && x.next_arrival === c.prop.businessDate ? 'Dirty, arrival today' : '';
      return { room: x.number, type: x.type, floor: x.floor ?? '', occupancy: occ, housekeeping: hk[x.hk_status] ?? x.hk_status, maintenance: mt, guest: x.guest ?? '', departure: x.dep ?? '', next: x.next_arrival ?? '', since: x.hk_at ?? '', hours: x.hk_hours ?? null, dnd: x.dnd ? 'Do not disturb' : '', reason: x.block_reason ?? '', backOn: x.back_on ?? '', wo: x.wo ?? '', issue };
    });
    const n = (f: (x: Row) => boolean) => rows.filter(f).length;
    return { kpis: [{ key: 'occ', label: 'Occupied', value: n((x) => x.occupancy === 'Occupied'), type: 'int', definition: 'Rooms with a guest checked in.' }, { key: 'dirty', label: 'Vacant and dirty', value: n((x) => x.occupancy === 'Vacant' && x.housekeeping === 'Dirty'), type: 'int', definition: 'Empty rooms waiting to be cleaned.' },
        { key: 'ooo', label: 'Out of order / service', value: n((x) => x.maintenance !== 'Available'), type: 'int', definition: 'Rooms with an active block today; removed from sellable rooms.' }, { key: 'disc', label: 'Discrepancies', value: n((x) => !!x.issue), type: 'int', tone: n((x) => !!x.issue) ? 'warn' : 'ok', definition: 'Rooms whose three statuses do not fit together.' }],
      columns: [{ key: 'room', label: 'Room' }, { key: 'type', label: 'Type', hidden: true }, { key: 'floor', label: 'Floor', hidden: true }, { key: 'occupancy', label: 'Occupancy', type: 'badge' }, { key: 'housekeeping', label: 'Housekeeping', type: 'badge' }, { key: 'maintenance', label: 'Maintenance', type: 'badge' }, { key: 'issue', label: 'Discrepancy', type: 'badge' },
        { key: 'guest', label: 'Guest' }, { key: 'departure', label: 'Departs', type: 'date' }, { key: 'next', label: 'Next arrival', type: 'date' }, { key: 'since', label: 'Housekeeping changed', type: 'datetime' }, { key: 'hours', label: 'Hours in status', type: 'int', hidden: true }, { key: 'dnd', label: 'DND', hidden: true }, { key: 'reason', label: 'Block reason', hidden: true }, { key: 'backOn', label: 'Back in service', type: 'date', hidden: true }, { key: 'wo', label: 'Work order', hidden: true }],
      rows, notes: ['A history of status changes (who changed it and when) is not kept yet; only the latest housekeeping change is shown.'] };
  },
};

export const lostFound: Def = {
  id: 'lost-found', name: 'Lost and found', category: 'risk', kind: 'register', permissions: ['housekeeping.view', 'reservation.view'], roles: ['housekeeping', 'frontdesk', 'manager'],
  purpose: 'Every found item, where it is kept, who has handled it, and what is due for a decision.',
  basis: [{ id: 'found', label: 'Date found' }], range: 'last30',
  params: [{ key: 'view', label: 'Show', default: 'all', options: [{ value: 'all', label: 'All items' }, { value: 'open', label: 'Still held' }, { value: 'closed', label: 'Returned or disposed' }] }],
  definitions: [{ term: 'Still held', text: 'Found, or the owner has been contacted, and not yet returned or disposed.' }, { term: 'Past retention', text: 'The keep-until date has passed and the item is still held.' }, { term: 'Handled by', text: 'Number of recorded custody events (found, contacted, returned…).' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT i.id, i.ref, i.item, i.category, i.status, i.high_value, i.storage_location, i.location, rm.number AS room, to_char(i.found_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI') AS found, fb.full_name AS found_by, g.full_name AS guest, r.id AS rid, r.confirmation_no AS conf,
        i.dispose_after::text AS keep_until, i.handover_method, i.receiver_name, to_char(i.closed_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI') AS closed, cb.full_name AS closed_by, (SELECT count(*) FROM lost_found_event e WHERE e.lost_found_id = i.id)::int AS events,
        floor(extract(epoch FROM (coalesce(i.closed_at, now()) - i.found_at)) / 86400)::int AS days
      FROM lost_found i JOIN staff_user fb ON fb.id = i.found_by LEFT JOIN staff_user cb ON cb.id = i.closed_by LEFT JOIN room rm ON rm.id = i.room_id LEFT JOIN reservation r ON r.id = i.reservation_id LEFT JOIN guest g ON g.id = coalesce(i.guest_id, r.guest_id)
      WHERE i.tenant_id = ${c.tenantId} AND i.property_id = ${c.propertyId} AND (i.found_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY i.found_at DESC`.execute(c.trx);
    const st: Record<string, string> = { FOUND: 'Held', OWNER_CONTACTED: 'Owner contacted', RETURNED: 'Returned', DISPOSED: 'Disposed' };
    let rows: Row[] = r.rows.map((x) => ({ _res: x.rid, ref: x.ref ?? '', found: x.found, item: x.item, category: x.category, value: x.high_value ? 'High value' : '', status: st[x.status] ?? x.status, where: x.room ? `Room ${x.room}` : x.location ?? '', stored: x.storage_location ?? '', foundBy: x.found_by, guest: x.guest ?? '', booking: x.conf ?? '', keepUntil: x.keep_until ?? '', past: x.keep_until && x.keep_until < c.prop.businessDate && ['FOUND', 'OWNER_CONTACTED'].includes(x.status) ? 'Past retention' : '', days: x.days, events: x.events, handover: x.handover_method ?? '', receiver: x.receiver_name ?? '', closed: x.closed ?? '', closedBy: x.closed_by ?? '' }));
    if (c.params.view === 'open') rows = rows.filter((x) => x.status === 'Held' || x.status === 'Owner contacted'); else if (c.params.view === 'closed') rows = rows.filter((x) => x.status === 'Returned' || x.status === 'Disposed');
    const held = rows.filter((x) => x.status === 'Held' || x.status === 'Owner contacted');
    return { kpis: [{ key: 'n', label: 'Items', value: rows.length, type: 'int', definition: 'Items found in the period.' }, { key: 'held', label: 'Still held', value: held.length, type: 'int', definition: 'Not returned or disposed.' }, { key: 'past', label: 'Past retention', value: rows.filter((x) => x.past).length, type: 'int', tone: rows.some((x) => x.past) ? 'warn' : 'ok', definition: 'Held beyond the keep-until date.' }, { key: 'hv', label: 'High value held', value: held.filter((x) => x.value).length, type: 'int', definition: 'High-value items not yet returned.' }],
      columns: [{ key: 'ref', label: 'Reference' }, { key: 'found', label: 'Found', type: 'datetime' }, { key: 'item', label: 'Item' }, { key: 'category', label: 'Category', hidden: true }, { key: 'value', label: 'Value', type: 'badge' }, { key: 'status', label: 'Status', type: 'badge' }, { key: 'where', label: 'Found at' }, { key: 'stored', label: 'Kept at' }, { key: 'foundBy', label: 'Found by', hidden: true }, { key: 'guest', label: 'Possible guest' }, { key: 'booking', label: 'Booking', hidden: true },
        { key: 'keepUntil', label: 'Keep until', type: 'date' }, { key: 'past', label: '', type: 'badge' }, { key: 'days', label: 'Days held', type: 'int' }, { key: 'events', label: 'Custody events', type: 'int', hidden: true }, { key: 'handover', label: 'Handed over by', hidden: true }, { key: 'receiver', label: 'Received by', hidden: true }, { key: 'closed', label: 'Closed', type: 'datetime', hidden: true }, { key: 'closedBy', label: 'Closed by', hidden: true }],
      rows, notes: ['Photographs, claimant verification and signatures live on each item in Housekeeping → Lost & found.'] };
  },
};
