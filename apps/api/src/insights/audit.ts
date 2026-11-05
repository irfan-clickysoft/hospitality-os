import { sql } from 'kysely';
import type { Def, Row } from './types.js';
import { dec, local } from './util.js';

const nice = (a: string) => { const t = a.replace(/[._]/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
const ACT = sql.raw(`a.action`);

/** Events in the audit trail that belong to this property, or to the whole company (sign-ins, users). */
const scope = (c: { tenantId: string; propertyId: string }) => sql`a.tenant_id = ${c.tenantId} AND (a.property_id = ${c.propertyId} OR a.property_id IS NULL)`;
const dates = (c: { from: string; to: string; prop: { timezone: string } }) => sql`(a.occurred_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date`;

export const userActivity: Def = {
  id: 'user-activity', name: 'User activity log', category: 'audit', kind: 'audit', permissions: ['audit.view'], roles: ['manager'], sensitive: true,
  purpose: 'What each person did in the system: totals by person, by kind of action, by day, or every event in time order.',
  basis: [{ id: 'when', label: 'Date of the event' }], range: 'today',
  params: [{ key: 'group', label: 'Group by', default: 'user', options: [{ value: 'user', label: 'Person' }, { value: 'action', label: 'Kind of action' }, { value: 'day', label: 'Day' }, { value: 'list', label: 'Every event' }] }],
  definitions: [{ term: 'Event', text: 'One line in the audit trail: a sign-in, a booking change, a payment, a check-in and so on. Events with no property (sign-ins, users and roles) are included.' }, { term: 'System', text: 'Events done by the system itself, such as night audit.' }, { term: 'Not an hours report', text: 'It counts actions, not time worked.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT a.action, a.resource_type AS res, a.actor_type AS atype, coalesce(u.full_name, CASE WHEN a.actor_type = 'SYSTEM' THEN 'System' ELSE 'Unknown' END) AS who, a.note, a.reason_code AS reason, ${local(sql.raw('a.occurred_at'), c)} AS at, (a.occurred_at AT TIME ZONE ${c.prop.timezone})::date::text AS d
      FROM audit_log a LEFT JOIN staff_user u ON u.id = a.actor_id WHERE ${scope(c)} AND ${dates(c)} ORDER BY a.occurred_at DESC LIMIT 20000`.execute(c.trx);
    const g = c.params.group ?? 'user'; const rows = r.rows;
    const kp = [{ key: 'n', label: 'Events', value: rows.length, type: 'int' as const, definition: 'Audit-trail events in the period.' }, { key: 'u', label: 'People', value: new Set(rows.map((x) => x.who)).size, type: 'int' as const, definition: 'Different people (or the system) who did something.' }, { key: 'f', label: 'Failed sign-ins and MFA', value: rows.filter((x) => x.action === 'auth.mfa_failed' || x.action === 'auth.login_while_locked').length, type: 'int' as const, tone: rows.some((x) => x.action === 'auth.mfa_failed' || x.action === 'auth.login_while_locked') ? ('warn' as const) : ('ok' as const), definition: 'Wrong second-factor codes and sign-in attempts on a locked account.' }];
    const warn = rows.length >= 20000 ? ['Only the latest 20,000 events are shown. Narrow the dates.'] : [];
    if (g === 'list') return { kpis: kp, warnings: warn, columns: [{ key: 'at', label: 'When', type: 'datetime' }, { key: 'who', label: 'Person' }, { key: 'action', label: 'Action' }, { key: 'res', label: 'On', hidden: true }, { key: 'why', label: 'Reason' }, { key: 'note', label: 'Note', hidden: true }], rows: rows.map((x): Row => ({ at: x.at, who: x.who, action: nice(x.action), res: x.res, why: x.reason ?? '', note: x.note ?? '' })) };
    const map = new Map<string, { n: number; acts: Map<string, number> }>(); for (const x of rows) { const k = g === 'user' ? x.who : g === 'day' ? x.d : nice(x.action); const e = map.get(k) ?? { n: 0, acts: new Map() }; e.n++; e.acts.set(nice(x.action), (e.acts.get(nice(x.action)) ?? 0) + 1); map.set(k, e); }
    const out: Row[] = [...map.entries()].sort((a, b) => (g === 'day' ? a[0].localeCompare(b[0]) : b[1].n - a[1].n)).map(([k, e]) => ({ what: k, n: e.n, top: [...e.acts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, n]) => `${a} (${n})`).join(', ') }));
    return { kpis: kp, warnings: warn, rows: out, chart: { kind: g === 'day' ? 'line' : 'bar', x: 'what', series: [{ key: 'n', label: 'Events' }] }, columns: [{ key: 'what', label: g === 'user' ? 'Person' : g === 'day' ? 'Day' : 'Action', ...(g === 'day' ? { type: 'date' as const } : {}) }, { key: 'n', label: 'Events', type: 'int', total: true }, { key: 'top', label: 'Most common' }] };
  },
};

export const reservationAudit: Def = {
  id: 'reservation-audit', name: 'Reservation audit', category: 'audit', kind: 'audit', permissions: ['audit.view'], roles: ['manager'], sensitive: true,
  purpose: 'Every change to a booking: created, confirmed, moved, extended, cancelled, checked in or out, with who, when, and the reason.',
  basis: [{ id: 'when', label: 'Date of the change' }], range: 'today',
  params: [{ key: 'view', label: 'Show', default: 'all', options: [{ value: 'all', label: 'All changes' }, { value: 'cancel', label: 'Cancellations and no-shows' }, { value: 'status', label: 'Status changes' }, { value: 'reason', label: 'Only changes with a reason' }] }],
  definitions: [{ term: 'Change', text: 'One line in a booking’s history. Nothing is ever removed from a booking’s history.' }, { term: 'From → to', text: 'The status before and after, where the change moved the booking to a new status.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT h.action, h.from_status AS f, h.to_status AS t, h.reason, ${local(sql.raw('h.occurred_at'), c)} AS at, u.full_name AS who, r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, rm.line_no AS line
      FROM reservation_history h JOIN reservation r ON r.tenant_id = h.tenant_id AND r.id = h.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id LEFT JOIN reservation_room rm ON rm.id = h.reservation_room_id LEFT JOIN staff_user u ON u.id = h.actor_id
      WHERE h.tenant_id = ${c.tenantId} AND h.property_id = ${c.propertyId} AND (h.occurred_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY h.occurred_at DESC LIMIT 10000`.execute(c.trx);
    let rows = r.rows; const v = c.params.view ?? 'all';
    if (v === 'cancel') rows = rows.filter((x) => x.t === 'CANCELLED' || x.t === 'NO_SHOW' || /cancel|no.?show/i.test(x.action)); else if (v === 'status') rows = rows.filter((x) => x.f && x.t && x.f !== x.t); else if (v === 'reason') rows = rows.filter((x) => x.reason);
    return { kpis: [{ key: 'n', label: 'Changes', value: rows.length, type: 'int', definition: 'Booking history lines in the view.' }, { key: 'b', label: 'Bookings touched', value: new Set(rows.map((x) => x.rid)).size, type: 'int', definition: 'Different bookings changed.' }, { key: 'u', label: 'People', value: new Set(rows.map((x) => x.who ?? 'System')).size, type: 'int', definition: 'People (or the system) who made changes.' }],
      columns: [{ key: 'at', label: 'When', type: 'datetime' }, { key: 'conf', label: 'Booking' }, { key: 'guest', label: 'Guest' }, { key: 'line', label: 'Room line', type: 'int', hidden: true }, { key: 'action', label: 'Change' }, { key: 'move', label: 'Status' }, { key: 'who', label: 'By' }, { key: 'why', label: 'Reason' }],
      rows: rows.map((x): Row => ({ _res: x.rid, at: x.at, conf: x.conf, guest: x.guest, line: x.line ?? '', action: nice(x.action), move: x.f && x.t && x.f !== x.t ? `${x.f} → ${x.t}` : x.t ?? '', who: x.who ?? 'System', why: x.reason ?? '' })) };
  },
};

const MONEY = ['folio.', 'payment.', 'invoice.', 'cashier.', 'ar.', 'cash.'];
export const moneyAudit: Def = {
  id: 'folio-payment-audit', name: 'Folio and payment audit', category: 'audit', kind: 'audit', permissions: ['audit.view'], roles: ['manager', 'accounts'], sensitive: true,
  purpose: 'Every action on bills, payments, invoices, cashier shifts and receivables: who did it, when, and the reason given.',
  basis: [{ id: 'when', label: 'Date of the event' }], range: 'today',
  params: [{ key: 'view', label: 'Show', default: 'all', options: [{ value: 'all', label: 'All money events' }, { value: 'reversals', label: 'Reversals, voids, refunds and reopened bills' }, { value: 'cashier', label: 'Cashier shifts and handovers' }] }],
  definitions: [{ term: 'Money event', text: 'Bill charges, discounts, reversals, closing and reopening, payments, voids and refunds, invoices and credit notes, cashier shifts, and company receivables.' }, { term: 'Reversal group', text: 'Reversed charges, voided payments, refunds, credit notes and reopened bills, the events most worth a second look.' }],
  async run(c) {
    const like = MONEY.map((p) => sql`a.action LIKE ${p + '%'}`); const any = like.reduce((p, q) => sql`${p} OR ${q}`);
    const r = await sql<Record<string, any>>`SELECT a.action, a.resource_type AS res, a.reason_code AS reason, a.note, ${local(sql.raw('a.occurred_at'), c)} AS at, u.full_name AS who, a.after FROM audit_log a LEFT JOIN staff_user u ON u.id = a.actor_id WHERE ${scope(c)} AND (${any}) AND ${dates(c)} ORDER BY a.occurred_at DESC LIMIT 10000`.execute(c.trx);
    let rows = r.rows; const v = c.params.view ?? 'all'; const rev = (a: string) => /reverse|void|refund|reopen|credit|writeoff|write_off|discount/.test(a);
    if (v === 'reversals') rows = rows.filter((x) => rev(x.action)); else if (v === 'cashier') rows = rows.filter((x) => x.action.startsWith('cashier.') || x.action.startsWith('cash.'));
    return { kpis: [{ key: 'n', label: 'Money events', value: rows.length, type: 'int', definition: 'Events in the view.' }, { key: 'r', label: 'Reversals, voids, refunds', value: rows.filter((x) => rev(x.action)).length, type: 'int', definition: 'Reversed or cancelled money, refunds, credit notes, reopened bills and discounts.' }, { key: 'u', label: 'People', value: new Set(rows.map((x) => x.who ?? 'System')).size, type: 'int', definition: 'People who did something.' }],
      columns: [{ key: 'at', label: 'When', type: 'datetime' }, { key: 'who', label: 'By' }, { key: 'action', label: 'Action' }, { key: 'res', label: 'On', hidden: true }, { key: 'why', label: 'Reason' }, { key: 'note', label: 'Note', hidden: true }, { key: 'flag', label: '', type: 'badge' }],
      rows: rows.map((x): Row => ({ at: x.at, who: x.who ?? 'System', action: nice(x.action), res: x.res, why: x.reason ?? '', note: x.note ?? '', flag: rev(x.action) ? 'Review' : '' })) };
  },
};

const OVERRIDES = ['payment.refund', 'payment.void', 'folio.discount', 'folio.reverse', 'folio.reopen', 'frontdesk.checkout_with_balance', 'inventory.set_overbook', 'invoice.credit', 'ota.writeoff', 'damage.charged', 'discount.request'];
export const approvals: Def = {
  id: 'approvals-overrides', name: 'Discount, refund and override approvals', category: 'audit', kind: 'audit', permissions: ['audit.view', 'report.view'], roles: ['manager', 'accounts'], sensitive: true,
  purpose: 'Discounts above a desk limit and who approved them, plus refunds, voids, reversals, overbooking, write-offs and other overrides, with who did them and why.',
  basis: [{ id: 'when', label: 'Date' }], range: 'month',
  definitions: [{ term: 'Discount approval', text: 'A request from the desk for a discount above their limit, and the manager’s decision.' }, { term: 'Override', text: 'Refunds, voids, bill discounts and reversals, reopened bills, check-out with a balance, overbooking, credit notes, write-offs and damage charges.' }],
  async run(c) {
    const a = await sql<Record<string, any>>`SELECT d.status, d.code, d.note, d.pct::text AS pct, d.amount_minor::text AS amt, d.decision_note, (d.created_at AT TIME ZONE ${c.prop.timezone})::date::text AS d, ru.full_name AS req, du.full_name AS dec FROM discount_approval d LEFT JOIN staff_user ru ON ru.id = d.requested_by LEFT JOIN staff_user du ON du.id = d.decided_by WHERE d.tenant_id = ${c.tenantId} AND d.property_id = ${c.propertyId} AND (d.created_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date`.execute(c.trx);
    const b = await sql<Record<string, any>>`SELECT a.action, a.reason_code AS reason, a.note, (a.occurred_at AT TIME ZONE ${c.prop.timezone})::date::text AS d, u.full_name AS who FROM audit_log a LEFT JOIN staff_user u ON u.id = a.actor_id WHERE ${scope(c)} AND a.action = ANY(${OVERRIDES}) AND ${dates(c)} ORDER BY a.occurred_at DESC LIMIT 5000`.execute(c.trx);
    const S: Record<string, string> = { PENDING: 'Waiting', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Withdrawn' };
    const rows: Row[] = [...a.rows.map((x): Row => ({ d: x.d, kind: 'Discount approval', what: `${x.pct !== '0' && x.pct ? `${x.pct}%` : ''} ${dec(x.amt)}`.trim(), outcome: S[x.status] ?? x.status, by: x.req ?? '', approver: x.dec ?? '', why: x.decision_note ?? x.note ?? x.code })),
      ...b.rows.map((x): Row => ({ d: x.d, kind: 'Override', what: nice(x.action), outcome: 'Done', by: x.who ?? 'System', approver: '', why: x.reason ?? x.note ?? '' }))].sort((p, q) => String(q.d).localeCompare(String(p.d)));
    return { kpis: [{ key: 'n', label: 'Items', value: rows.length, type: 'int', definition: 'Approvals and overrides in the period.' }, { key: 'ap', label: 'Discount requests', value: a.rows.length, type: 'int', definition: 'Requests for discounts above a limit.' }, { key: 'rej', label: 'Rejected', value: a.rows.filter((x) => x.status === 'REJECTED').length, type: 'int', definition: 'Requests a manager rejected.' }, { key: 'ov', label: 'Overrides', value: b.rows.length, type: 'int', definition: 'Refunds, voids, reversals and other overrides.' }],
      columns: [{ key: 'd', label: 'Date', type: 'date' }, { key: 'kind', label: 'Type', type: 'badge' }, { key: 'what', label: 'What' }, { key: 'outcome', label: 'Outcome', type: 'badge' }, { key: 'by', label: 'Asked or done by' }, { key: 'approver', label: 'Decided by' }, { key: 'why', label: 'Reason or note' }], rows,
      notes: ['Overrides show who did them and the reason given. Refunds to a beneficiary carry a second person’s approval in the payment itself.'] };
  },
};

const SENS = ['frontdesk.view_id', 'report.export', 'document.link_create', 'document.link_revoke', 'auth.mfa_failed', 'auth.mfa_enabled', 'auth.password_changed', 'auth.login_while_locked'];
export const sensitive: Def = {
  id: 'sensitive-access', name: 'Sensitive-data access and export', category: 'audit', kind: 'audit', permissions: ['audit.view'], roles: ['manager'], sensitive: true,
  purpose: 'Who looked at guests’ ID documents, exported reports, shared document links, imported data, or had sign-in and second-factor problems.',
  basis: [{ id: 'when', label: 'Date of the event' }], range: 'month',
  definitions: [{ term: 'ID viewed', text: 'A person revealed a guest’s stored identity document. Needs a fresh second factor.' }, { term: 'Export', text: 'A report was downloaded as a file.' }, { term: 'Security event', text: 'Wrong second-factor codes, sign-in attempts on a locked account, password changes and second-factor set-up.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT a.action, a.resource_type AS res, a.note, a.ip, ${local(sql.raw('a.occurred_at'), c)} AS at, u.full_name AS who, a.after FROM audit_log a LEFT JOIN staff_user u ON u.id = a.actor_id WHERE ${scope(c)} AND (a.action = ANY(${SENS}) OR a.action LIKE 'import.%') AND ${dates(c)} ORDER BY a.occurred_at DESC LIMIT 5000`.execute(c.trx);
    const kind = (a: string) => (a === 'frontdesk.view_id' ? 'ID viewed' : a === 'report.export' ? 'Export' : a.startsWith('import.') ? 'Import' : a.startsWith('document.') ? 'Document link' : 'Security event');
    return { kpis: [{ key: 'n', label: 'Events', value: r.rows.length, type: 'int', definition: 'Sensitive events in the period.' }, { key: 'id', label: 'IDs viewed', value: r.rows.filter((x) => x.action === 'frontdesk.view_id').length, type: 'int', definition: 'Times a guest ID document was revealed.' }, { key: 'ex', label: 'Exports', value: r.rows.filter((x) => x.action === 'report.export').length, type: 'int', definition: 'Reports downloaded.' }, { key: 'sec', label: 'Security events', value: r.rows.filter((x) => kind(x.action) === 'Security event').length, type: 'int', tone: r.rows.some((x) => x.action === 'auth.mfa_failed' || x.action === 'auth.login_while_locked') ? 'warn' : 'ok', definition: 'Second-factor failures, locked-account attempts, password and MFA changes.' }],
      columns: [{ key: 'at', label: 'When', type: 'datetime' }, { key: 'kind', label: 'Kind', type: 'badge' }, { key: 'who', label: 'Person' }, { key: 'action', label: 'Action' }, { key: 'what', label: 'Detail' }, { key: 'ip', label: 'Network address', hidden: true }],
      rows: r.rows.map((x): Row => ({ at: x.at, kind: kind(x.action), who: x.who ?? 'Unknown', action: nice(x.action), what: x.action === 'report.export' ? String(x.note ?? '') : x.note ?? '', ip: x.ip ?? '' })), notes: ['Network addresses are recorded where the system knew them.'] };
  },
};

export const deliveries: Def = {
  id: 'report-deliveries', name: 'Scheduled-report delivery history', category: 'audit', kind: 'audit', permissions: ['report.schedule', 'audit.view'], roles: ['manager', 'accounts'],
  purpose: 'Each scheduled report that was made: when, how many rows, who it was emailed to, whether the email went, and whether anyone opened it.',
  basis: [{ id: 'made', label: 'Date the report was made' }], range: 'last30',
  definitions: [{ term: 'Ready, skipped, failed', text: 'Ready: made and sent. Skipped: not made, for example when its condition was not met or its owner can no longer open it. Failed: something went wrong.' }, { term: 'Opened', text: 'At least one recipient opened the link.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT d.report_name, d.schedule_name, d.for_date::text AS fd, d.status, d.note, d.rows, ${local(sql.raw('d.generated_at'), c)} AS at, count(rc.user_id)::int AS rcpt, count(*) FILTER (WHERE rc.mail_status = 'SENT')::int AS sent, count(*) FILTER (WHERE rc.mail_status = 'FAILED')::int AS failed, coalesce(sum(rc.views), 0)::int AS views
      FROM report_delivery d LEFT JOIN report_delivery_recipient rc ON rc.tenant_id = d.tenant_id AND rc.delivery_id = d.id WHERE d.tenant_id = ${c.tenantId} AND d.property_id = ${c.propertyId} AND (d.generated_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY d.tenant_id, d.id ORDER BY d.generated_at DESC`.execute(c.trx);
    const S: Record<string, string> = { READY: 'Ready', SKIPPED: 'Skipped', FAILED: 'Failed' };
    return { kpis: [{ key: 'n', label: 'Deliveries', value: r.rows.length, type: 'int', definition: 'Scheduled reports made in the period.' }, { key: 'bad', label: 'Skipped or failed', value: r.rows.filter((x) => x.status !== 'READY').length, type: 'int', tone: r.rows.some((x) => x.status === 'FAILED') ? 'bad' : r.rows.some((x) => x.status !== 'READY') ? 'warn' : 'ok', definition: 'Deliveries not made.' }, { key: 'mf', label: 'Emails that failed', value: r.rows.reduce((s, x) => s + x.failed, 0), type: 'int', definition: 'Recipient emails that did not go.' }, { key: 'op', label: 'Opened', value: r.rows.filter((x) => x.views > 0).length, type: 'int', definition: 'Deliveries opened at least once.' }],
      columns: [{ key: 'at', label: 'Made', type: 'datetime' }, { key: 'rep', label: 'Report' }, { key: 'sch', label: 'Schedule' }, { key: 'fd', label: 'For date', type: 'date' }, { key: 'status', label: 'Status', type: 'badge' }, { key: 'rows', label: 'Rows', type: 'int', total: true }, { key: 'rcpt', label: 'Recipients', type: 'int' }, { key: 'failed', label: 'Emails failed', type: 'int', total: true }, { key: 'views', label: 'Opens', type: 'int', total: true }, { key: 'note', label: 'Note' }],
      rows: r.rows.map((x): Row => ({ at: x.at, rep: x.report_name, sch: x.schedule_name, fd: x.fd, status: S[x.status] ?? x.status, rows: x.rows, rcpt: x.rcpt, failed: x.failed, views: x.views, note: x.note ?? '' })) };
  },
};

export const cashierVariance: Def = {
  id: 'cashier-variance', name: 'Cashier variance by employee', category: 'staff', kind: 'audit', permissions: ['cashier.review', 'report.view'], roles: ['manager', 'accounts'],
  purpose: 'For each cashier: shifts worked, cash handled, and the cash difference found when counting, so a pattern shows.',
  basis: [{ id: 'opened', label: 'Business date the shift opened' }], range: 'month',
  definitions: [{ term: 'Variance', text: 'Counted cash − expected closing cash, on closed shifts only. Negative means cash is short.' }, { term: 'Shifts with a difference', text: 'Closed shifts where the count did not match.' }, { term: 'Open shifts', text: 'Not counted yet, so no variance is shown.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT u.full_name AS who, count(*)::int AS shifts, count(*) FILTER (WHERE s.status = 'OPEN')::int AS open, count(*) FILTER (WHERE s.status <> 'OPEN' AND coalesce(s.variance_minor, 0) <> 0)::int AS off, coalesce(sum(s.variance_minor) FILTER (WHERE s.status <> 'OPEN'), 0)::text AS net, coalesce(sum(abs(s.variance_minor)) FILTER (WHERE s.status <> 'OPEN'), 0)::text AS gross, coalesce(sum(s.counted_minor) FILTER (WHERE s.status <> 'OPEN'), 0)::text AS counted
      FROM cashier_session s JOIN staff_user u ON u.id = s.user_id WHERE s.tenant_id = ${c.tenantId} AND s.property_id = ${c.propertyId} AND s.opened_business_date BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY u.full_name ORDER BY coalesce(sum(abs(s.variance_minor)), 0) DESC, u.full_name`.execute(c.trx);
    const rows: Row[] = r.rows.map((x): Row => ({ who: x.who, shifts: x.shifts, open: x.open, off: x.off, net: x.net, gross: x.gross, counted: x.counted }));
    const net = rows.reduce((s, x) => s + BigInt(x.net as string), 0n);
    return { kpis: [{ key: 'n', label: 'Cashiers', value: rows.length, type: 'int', definition: 'People who opened a shift.' }, { key: 'off', label: 'Shifts with a difference', value: rows.reduce((s, x) => s + Number(x.off), 0), type: 'int', tone: rows.some((x) => Number(x.off) > 0) ? 'warn' : 'ok', definition: 'Closed shifts where the count did not match.' }, { key: 'net', label: 'Net variance', value: dec(net), type: 'money', tone: net === 0n ? 'ok' : 'bad', definition: 'Sum of counted − expected, closed shifts.' }],
      columns: [{ key: 'who', label: 'Cashier' }, { key: 'shifts', label: 'Shifts', type: 'int', total: true }, { key: 'open', label: 'Still open', type: 'int', total: true }, { key: 'off', label: 'With a difference', type: 'int', total: true }, { key: 'net', label: 'Net variance', type: 'money', total: true }, { key: 'gross', label: 'Total difference (ignoring sign)', type: 'money', total: true }, { key: 'counted', label: 'Cash counted', type: 'money', total: true, hidden: true }], rows, notes: ['Variance by shift is in the Collection and cashier report.'] };
  },
};

export const approvalQueue: Def = {
  id: 'approval-queue', name: 'Approval and review queue', category: 'staff', kind: 'operational', permissions: ['report.view'], roles: ['manager', 'accounts'],
  purpose: 'Everything waiting for a decision or a check: discount requests, payments to verify, charge reviews, compliance tasks and maintenance requests, oldest first.',
  basis: [{ id: 'asof', label: 'As of now' }], range: 'none',
  definitions: [{ term: 'Waiting', text: 'Days since it was raised or taken, as of the business date.' }, { term: 'Queue', text: 'Only items still open. Items decided or done are not listed.' }],
  async run(c) {
    const bd = c.prop.businessDate; const days = (d: string) => Math.max(0, Math.round((Date.parse(`${bd}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000));
    const q = async (t: ReturnType<typeof sql<Record<string, any>>>) => (await t.execute(c.trx)).rows;
    const [disc, pay, rev, task, wo] = await Promise.all([
      q(sql<Record<string, any>>`SELECT d.id, d.created_at::date::text AS d, d.code, d.amount_minor::text AS amt, u.full_name AS who FROM discount_approval d LEFT JOIN staff_user u ON u.id = d.requested_by WHERE d.tenant_id = ${c.tenantId} AND d.property_id = ${c.propertyId} AND d.status = 'PENDING' AND d.expires_at > now()`),
      q(sql<Record<string, any>>`SELECT p.receipt_no, p.business_date::text AS d, p.method, p.amount_minor::text AS amt, u.full_name AS who FROM payment p LEFT JOIN staff_user u ON u.id = p.created_by WHERE p.tenant_id = ${c.tenantId} AND p.property_id = ${c.propertyId} AND p.status = 'PENDING_VERIFICATION'`),
      q(sql<Record<string, any>>`SELECT r.message, r.opened_at::date::text AS d, r.amount_minor::text AS amt FROM charge_review r WHERE r.tenant_id = ${c.tenantId} AND r.property_id = ${c.propertyId} AND r.status = 'OPEN'`),
      q(sql<Record<string, any>>`SELECT t.title, coalesce(t.due_date, t.created_at::date)::text AS d, t.due_date::text AS due FROM compliance_task t WHERE t.tenant_id = ${c.tenantId} AND t.property_id = ${c.propertyId} AND t.status = 'OPEN'`),
      q(sql<Record<string, any>>`SELECT w.number, w.title, w.created_at::date::text AS d, u.full_name AS who FROM work_order w LEFT JOIN staff_user u ON u.id = w.reported_by WHERE w.tenant_id = ${c.tenantId} AND w.property_id = ${c.propertyId} AND w.status = 'REQUESTED'`)]);
    const rows: Row[] = [...disc.map((x): Row => ({ kind: 'Discount request', what: `${x.code} · ${dec(x.amt)}`, who: x.who ?? '', since: x.d, age: days(x.d) })), ...pay.map((x): Row => ({ kind: 'Payment to verify', what: `${x.receipt_no ?? x.method} · ${dec(x.amt)}`, who: x.who ?? '', since: x.d, age: days(x.d) })), ...rev.map((x): Row => ({ kind: 'Charge review', what: `${x.message} · ${dec(x.amt)}`, who: '', since: x.d, age: days(x.d) })), ...task.map((x): Row => ({ kind: 'Compliance task', what: x.title, who: '', since: x.d, age: days(x.d) })), ...wo.map((x): Row => ({ kind: 'Maintenance request', what: `${x.number} · ${x.title}`, who: x.who ?? '', since: x.d, age: days(x.d) }))].sort((a, b) => Number(b.age) - Number(a.age));
    const by = (k: string) => rows.filter((x) => x.kind === k).length;
    return { kpis: [{ key: 'n', label: 'Waiting', value: rows.length, type: 'int', tone: rows.length ? 'warn' : 'ok', definition: 'Items waiting for a decision or check.' }, { key: 'd', label: 'Discount requests', value: by('Discount request'), type: 'int', definition: 'Waiting for a manager.' }, { key: 'p', label: 'Payments to verify', value: by('Payment to verify'), type: 'int', definition: 'Transfers or slips not yet verified.' }, { key: 'o', label: 'Oldest (days)', value: Number(rows[0]?.age ?? 0), type: 'int', definition: 'Age of the oldest item.' }],
      columns: [{ key: 'kind', label: 'Waiting for', type: 'badge' }, { key: 'what', label: 'What' }, { key: 'who', label: 'Raised by' }, { key: 'since', label: 'Since', type: 'date' }, { key: 'age', label: 'Days', type: 'int' }], rows, notes: ['Leave requests, expense approvals and purchase approvals are not part of the system yet.'] };
  },
};
