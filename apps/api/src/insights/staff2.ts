import { sql } from 'kysely';
import type { Def, Row } from './types.js';
import { local, pctOf } from './util.js';

const SH: Record<string, string> = { MORNING: 'Morning', EVENING: 'Evening', NIGHT: 'Night' };
const hrs = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

export const handovers: Def = {
  id: 'shift-handover', name: 'Shift handover', category: 'staff', kind: 'operational', permissions: ['reservation.view', 'report.view'], roles: ['frontdesk', 'manager'],
  purpose: 'The notes each shift left for the next: who wrote them, what is still open, and who read them and how soon.',
  basis: [{ id: 'bd', label: 'Business date' }], range: 'last30',
  params: [{ key: 'view', label: 'Show', default: 'all', options: [{ value: 'all', label: 'All handovers' }, { value: 'unread', label: 'Not read yet' }, { value: 'open', label: 'With open items' }] }],
  definitions: [{ term: 'Read', text: 'Someone other than the author marked it read.' }, { term: 'Hours to read', text: 'From written to marked read.' }, { term: 'Open items', text: 'Things the author listed that nobody has ticked off.' }, { term: 'Days with no handover', text: 'Business dates in the period with no handover written at all.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT h.business_date::text AS d, h.shift, a.full_name AS author, h.notes, h.items, ak.full_name AS reader, ${local(sql.raw('h.created_at'), c)} AS at, extract(epoch FROM (h.acknowledged_at - h.created_at))*1000 AS ms
      FROM shift_handover h JOIN staff_user a ON a.id = h.author_id LEFT JOIN staff_user ak ON ak.id = h.acknowledged_by WHERE h.tenant_id = ${c.tenantId} AND h.property_id = ${c.propertyId} AND h.business_date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY h.created_at DESC`.execute(c.trx);
    const openOf = (x: Record<string, any>) => ((x.items as Array<{ done: boolean }>) ?? []).filter((i) => !i.done).length; const totOf = (x: Record<string, any>) => ((x.items as unknown[]) ?? []).length;
    let rows = r.rows; const v = c.params.view ?? 'all'; if (v === 'unread') rows = rows.filter((x) => !x.reader); else if (v === 'open') rows = rows.filter((x) => openOf(x) > 0);
    const have = new Set(r.rows.map((x) => x.d)); const span = Math.round((Date.parse(`${c.to}T00:00:00Z`) - Date.parse(`${c.from}T00:00:00Z`)) / 86_400_000) + 1; const missing = Math.max(0, Math.min(span, 400) - have.size);
    const read = r.rows.filter((x) => x.ms != null);
    return { kpis: [{ key: 'n', label: 'Handovers', value: r.rows.length, type: 'int', definition: 'Written in the period.' }, { key: 'un', label: 'Not read yet', value: r.rows.filter((x) => !x.reader).length, type: 'int', tone: r.rows.some((x) => !x.reader) ? 'warn' : 'ok', definition: 'Nobody has marked them read.' }, { key: 'op', label: 'Open items', value: r.rows.reduce((s, x) => s + openOf(x), 0), type: 'int', definition: 'Listed and not ticked off.' }, { key: 'rd', label: 'Average hours to read', value: read.length ? hrs(read.reduce((s, x) => s + Number(x.ms), 0) / read.length) : 0, type: 'int', definition: 'Written to read.' }, { key: 'miss', label: 'Days with no handover', value: missing, type: 'int', tone: missing ? 'warn' : 'ok', definition: 'Business dates with none written.' }],
      columns: [{ key: 'at', label: 'Written', type: 'datetime' }, { key: 'd', label: 'Business date', type: 'date', hidden: true }, { key: 'shift', label: 'Shift', type: 'badge' }, { key: 'author', label: 'Author' }, { key: 'notes', label: 'Notes' }, { key: 'open', label: 'Open items', type: 'int', total: true }, { key: 'items', label: 'Items', type: 'int', hidden: true }, { key: 'reader', label: 'Read by' }, { key: 'hours', label: 'Hours to read', type: 'text' }],
      rows: rows.map((x): Row => ({ at: x.at, d: x.d, shift: SH[x.shift] ?? x.shift, author: x.author, notes: x.notes, open: openOf(x), items: totOf(x), reader: x.reader ?? '', hours: x.ms == null ? '' : String(hrs(Number(x.ms))) })) };
  },
};

const ACTIONS: Array<[string, string]> = [['frontdesk.check_in', 'Check-ins'], ['frontdesk.check_out', 'Check-outs'], ['reservation.create', 'Bookings made'], ['payment.record', 'Payments taken'], ['frontdesk.room_move', 'Room moves'], ['reservation.cancel', 'Cancellations'], ['folio.charge', 'Charges posted']];
export const workload: Def = {
  id: 'front-desk-workload', name: 'Front-desk workload', category: 'staff', kind: 'analytical', permissions: ['audit.view', 'report.view'], roles: ['manager'], sensitive: true,
  purpose: 'How much work each person did at the desk and on which days: check-ins, check-outs, bookings, payments, moves and charges.',
  basis: [{ id: 'when', label: 'Date of the action' }], range: 'last30',
  params: [{ key: 'group', label: 'Group by', default: 'user', options: [{ value: 'user', label: 'Person' }, { value: 'day', label: 'Day' }] }],
  definitions: [{ term: 'Count', text: 'Actions recorded in the audit trail under that person’s name. It is a count of work done, not a measure of how good it was or how long it took.' }, { term: 'Cancellations', text: 'Counted from the audit trail, which records the cancelling action for a whole booking.' }],
  async run(c) {
    const keys = ACTIONS.map((a) => a[0]);
    const r = await sql<Record<string, any>>`SELECT coalesce(u.full_name, 'System') AS who, (a.occurred_at AT TIME ZONE ${c.prop.timezone})::date::text AS d, a.action, count(*)::int AS n
      FROM audit_log a LEFT JOIN staff_user u ON u.id = a.actor_id WHERE a.tenant_id = ${c.tenantId} AND (a.property_id = ${c.propertyId}) AND a.action = ANY(${keys}) AND (a.occurred_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY 1, 2, 3`.execute(c.trx);
    const g = c.params.group ?? 'user'; const map = new Map<string, Record<string, number>>();
    for (const x of r.rows) { const k = g === 'day' ? x.d : x.who; const e = map.get(k) ?? {}; e[x.action] = (e[x.action] ?? 0) + x.n; map.set(k, e); }
    const rows: Row[] = [...map.entries()].map(([k, e]) => { const row: Row = { what: k }; let t = 0; for (const [a, label] of ACTIONS) { row[a.replace(/\./g, '_')] = e[a] ?? 0; t += e[a] ?? 0; void label; } row.total = t; return row; }).sort((p, q) => (g === 'day' ? String(p.what).localeCompare(String(q.what)) : Number(q.total) - Number(p.total)));
    return { kpis: [{ key: 'n', label: 'Actions', value: rows.reduce((s, x) => s + Number(x.total), 0), type: 'int', definition: 'All counted actions.' }, { key: 'p', label: g === 'day' ? 'Days' : 'People', value: rows.length, type: 'int', definition: 'Rows in the view.' }],
      columns: [{ key: 'what', label: g === 'day' ? 'Day' : 'Person', ...(g === 'day' ? { type: 'date' as const } : {}) }, ...ACTIONS.map(([a, label]) => ({ key: a.replace(/\./g, '_'), label, type: 'int' as const, total: true })), { key: 'total', label: 'All', type: 'int' as const, total: true }], rows, chart: { kind: g === 'day' ? 'line' : 'bar', x: 'what', series: [{ key: 'total', label: 'Actions' }] },
      notes: ['Time spent and queue waiting are not recorded, so this cannot show how busy a shift felt. Staffing forecasts need a roster, which the system does not keep.'] };
  },
};

export const sla: Def = {
  id: 'sla-performance', name: 'SLA performance', category: 'staff', kind: 'analytical', permissions: ['case.view', 'maintenance.view', 'report.view'], roles: ['manager'],
  purpose: 'Whether promised response times were met: complaints and incidents against their response target, and maintenance jobs against their due date.',
  basis: [{ id: 'raised', label: 'Date raised' }], range: 'last30',
  definitions: [{ term: 'Case target', text: 'Critical 4 hours, high 24, medium 72, low 7 days from when it was reported.' }, { term: 'Job target', text: 'The due date set on the maintenance job. Jobs with no due date are left out.' }, { term: 'On time', text: 'Finished by its target.' }, { term: 'Late', text: 'Finished after its target.' }, { term: 'Overdue', text: 'Still open past its target.' }, { term: 'Restricted cases', text: 'Left out unless you hold the restricted permission.' }],
  async run(c) {
    const cs = await sql<Record<string, any>>`SELECT k.severity AS g, count(*)::int AS n, count(*) FILTER (WHERE k.resolved_at IS NOT NULL AND k.resolved_at <= k.sla_due_at)::int AS ontime, count(*) FILTER (WHERE k.resolved_at IS NOT NULL AND k.resolved_at > k.sla_due_at)::int AS late, count(*) FILTER (WHERE k.resolved_at IS NULL AND k.sla_due_at < now())::int AS overdue, count(*) FILTER (WHERE k.resolved_at IS NULL AND k.sla_due_at >= now())::int AS open
      FROM case_record k WHERE k.tenant_id = ${c.tenantId} AND k.property_id = ${c.propertyId} ${c.canRestricted ? sql`` : sql`AND k.confidentiality = 'NORMAL'`} AND (k.reported_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY 1`.execute(c.trx);
    const wo = await sql<Record<string, any>>`SELECT w.priority AS g, count(*)::int AS n, count(*) FILTER (WHERE w.done_at IS NOT NULL AND (w.done_at AT TIME ZONE ${c.prop.timezone})::date <= w.due_date)::int AS ontime, count(*) FILTER (WHERE w.done_at IS NOT NULL AND (w.done_at AT TIME ZONE ${c.prop.timezone})::date > w.due_date)::int AS late, count(*) FILTER (WHERE w.done_at IS NULL AND w.status IN ('REQUESTED','OPEN','ASSIGNED','IN_PROGRESS','WAITING') AND w.due_date < ${c.prop.businessDate}::date)::int AS overdue, count(*) FILTER (WHERE w.done_at IS NULL AND w.status IN ('REQUESTED','OPEN','ASSIGNED','IN_PROGRESS','WAITING') AND w.due_date >= ${c.prop.businessDate}::date)::int AS open
      FROM work_order w WHERE w.tenant_id = ${c.tenantId} AND w.property_id = ${c.propertyId} AND w.due_date IS NOT NULL AND w.status NOT IN ('CANCELLED','REJECTED') AND (w.created_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY 1`.execute(c.trx);
    const SEV: Record<string, string> = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' }; const PRI: Record<number, string> = { 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };
    const mk = (kind: string, x: Record<string, any>, label: string): Row => ({ kind, grp: label, n: x.n, ontime: x.ontime, late: x.late, overdue: x.overdue, open: x.open, pct: pctOf(x.ontime, x.ontime + x.late + x.overdue) });
    const rows: Row[] = [...cs.rows.map((x) => mk('Complaints and incidents', x, SEV[x.g] ?? x.g)), ...wo.rows.sort((a, b) => a.g - b.g).map((x) => mk('Maintenance jobs', x, PRI[x.g] ?? String(x.g)))];
    const s = (k: string) => rows.reduce((t, x) => t + Number(x[k]), 0);
    return { kpis: [{ key: 'n', label: 'Items with a target', value: s('n'), type: 'int', definition: 'Cases and jobs raised in the period.' }, { key: 'pct', label: 'On time', value: pctOf(s('ontime'), s('ontime') + s('late') + s('overdue')), type: 'pct', definition: 'On time ÷ (on time + late + overdue). Items still inside their target are not counted either way.' }, { key: 'od', label: 'Overdue now', value: s('overdue'), type: 'int', tone: s('overdue') ? 'bad' : 'ok', definition: 'Open past the target.' }],
      columns: [{ key: 'kind', label: 'Kind' }, { key: 'grp', label: 'Severity or priority' }, { key: 'n', label: 'Raised', type: 'int', total: true }, { key: 'ontime', label: 'On time', type: 'int', total: true }, { key: 'late', label: 'Late', type: 'int', total: true }, { key: 'overdue', label: 'Overdue now', type: 'int', total: true }, { key: 'open', label: 'Still inside target', type: 'int', total: true }, { key: 'pct', label: 'On time %', type: 'pct' }], rows,
      warnings: c.canRestricted ? [] : ['Restricted cases are not counted.'], notes: ['Guest requests have no response target in the system, so they are not part of this report.'] };
  },
};
