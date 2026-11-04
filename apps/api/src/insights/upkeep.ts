import { sql } from 'kysely';
import type { Def, Row } from './types.js';
import { dec, local, pctOf } from './util.js';

const CAT: Record<string, string> = { PLUMBING: 'Plumbing', ELECTRICAL: 'Electrical', AC: 'Air conditioning', FURNITURE: 'Furniture', APPLIANCE: 'Appliance', CLEANLINESS: 'Cleanliness', SAFETY: 'Safety', FUMIGATION: 'Fumigation', OTHER: 'Other' };
const STAT: Record<string, string> = { REQUESTED: 'Requested', OPEN: 'Open', ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress', WAITING: 'Waiting', DONE: 'Done', VERIFIED: 'Verified', CANCELLED: 'Cancelled', REJECTED: 'Rejected' };
const PRI: Record<number, string> = { 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };
const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;
const ROOM = 'coalesce(rm.number, w.area, \'\')';

export const openOrders: Def = {
  id: 'work-orders-open', name: 'Open and overdue work orders', category: 'rooms', kind: 'operational', permissions: ['maintenance.view', 'report.view'], roles: ['maintenance', 'manager'],
  purpose: 'Maintenance jobs not finished yet, oldest first: where, what, how urgent, who has it, and which are past their due date.',
  basis: [{ id: 'asof', label: 'As of now' }], range: 'none',
  params: [{ key: 'view', label: 'Show', default: 'all', options: [{ value: 'all', label: 'All open jobs' }, { value: 'overdue', label: 'Overdue only' }, { value: 'unassigned', label: 'Not assigned' }, { value: 'urgent', label: 'Urgent and high' }] }],
  definitions: [{ term: 'Open', text: 'Requested, open, assigned, in progress or waiting. Done, verified, cancelled and rejected jobs are not open.' }, { term: 'Age', text: 'Days since the job was raised, as of the business date.' }, { term: 'Overdue', text: 'The due date is before the business date and the job is not done.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT w.id, w.number, ${sql.raw(ROOM)} AS where_, w.category, w.title, w.priority, w.status, w.kind, w.due_date::text AS due, w.created_at::date::text AS raised, u.full_name AS tech, coalesce(w.vendor, '') AS vendor, w.estimated_cost_minor::text AS est
      FROM work_order w LEFT JOIN room rm ON rm.id = w.room_id LEFT JOIN staff_user u ON u.id = w.assigned_to WHERE w.tenant_id = ${c.tenantId} AND w.property_id = ${c.propertyId} AND w.status IN ('REQUESTED','OPEN','ASSIGNED','IN_PROGRESS','WAITING') ORDER BY w.priority, w.created_at`.execute(c.trx);
    const bd = c.prop.businessDate; const age = (d: string) => Math.max(0, Math.round((Date.parse(`${bd}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000));
    let rows: Row[] = r.rows.map((x): Row => ({ no: x.number, where: x.where_, cat: CAT[x.category] ?? x.category, title: x.title, pri: PRI[x.priority] ?? String(x.priority), status: STAT[x.status] ?? x.status, kind: x.kind === 'PREVENTIVE' ? 'Preventive' : 'Repair', raised: x.raised, age: age(x.raised), due: x.due ?? '', overdue: !!x.due && x.due < bd ? 'Overdue' : '', tech: x.tech ?? '', vendor: x.vendor, est: x.est ?? '0', _p: x.priority }));
    const v = c.params.view ?? 'all'; if (v === 'overdue') rows = rows.filter((x) => x.overdue); else if (v === 'unassigned') rows = rows.filter((x) => !x.tech && !x.vendor); else if (v === 'urgent') rows = rows.filter((x) => Number(x._p) <= 2);
    const od = rows.filter((x) => x.overdue).length;
    return { kpis: [{ key: 'n', label: 'Open jobs', value: rows.length, type: 'int', definition: 'Jobs in the view.' }, { key: 'od', label: 'Overdue', value: od, type: 'int', tone: od ? 'bad' : 'ok', definition: 'Past their due date.' }, { key: 'urg', label: 'Urgent and high', value: rows.filter((x) => Number(x._p) <= 2).length, type: 'int', definition: 'Priority 1 and 2.' }, { key: 'old', label: 'Oldest (days)', value: rows.reduce((m, x) => Math.max(m, Number(x.age)), 0), type: 'int', definition: 'Age of the oldest job in the view.' }],
      columns: [{ key: 'no', label: 'Job' }, { key: 'where', label: 'Room or area' }, { key: 'cat', label: 'Category' }, { key: 'title', label: 'Problem' }, { key: 'pri', label: 'Priority', type: 'badge' }, { key: 'status', label: 'Status', type: 'badge' }, { key: 'kind', label: 'Type', hidden: true }, { key: 'raised', label: 'Raised', type: 'date' }, { key: 'age', label: 'Age (days)', type: 'int' }, { key: 'due', label: 'Due', type: 'date' }, { key: 'overdue', label: 'Overdue', type: 'badge' }, { key: 'tech', label: 'Assigned to' }, { key: 'vendor', label: 'Vendor', hidden: true }, { key: 'est', label: 'Estimated cost', type: 'money', total: true, hidden: true }],
      rows: rows.map(({ _p, ...x }) => x as Row), notes: ['Preventive jobs that are due but not yet raised are not listed.'] };
  },
};

export const orderTimes: Def = {
  id: 'work-order-times', name: 'Maintenance response and resolution time', category: 'rooms', kind: 'analytical', permissions: ['maintenance.view', 'report.view'], roles: ['maintenance', 'manager'],
  purpose: 'How quickly jobs are picked up and finished: hours from raised to assigned, to started, and to done, for jobs completed in the period.',
  basis: [{ id: 'done', label: 'Date the job was done' }], range: 'month',
  params: [{ key: 'group', label: 'Group by', default: 'category', options: [{ value: 'category', label: 'Category' }, { value: 'tech', label: 'Technician' }, { value: 'list', label: 'Each job' }] }],
  definitions: [{ term: 'To assign', text: 'Hours from raised until it was assigned.' }, { term: 'To start', text: 'Hours from raised until work started.' }, { term: 'To finish', text: 'Hours from raised until it was marked done.' }, { term: 'Average', text: 'Mean of the jobs that have that time. A job never assigned or started is left out of that column.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT w.number, ${sql.raw(ROOM)} AS where_, w.category, w.title, w.priority, u.full_name AS tech, extract(epoch FROM (w.assigned_at - w.created_at))*1000 AS a, extract(epoch FROM (w.started_at - w.created_at))*1000 AS s, extract(epoch FROM (w.done_at - w.created_at))*1000 AS d
      FROM work_order w LEFT JOIN room rm ON rm.id = w.room_id LEFT JOIN staff_user u ON u.id = coalesce(w.done_by, w.assigned_to) WHERE w.tenant_id = ${c.tenantId} AND w.property_id = ${c.propertyId} AND w.done_at IS NOT NULL AND (w.done_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date`.execute(c.trx);
    const jobs = r.rows.map((x): Record<string, any> & { a: number | null; s: number | null; d: number } => ({ ...x, a: x.a == null ? null : Math.max(0, Number(x.a)), s: x.s == null ? null : Math.max(0, Number(x.s)), d: Math.max(0, Number(x.d)) }));
    const avg = (xs: Array<number | null>) => { const v = xs.filter((y): y is number => y != null); return v.length ? hours(v.reduce((p, q) => p + q, 0) / v.length) : null; };
    const g = c.params.group ?? 'category'; const kp = [{ key: 'n', label: 'Jobs finished', value: jobs.length, type: 'int' as const, definition: 'Jobs marked done in the period.' }, { key: 'fin', label: 'Average to finish (hours)', value: avg(jobs.map((x) => x.d)) ?? 0, type: 'int' as const, definition: 'Hours from raised to done.' }, { key: 'start', label: 'Average to start (hours)', value: avg(jobs.map((x) => x.s)) ?? 0, type: 'int' as const, definition: 'Hours from raised to started.' }];
    const cols = (first: string) => [{ key: 'what', label: first }, { key: 'n', label: 'Jobs', type: 'int' as const, total: true }, { key: 'toAssign', label: 'To assign (h)', type: 'text' as const }, { key: 'toStart', label: 'To start (h)', type: 'text' as const }, { key: 'toDone', label: 'To finish (h)', type: 'text' as const }];
    if (g === 'list') return { kpis: kp, columns: [{ key: 'no', label: 'Job' }, { key: 'where', label: 'Room or area' }, { key: 'cat', label: 'Category' }, { key: 'title', label: 'Problem' }, { key: 'tech', label: 'Done by' }, { key: 'toAssign', label: 'To assign (h)', type: 'text' }, { key: 'toStart', label: 'To start (h)', type: 'text' }, { key: 'toDone', label: 'To finish (h)', type: 'text' }],
      rows: jobs.map((x): Row => ({ no: x.number, where: x.where_, cat: CAT[x.category] ?? x.category, title: x.title, tech: x.tech ?? '', toAssign: x.a == null ? '' : String(hours(x.a)), toStart: x.s == null ? '' : String(hours(x.s)), toDone: String(hours(x.d)) })) };
    const map = new Map<string, typeof jobs>(); for (const x of jobs) { const k = g === 'tech' ? x.tech ?? 'Not recorded' : CAT[x.category] ?? x.category; map.set(k, [...(map.get(k) ?? []), x]); }
    const rows: Row[] = [...map.entries()].map(([k, xs]) => ({ what: k, n: xs.length, toAssign: String(avg(xs.map((x) => x.a)) ?? ''), toStart: String(avg(xs.map((x) => x.s)) ?? ''), toDone: String(avg(xs.map((x) => x.d)) ?? '') })).sort((p, q) => Number(q.n) - Number(p.n));
    return { kpis: kp, columns: cols(g === 'tech' ? 'Technician' : 'Category'), rows };
  },
};

export const repeatFaults: Def = {
  id: 'repeat-faults', name: 'Repeat faults', category: 'rooms', kind: 'analytical', permissions: ['maintenance.view', 'report.view'], roles: ['maintenance', 'manager'],
  purpose: 'Rooms and areas where the same kind of fault keeps coming back, so the cause can be fixed once.',
  basis: [{ id: 'raised', label: 'Date the job was raised' }], range: 'last30',
  definitions: [{ term: 'Repeat fault', text: 'The same room (or area) and category with two or more repair jobs raised in the period. Preventive jobs are left out; cancelled and rejected jobs are left out.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT ${sql.raw(ROOM)} AS where_, w.category, count(*)::int AS n, min(w.created_at::date)::text AS first, max(w.created_at::date)::text AS last, coalesce(sum(w.cost_minor),0)::text AS cost, string_agg(w.title, ' · ' ORDER BY w.created_at) AS titles
      FROM work_order w LEFT JOIN room rm ON rm.id = w.room_id WHERE w.tenant_id = ${c.tenantId} AND w.property_id = ${c.propertyId} AND w.kind = 'CORRECTIVE' AND w.status NOT IN ('CANCELLED','REJECTED') AND (w.created_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date AND (w.room_id IS NOT NULL OR w.area IS NOT NULL)
      GROUP BY ${sql.raw(ROOM)}, w.category HAVING count(*) >= 2 ORDER BY count(*) DESC, 1`.execute(c.trx);
    const rows: Row[] = r.rows.map((x): Row => ({ where: x.where_, cat: CAT[x.category] ?? x.category, n: x.n, first: x.first, last: x.last, cost: x.cost, titles: x.titles }));
    return { kpis: [{ key: 'n', label: 'Repeating faults', value: rows.length, type: 'int', tone: rows.length ? 'warn' : 'ok', definition: 'Room and category pairs with two or more jobs.' }, { key: 'jobs', label: 'Jobs involved', value: rows.reduce((s, x) => s + Number(x.n), 0), type: 'int', definition: 'Repair jobs across those pairs.' }, { key: 'cost', label: 'Cost so far', value: dec(rows.reduce((s, x) => s + BigInt(x.cost as string), 0n)), type: 'money', definition: 'Recorded cost of those jobs.' }],
      columns: [{ key: 'where', label: 'Room or area' }, { key: 'cat', label: 'Category' }, { key: 'n', label: 'Jobs', type: 'int', total: true }, { key: 'first', label: 'First', type: 'date' }, { key: 'last', label: 'Latest', type: 'date' }, { key: 'cost', label: 'Cost', type: 'money', total: true }, { key: 'titles', label: 'What was reported' }], rows };
  },
};

export const downtime: Def = {
  id: 'room-downtime', name: 'Out-of-order rooms and lost sellable nights', category: 'rooms', kind: 'operational', permissions: ['maintenance.view', 'housekeeping.view', 'report.view'], roles: ['maintenance', 'manager', 'housekeeping'],
  purpose: 'Rooms taken out of sale: why, for how long, and the room nights that could not be sold.',
  basis: [{ id: 'stay', label: 'Night' }], range: 'month',
  definitions: [{ term: 'Out of order', text: 'The room cannot be used: it is not sellable.' }, { term: 'Out of service', text: 'The room is held back for a short time, for example for cleaning or minor work.' }, { term: 'Lost sellable nights', text: 'Nights in the period that the room was blocked. Cancelled blocks are left out. Revenue lost is not estimated.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT rm.number, rt.name AS rtype, b.block_type, b.start_date::text AS s, b.end_date::text AS e, b.reason, b.ticket_ref, u.full_name AS by,
        (least(b.end_date, (${c.to}::date + 1)) - greatest(b.start_date, ${c.from}::date))::int AS nights, (SELECT count(*) FROM room WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND status = 'ACTIVE')::int AS total_rooms
      FROM room_block b JOIN room rm ON rm.id = b.room_id JOIN room_type rt ON rt.id = rm.room_type_id LEFT JOIN staff_user u ON u.id = b.created_by
      WHERE b.tenant_id = ${c.tenantId} AND b.property_id = ${c.propertyId} AND b.cancelled_at IS NULL AND b.start_date <= ${c.to}::date AND b.end_date > ${c.from}::date ORDER BY b.start_date, rm.number`.execute(c.trx);
    const rows: Row[] = r.rows.map((x): Row => ({ room: x.number, rtype: x.rtype, kind: x.block_type === 'OUT_OF_ORDER' ? 'Out of order' : 'Out of service', from: x.s, to: x.e, nights: Math.max(0, x.nights), reason: x.reason, ticket: x.ticket_ref ?? '', by: x.by ?? '' }));
    const days = Math.round((Date.parse(`${c.to}T00:00:00Z`) - Date.parse(`${c.from}T00:00:00Z`)) / 86_400_000) + 1; const total = r.rows[0]?.total_rooms ?? 0; const lost = rows.reduce((s, x) => s + Number(x.nights), 0);
    return { kpis: [{ key: 'lost', label: 'Lost sellable nights', value: lost, type: 'int', tone: lost ? 'warn' : 'ok', definition: 'Blocked room nights in the period.' }, { key: 'ooo', label: 'Out of order nights', value: rows.filter((x) => x.kind === 'Out of order').reduce((s, x) => s + Number(x.nights), 0), type: 'int', definition: 'Nights not sellable at all.' }, { key: 'pct', label: '% of room nights', value: total ? pctOf(lost, total * days) : 0, type: 'pct', definition: 'Lost nights ÷ (active rooms × days).' }],
      columns: [{ key: 'room', label: 'Room' }, { key: 'rtype', label: 'Type', hidden: true }, { key: 'kind', label: 'Block', type: 'badge' }, { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'Until (not incl.)', type: 'date' }, { key: 'nights', label: 'Nights in period', type: 'int', total: true }, { key: 'reason', label: 'Reason' }, { key: 'ticket', label: 'Job', hidden: true }, { key: 'by', label: 'Blocked by', hidden: true }], rows,
      notes: ['The revenue lost while a room is blocked is not estimated: it depends on what would have sold.'] };
  },
};

export const notReady: Def = {
  id: 'rooms-not-ready', name: 'Rooms not ready for arrival', category: 'rooms', kind: 'operational', permissions: ['housekeeping.view', 'reservation.view'], roles: ['housekeeping', 'frontdesk', 'manager'],
  purpose: 'Today’s expected arrivals whose room is not clean yet, is blocked, or has not been assigned.',
  basis: [{ id: 'now', label: 'Today' }], range: 'none',
  definitions: [{ term: 'Not ready', text: 'The assigned room is dirty or being cleaned, or is out of order or service tonight.' }, { term: 'Unassigned', text: 'No room has been chosen for the booking yet.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, rt.name AS rtype, to_char(r.expected_arrival, 'HH24:MI') AS eta, rm.number, rm.hk_status, rm.dnd,
        EXISTS (SELECT 1 FROM room_block b WHERE b.room_id = rm.id AND b.cancelled_at IS NULL AND b.start_date <= ${c.prop.businessDate}::date AND b.end_date > ${c.prop.businessDate}::date) AS blocked
      FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id JOIN room_type rt ON rt.id = l.room_type_id
        LEFT JOIN LATERAL (SELECT a.room_id FROM room_assignment a WHERE a.assignment_ref = l.id AND a.status = 'ASSIGNED' ORDER BY a.created_at DESC LIMIT 1) asg ON true LEFT JOIN room rm ON rm.id = asg.room_id
      WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.status = 'CONFIRMED' AND l.arrival = ${c.prop.businessDate}::date ORDER BY r.expected_arrival NULLS LAST, g.full_name`.execute(c.trx);
    const HK: Record<string, string> = { CLEAN: 'Clean', DIRTY: 'Dirty', CLEANING: 'Being cleaned', INSPECTED: 'Inspected' };
    const rows: Row[] = r.rows.map((x): Row => { const state = !x.number ? 'No room assigned' : x.blocked ? 'Room blocked' : x.hk_status === 'DIRTY' || x.hk_status === 'CLEANING' ? 'Not ready' : 'Ready'; return { _res: x.rid, conf: x.conf, guest: x.guest, rtype: x.rtype, eta: x.eta ?? '', room: x.number ?? '', hk: x.number ? HK[x.hk_status] ?? x.hk_status : '', dnd: x.dnd ? 'Do not disturb' : '', state }; });
    const bad = rows.filter((x) => x.state !== 'Ready');
    return { kpis: [{ key: 'n', label: 'Arrivals today', value: rows.length, type: 'int', definition: 'Confirmed bookings arriving today.' }, { key: 'bad', label: 'Not ready or unassigned', value: bad.length, type: 'int', tone: bad.length ? 'warn' : 'ok', definition: 'Arrivals whose room is not ready, is blocked or is not assigned.' }],
      columns: [{ key: 'eta', label: 'Expected', type: 'time' }, { key: 'guest', label: 'Guest' }, { key: 'conf', label: 'Booking' }, { key: 'rtype', label: 'Room type' }, { key: 'room', label: 'Room' }, { key: 'hk', label: 'Housekeeping' }, { key: 'dnd', label: 'DND', hidden: true }, { key: 'state', label: 'State', type: 'badge' }], rows };
  },
};

const TYPE: Record<string, string> = { CHECKOUT_CLEAN: 'Checkout clean', STAYOVER: 'Stayover', ARRIVAL_PREP: 'Arrival prep', DEEP_CLEAN: 'Deep clean', ON_DEMAND: 'On demand' };
export const hkProgress: Def = {
  id: 'housekeeping-progress', name: 'Housekeeping progress, turnaround and inspections', category: 'rooms', kind: 'operational', permissions: ['housekeeping.view', 'report.view'], roles: ['housekeeping', 'manager'],
  purpose: 'Cleaning tasks by attendant or type: done, in progress, pending or skipped, how long each clean took, and how many failed inspection and had to be redone.',
  basis: [{ id: 'date', label: 'Task business date' }], range: 'today',
  params: [{ key: 'group', label: 'Group by', default: 'staff', options: [{ value: 'staff', label: 'Attendant' }, { value: 'type', label: 'Task type' }, { value: 'list', label: 'Each task' }, { value: 'failed', label: 'Failed inspections' }] }],
  definitions: [{ term: 'Average clean time', text: 'Minutes from started to finished, for tasks that have both. Skipped and cancelled tasks are left out.' }, { term: 'Failed inspection', text: 'The supervisor inspected the room and it did not pass. It goes back to be cleaned again.' }, { term: 'Re-cleans', text: 'How many times a task was sent back after an inspection.' }, { term: 'Pass rate', text: 'Passed ÷ (passed + failed) among inspected tasks.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT t.id, rm.number, t.task_type, t.status, t.inspection, t.rework_count AS rework, t.skip_reason, t.inspection_note, u.full_name AS who, iu.full_name AS inspector, ${local(sql.raw('t.started_at'), c)} AS started, ${local(sql.raw('t.finished_at'), c)} AS finished, extract(epoch FROM (t.finished_at - t.started_at))/60 AS mins, t.business_date::text AS bd
      FROM housekeeping_task t JOIN room rm ON rm.id = t.room_id LEFT JOIN staff_user u ON u.id = t.assigned_to LEFT JOIN staff_user iu ON iu.id = t.inspected_by WHERE t.tenant_id = ${c.tenantId} AND t.property_id = ${c.propertyId} AND t.business_date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY t.business_date DESC, rm.number`.execute(c.trx);
    const g = c.params.group ?? 'staff'; const tasks = r.rows; const insp = tasks.filter((x) => x.inspection === 'PASSED' || x.inspection === 'FAILED'); const failed = insp.filter((x) => x.inspection === 'FAILED').length;
    const timed = tasks.filter((x) => x.mins != null && x.status === 'DONE').map((x) => Number(x.mins)); const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((p, q) => p + q, 0) / xs.length) : 0);
    const kpis = [{ key: 'n', label: 'Tasks', value: tasks.length, type: 'int' as const, definition: 'Cleaning tasks in the period.' }, { key: 'done', label: 'Done', value: tasks.filter((x) => x.status === 'DONE').length, type: 'int' as const, definition: 'Finished tasks.' }, { key: 'avg', label: 'Average clean (min)', value: mean(timed), type: 'int' as const, definition: 'Started to finished.' }, { key: 'fail', label: 'Failed inspections', value: failed, type: 'int' as const, tone: failed ? ('warn' as const) : ('ok' as const), definition: 'Inspected and not passed.' }, { key: 'pass', label: 'Pass rate', value: pctOf(insp.length - failed, insp.length), type: 'pct' as const, definition: 'Passed ÷ inspected.' }];
    const ST: Record<string, string> = { PENDING: 'Pending', IN_PROGRESS: 'In progress', DONE: 'Done', SKIPPED: 'Skipped', CANCELLED: 'Cancelled' };
    const detail = (x: Record<string, any>): Row => ({ bd: x.bd, room: x.number, type: TYPE[x.task_type] ?? x.task_type, who: x.who ?? 'Not assigned', status: ST[x.status] ?? x.status, started: x.started ?? '', finished: x.finished ?? '', mins: x.mins == null ? '' : String(Math.round(Number(x.mins))), insp: x.inspection === 'PASSED' ? 'Passed' : x.inspection === 'FAILED' ? 'Failed' : x.inspection === 'PENDING' ? 'Waiting' : '', rework: x.rework, note: x.inspection_note ?? x.skip_reason ?? '', inspector: x.inspector ?? '' });
    const dcols = [{ key: 'bd', label: 'Date', type: 'date' as const }, { key: 'room', label: 'Room' }, { key: 'type', label: 'Task' }, { key: 'who', label: 'Attendant' }, { key: 'status', label: 'Status', type: 'badge' as const }, { key: 'started', label: 'Started', type: 'datetime' as const, hidden: true }, { key: 'finished', label: 'Finished', type: 'datetime' as const, hidden: true }, { key: 'mins', label: 'Minutes', type: 'int' as const }, { key: 'insp', label: 'Inspection', type: 'badge' as const }, { key: 'rework', label: 'Re-cleans', type: 'int' as const, total: true }, { key: 'inspector', label: 'Inspector', hidden: true }, { key: 'note', label: 'Note' }];
    if (g === 'list') return { kpis, columns: dcols, rows: tasks.map(detail) };
    if (g === 'failed') return { kpis, columns: dcols, rows: tasks.filter((x) => x.inspection === 'FAILED' || Number(x.rework) > 0).map(detail) };
    const map = new Map<string, typeof tasks>(); for (const x of tasks) { const k = g === 'type' ? TYPE[x.task_type] ?? x.task_type : x.who ?? 'Not assigned'; map.set(k, [...(map.get(k) ?? []), x]); }
    const rows: Row[] = [...map.entries()].map(([k, xs]) => { const i = xs.filter((x) => x.inspection === 'PASSED' || x.inspection === 'FAILED'); const f = i.filter((x) => x.inspection === 'FAILED').length; return { what: k, n: xs.length, done: xs.filter((x) => x.status === 'DONE').length, prog: xs.filter((x) => x.status === 'IN_PROGRESS').length, pend: xs.filter((x) => x.status === 'PENDING').length, skip: xs.filter((x) => x.status === 'SKIPPED').length, avg: mean(xs.filter((x) => x.mins != null && x.status === 'DONE').map((x) => Number(x.mins))), failed: f, pass: pctOf(i.length - f, i.length) }; }).sort((p, q) => Number(q.n) - Number(p.n));
    return { kpis, rows, chart: { kind: 'bar', x: 'what', series: [{ key: 'done', label: 'Done' }] }, columns: [{ key: 'what', label: g === 'type' ? 'Task type' : 'Attendant' }, { key: 'n', label: 'Tasks', type: 'int', total: true }, { key: 'done', label: 'Done', type: 'int', total: true }, { key: 'prog', label: 'In progress', type: 'int', total: true }, { key: 'pend', label: 'Pending', type: 'int', total: true }, { key: 'skip', label: 'Skipped', type: 'int', total: true }, { key: 'avg', label: 'Avg clean (min)', type: 'int' }, { key: 'failed', label: 'Failed inspections', type: 'int', total: true }, { key: 'pass', label: 'Pass rate', type: 'pct' }],
      notes: ['Linen, amenity and minibar use is not recorded yet.'] };
  },
};
