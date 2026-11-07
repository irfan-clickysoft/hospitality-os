import { sql } from 'kysely';
import type { Ctx, Def, Row } from './types.js';
import { addDays, dec, pctOf } from './util.js';

interface Win { sold: number; sell: number; rev: bigint; fnb: bigint; coll: bigint; lines: number; lost: number; cases: number }
const rooms = async (c: Ctx) => Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM room WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND status = 'ACTIVE'`.execute(c.trx)).rows[0]!.n);

async function window(c: Ctx, from: string, to: string, nRooms: number): Promise<Win> {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const r = await sql<Record<string, any>>`SELECT
      (SELECT count(*) FROM stay_night n JOIN reservation_room l ON l.id = n.reservation_room_id WHERE n.tenant_id = ${c.tenantId} AND n.property_id = ${c.propertyId} AND n.business_date BETWEEN ${from}::date AND ${to}::date AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT'))::int AS sold,
      (SELECT coalesce(sum(n.total_minor), 0) FROM stay_night n JOIN reservation_room l ON l.id = n.reservation_room_id WHERE n.tenant_id = ${c.tenantId} AND n.property_id = ${c.propertyId} AND n.business_date BETWEEN ${from}::date AND ${to}::date AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT'))::text AS rev,
      (SELECT coalesce(sum(least(b.end_date, ${to}::date + 1) - greatest(b.start_date, ${from}::date)), 0) FROM room_block b WHERE b.tenant_id = ${c.tenantId} AND b.property_id = ${c.propertyId} AND b.cancelled_at IS NULL AND b.start_date <= ${to}::date AND b.end_date > ${from}::date)::int AS blocked,
      (SELECT coalesce(sum(p.amount_minor), 0) FROM folio_posting p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id WHERE p.tenant_id = ${c.tenantId} AND p.property_id = ${c.propertyId} AND p.posting_type = 'CHARGE' AND p.txn_code = 'FNB' AND f.folio_type <> 'HOUSE' AND p.business_date BETWEEN ${from}::date AND ${to}::date)::text AS fnb,
      (SELECT coalesce(sum(CASE WHEN y.kind = 'REFUND' THEN -y.amount_minor ELSE y.amount_minor END), 0) FROM payment y WHERE y.tenant_id = ${c.tenantId} AND y.property_id = ${c.propertyId} AND y.status = 'CAPTURED' AND y.business_date BETWEEN ${from}::date AND ${to}::date)::text AS coll,
      (SELECT count(*) FROM reservation_room l WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.status <> 'OPTION' AND l.arrival BETWEEN ${from}::date AND ${to}::date)::int AS lines,
      (SELECT count(*) FROM reservation_room l WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.status IN ('CANCELLED','NO_SHOW') AND l.arrival BETWEEN ${from}::date AND ${to}::date)::int AS lost,
      (SELECT count(*) FROM case_record k WHERE k.tenant_id = ${c.tenantId} AND k.property_id = ${c.propertyId} AND k.confidentiality = 'NORMAL' AND k.type IN ('GUEST_COMPLAINT','SERVICE_FAILURE') AND (k.occurred_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${from}::date AND ${to}::date)::int AS cases`.execute(c.trx);
  const x = r.rows[0]!; return { sold: x.sold, sell: Math.max(0, nRooms * days - x.blocked), rev: BigInt(x.rev), fnb: BigInt(x.fnb), coll: BigInt(x.coll), lines: x.lines, lost: x.lost, cases: x.cases };
}
const prevYear = (d: string) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCFullYear(t.getUTCFullYear() - 1); return t.toISOString().slice(0, 10); };
const prevMonthStart = (d: string) => { const t = new Date(`${d.slice(0, 8)}01T00:00:00Z`); t.setUTCMonth(t.getUTCMonth() - 1); return t.toISOString().slice(0, 10); };

export const scorecard: Def = {
  id: 'scorecard', name: 'Property scorecard: month and year to date', category: 'management', kind: 'executive', permissions: ['management.view', 'report.view'], roles: ['manager', 'accounts'],
  purpose: 'One page of the figures that matter, for the month so far and the year so far, each beside the same stretch a month or a year ago.',
  basis: [{ id: 'asof', label: 'To the business date' }], range: 'none',
  definitions: [{ term: 'Month to date', text: 'From the first of this month to the business date.' }, { term: 'Last month', text: 'The same number of days at the start of last month.' }, { term: 'Year to date', text: 'From 1 January to the business date; last year is the same dates a year earlier.' }, { term: 'Occupancy, ADR, RevPAR', text: 'Rooms sold ÷ sellable; room revenue ÷ rooms sold; room revenue ÷ sellable. Sellable uses today’s active rooms for every period, so a room added recently flatters past months.' }, { term: 'Posted vs cash', text: 'Revenue is posted to bills before tax. Collected is cash taken less refunds. They are not the same thing.' }],
  async run(c) {
    const bd = c.prop.businessDate; const n = await rooms(c);
    const mtdFrom = `${bd.slice(0, 8)}01`; const dayN = Number(bd.slice(8, 10)); const lmFrom = prevMonthStart(bd); const lmTo = addDays(lmFrom, dayN - 1);
    const ytdFrom = `${bd.slice(0, 4)}-01-01`; const lyFrom = prevYear(ytdFrom); const lyTo = prevYear(bd);
    const [m, lm, y, ly] = await Promise.all([window(c, mtdFrom, bd, n), window(c, lmFrom, lmTo, n), window(c, ytdFrom, bd, n), window(c, lyFrom, lyTo, n)]);
    const adr = (w: Win) => (w.sold ? (w.rev / BigInt(w.sold)).toString() : '0'); const revpar = (w: Win) => (w.sell ? (w.rev / BigInt(w.sell)).toString() : '0');
    const line = (label: string, f: (w: Win) => string | number, type: 'int' | 'money' | 'pct'): Row => { const v = (w: Win) => (type === 'money' ? dec(f(w) as string) : f(w)); return { what: label, mtd: v(m), lm: v(lm), y: v(y), ly: v(ly), _fmt: type }; };
    const rows: Row[] = [line('Rooms sold', (w) => w.sold, 'int'), line('Occupancy %', (w) => pctOf(w.sold, w.sell), 'pct'), line('ADR', adr, 'money'), line('RevPAR', revpar, 'money'), line('Room revenue', (w) => w.rev.toString(), 'money'), line('Food and beverage charged', (w) => w.fnb.toString(), 'money'), line('Collected (net)', (w) => w.coll.toString(), 'money'), line('Cancelled or no-show %', (w) => pctOf(w.lost, w.lines), 'pct'), line('Complaints and service failures', (w) => w.cases, 'int')];
    const open = await sql<Record<string, any>>`SELECT (SELECT coalesce(sum(f.balance_minor), 0) FROM folio f WHERE f.tenant_id = ${c.tenantId} AND f.property_id = ${c.propertyId} AND f.status = 'OPEN' AND f.folio_type = 'GUEST' AND f.balance_minor > 0)::text AS owing, (SELECT count(*) FROM work_order w WHERE w.tenant_id = ${c.tenantId} AND w.property_id = ${c.propertyId} AND w.status IN ('REQUESTED','OPEN','ASSIGNED','IN_PROGRESS','WAITING') AND w.due_date < ${bd}::date)::int AS jobs, (SELECT count(*) FROM case_record k WHERE k.tenant_id = ${c.tenantId} AND k.property_id = ${c.propertyId} AND k.confidentiality = 'NORMAL' AND k.status IN ('OPEN','IN_PROGRESS') AND k.sla_due_at < now())::int AS cases`.execute(c.trx);
    const o = open.rows[0]!;
    return { kpis: [{ key: 'occ', label: 'Occupancy (month to date)', value: pctOf(m.sold, m.sell), type: 'pct', definition: 'Rooms sold ÷ sellable.', compare: [{ label: 'Last month', value: `${pctOf(lm.sold, lm.sell)}%` }, { label: 'Year to date', value: `${pctOf(y.sold, y.sell)}%` }] }, { key: 'rev', label: 'Room revenue (month to date)', value: dec(m.rev), type: 'money', definition: 'Posted before tax.', compare: [{ label: 'Last month', value: dec(lm.rev) }, { label: 'Year to date', value: dec(y.rev) }] }, { key: 'owing', label: 'Guests owe now', value: dec(o.owing), type: 'money', definition: 'Open guest balances.' }, { key: 'risk', label: 'Overdue jobs and cases', value: o.jobs + o.cases, type: 'int', tone: o.jobs + o.cases ? 'warn' : 'ok', definition: 'Overdue maintenance jobs plus overdue complaints and incidents.' }],
      columns: [{ key: 'what', label: 'Measure' }, { key: 'mtd', label: `Month to date (${mtdFrom} → ${bd})` }, { key: 'lm', label: `Same days last month` }, { key: 'y', label: `Year to date` }, { key: 'ly', label: 'Same dates last year' }], rows,
      notes: ['Budget and forecast columns are not shown: no budget is recorded and the forecast report covers the days ahead.'] };
  },
};

export const invoiceChecks: Def = {
  id: 'invoice-exceptions', name: 'Tax-invoice sequence exceptions', category: 'audit', kind: 'audit', permissions: ['audit.view', 'tax.configure', 'report.view'], roles: ['accounts', 'manager'], sensitive: true,
  purpose: 'Gaps in invoice numbers, counters that disagree with what was issued, credit notes with no original, and invoices whose figures do not add up.',
  basis: [{ id: 'issued', label: 'Fiscal year or issue date' }], range: 'none',
  definitions: [{ term: 'Gap', text: 'A number missing between the lowest and highest issued in a series for a fiscal year.' }, { term: 'Counter mismatch', text: 'The counter’s last number differs from the highest invoice actually stored.' }, { term: 'Credit note without an original', text: 'A credit note that does not point at the invoice it cancels.' }, { term: 'Does not add up', text: 'Net + tax is not equal to the total.' }],
  async run(c) {
    const out: Row[] = [];
    const inv = await sql<Record<string, any>>`SELECT i.legal_entity_id AS le, le2.name AS entity, i.series, i.fiscal_year AS fy, min(i.seq)::int AS lo, max(i.seq)::int AS hi, count(*)::int AS n, array_agg(i.seq ORDER BY i.seq) AS seqs
      FROM invoice i LEFT JOIN legal_entity le2 ON le2.tenant_id = i.tenant_id AND le2.id = i.legal_entity_id WHERE i.tenant_id = ${c.tenantId} GROUP BY i.legal_entity_id, le2.name, i.series, i.fiscal_year`.execute(c.trx);
    const ctr = await sql<Record<string, any>>`SELECT legal_entity_id AS le, series, fiscal_year AS fy, last_seq::int AS last FROM invoice_counter WHERE tenant_id = ${c.tenantId}`.execute(c.trx);
    for (const x of inv.rows) {
      const have = new Set<number>(x.seqs); const missing: number[] = []; for (let s = x.lo; s <= x.hi; s++) if (!have.has(s)) missing.push(s);
      if (missing.length) out.push({ kind: 'Gap in numbers', sev: 'High', what: `${x.entity ?? ''} ${x.series} ${x.fy}`.trim(), detail: `Missing ${missing.length > 10 ? `${missing.slice(0, 10).join(', ')} and ${missing.length - 10} more` : missing.join(', ')}`, amount: '' });
      const k = ctr.rows.find((y) => y.le === x.le && y.series === x.series && y.fy === x.fy); if (k && k.last !== x.hi) out.push({ kind: 'Counter mismatch', sev: 'High', what: `${x.entity ?? ''} ${x.series} ${x.fy}`.trim(), detail: `Counter says ${k.last}, highest invoice is ${x.hi}`, amount: '' });
    }
    const odd = await sql<Record<string, any>>`SELECT i.number, i.doc_type, i.credits_invoice_id, i.net_minor::text AS net, i.tax_minor::text AS tax, i.total_minor::text AS total FROM invoice i WHERE i.tenant_id = ${c.tenantId} AND i.property_id = ${c.propertyId} AND ((i.doc_type = 'CREDIT_NOTE' AND i.credits_invoice_id IS NULL) OR i.net_minor + i.tax_minor <> i.total_minor)`.execute(c.trx);
    for (const x of odd.rows) { if (x.doc_type === 'CREDIT_NOTE' && !x.credits_invoice_id) out.push({ kind: 'Credit note without an original', sev: 'High', what: x.number, detail: 'It does not point at an invoice', amount: x.total }); if (BigInt(x.net) + BigInt(x.tax) !== BigInt(x.total)) out.push({ kind: 'Does not add up', sev: 'High', what: x.number, detail: `Net ${dec(x.net)} + tax ${dec(x.tax)} is not ${dec(x.total)}`, amount: x.total }); }
    const issued = await sql<{ n: number }>`SELECT count(*)::int AS n FROM invoice WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId}`.execute(c.trx);
    return { kpis: [{ key: 'n', label: 'Exceptions', value: out.length, type: 'int', tone: out.length ? 'bad' : 'ok', definition: 'Items that need a look.' }, { key: 'inv', label: 'Invoices issued here', value: issued.rows[0]!.n, type: 'int', definition: 'Tax invoices and credit notes at this property.' }],
      columns: [{ key: 'kind', label: 'Exception', type: 'badge' }, { key: 'sev', label: 'Level' }, { key: 'what', label: 'Series or document' }, { key: 'detail', label: 'What was found' }, { key: 'amount', label: 'Amount', type: 'money' }], rows: out,
      notes: ['Number gaps are checked across all properties of the legal entity, because they share one series. A system-issued invoice cannot be deleted, so a gap points to a number that was never stored.'] };
  },
};

export const dataQuality: Def = {
  id: 'data-quality', name: 'Missing or invalid data', category: 'audit', kind: 'audit', permissions: ['report.view', 'guest.view'], roles: ['manager', 'frontdesk'],
  purpose: 'Records that are incomplete in ways that cause trouble later: guests with no way to contact them, foreign guests with no nationality, companies without tax numbers, and bookings with nothing to reach the guest by.',
  basis: [{ id: 'arrival', label: 'Arrival date (bookings), all records otherwise' }], range: 'next30',
  definitions: [{ term: 'No contact', text: 'The guest on an upcoming or in-house booking has neither a phone number nor an email.' }, { term: 'No nationality', text: 'A guest on an upcoming or in-house booking with no nationality recorded.' }, { term: 'Company without tax numbers', text: 'A company with bookings in the period but no NTN and no STRN, which an invoice to it will need.' }, { term: 'Email not valid', text: 'An email address that does not look like one.' }],
  async run(c) {
    const out: Row[] = [];
    const g = await sql<Record<string, any>>`SELECT DISTINCT ON (g.id) g.id, g.full_name AS name, g.phone, g.email, g.nationality, r.id AS rid, r.confirmation_no AS conf FROM guest g JOIN reservation r ON r.tenant_id = g.tenant_id AND r.guest_id = g.id JOIN reservation_room l ON l.tenant_id = r.tenant_id AND l.reservation_id = r.id
      WHERE g.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.status IN ('CONFIRMED','CHECKED_IN') AND l.arrival BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY g.id`.execute(c.trx);
    for (const x of g.rows) {
      if (!x.phone && !x.email) out.push({ _res: x.rid, kind: 'No contact', rec: x.name, ref: x.conf, detail: 'No phone and no email' });
      if (!x.nationality) out.push({ _res: x.rid, kind: 'No nationality', rec: x.name, ref: x.conf, detail: 'Nationality is blank' });
      if (x.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.email)) out.push({ _res: x.rid, kind: 'Email not valid', rec: x.name, ref: x.conf, detail: x.email });
    }
    const co = await sql<Record<string, any>>`SELECT co.name, count(DISTINCT r.id)::int AS n FROM company co JOIN reservation r ON r.tenant_id = co.tenant_id AND r.company_id = co.id JOIN reservation_room l ON l.tenant_id = r.tenant_id AND l.reservation_id = r.id
      WHERE co.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT') AND l.arrival BETWEEN ${c.from}::date AND ${c.to}::date AND coalesce(co.ntn, '') = '' AND coalesce(co.strn, '') = '' GROUP BY co.name`.execute(c.trx);
    for (const x of co.rows) out.push({ kind: 'Company without tax numbers', rec: x.name, ref: `${x.n} booking${x.n === 1 ? '' : 's'}`, detail: 'No NTN and no STRN' });
    const by = (k: string) => out.filter((x) => x.kind === k).length;
    return { kpis: [{ key: 'n', label: 'Records to fix', value: out.length, type: 'int', tone: out.length ? 'warn' : 'ok', definition: 'Items found.' }, { key: 'c', label: 'No way to contact', value: by('No contact'), type: 'int', definition: 'Guests with no phone or email.' }, { key: 'nat', label: 'No nationality', value: by('No nationality'), type: 'int', definition: 'Guests with no nationality.' }, { key: 'co', label: 'Companies without tax numbers', value: by('Company without tax numbers'), type: 'int', definition: 'Companies that will need them.' }],
      columns: [{ key: 'kind', label: 'Problem', type: 'badge' }, { key: 'rec', label: 'Guest or company' }, { key: 'ref', label: 'Booking' }, { key: 'detail', label: 'What is wrong' }], rows: out, notes: ['Missing ID details are in the Guest identification compliance report. Integration failures are not recorded as a list yet.'] };
  },
};

export const pipeline: Def = {
  id: 'quotation-pipeline', name: 'Sales pipeline: quotations', category: 'sales', kind: 'analytical', permissions: ['reservation.view', 'report.view'], roles: ['manager', 'frontdesk'],
  purpose: 'Quotations by stage: drafts, sent and waiting, accepted, declined and turned into bookings, with their value and which are about to lapse.',
  basis: [{ id: 'created', label: 'Date the quotation was made' }], range: 'month',
  params: [{ key: 'group', label: 'Show', default: 'stage', options: [{ value: 'stage', label: 'By stage' }, { value: 'open', label: 'Open quotations' }] }],
  definitions: [{ term: 'Stage', text: 'Draft, sent, accepted, declined, cancelled or converted to a booking.' }, { term: 'Value', text: 'Quotation total including tax, as last priced.' }, { term: 'Open', text: 'Draft, sent or accepted and not yet converted, and not past its valid-until date.' }, { term: 'Conversion', text: 'Converted quotations ÷ quotations that were sent.' }],
  async run(c) {
    const bd = c.prop.businessDate;
    const r = await sql<Record<string, any>>`SELECT q.number, q.status, q.customer_name AS who, q.valid_until::text AS valid, q.created_at::date::text AS made, coalesce(q.pricing->>'total', '0') AS total, q.sent_at IS NOT NULL AS sent, q.viewed_at IS NOT NULL AS viewed
      FROM quotation q WHERE q.tenant_id = ${c.tenantId} AND q.property_id = ${c.propertyId} AND (q.created_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY q.created_at DESC`.execute(c.trx);
    const S: Record<string, string> = { DRAFT: 'Draft', SENT: 'Sent', ACCEPTED: 'Accepted', DECLINED: 'Declined', CANCELLED: 'Cancelled', CONVERTED: 'Booked' };
    const val = (x: Record<string, any>) => BigInt(String(x.total).replace(/\D/g, '') || '0'); const sent = r.rows.filter((x) => x.sent).length; const conv = r.rows.filter((x) => x.status === 'CONVERTED').length;
    const kp = [{ key: 'n', label: 'Quotations', value: r.rows.length, type: 'int' as const, definition: 'Made in the period.' }, { key: 'val', label: 'Open value', value: dec(r.rows.filter((x) => ['DRAFT', 'SENT', 'ACCEPTED'].includes(x.status) && x.valid >= bd).reduce((s, x) => s + val(x), 0n)), type: 'money' as const, definition: 'Value of quotations still open.' }, { key: 'conv', label: 'Conversion', value: pctOf(conv, sent), type: 'pct' as const, definition: 'Booked ÷ sent.' }, { key: 'lapse', label: 'Lapsing within 3 days', value: r.rows.filter((x) => ['DRAFT', 'SENT'].includes(x.status) && x.valid >= bd && x.valid <= addDays(bd, 3)).length, type: 'int' as const, definition: 'Open quotations whose valid-until date is within 3 days.' }];
    if ((c.params.group ?? 'stage') === 'open') return { kpis: kp, columns: [{ key: 'no', label: 'Quotation' }, { key: 'who', label: 'Customer' }, { key: 'status', label: 'Stage', type: 'badge' }, { key: 'made', label: 'Made', type: 'date' }, { key: 'valid', label: 'Valid until', type: 'date' }, { key: 'total', label: 'Value', type: 'money', total: true }, { key: 'viewed', label: 'Opened by customer' }], rows: r.rows.filter((x) => ['DRAFT', 'SENT', 'ACCEPTED'].includes(x.status) && x.valid >= bd).map((x): Row => ({ no: x.number, who: x.who, status: S[x.status] ?? x.status, made: x.made, valid: x.valid, total: String(val(x)), viewed: x.viewed ? 'Yes' : 'No' })) };
    const map = new Map<string, { n: number; v: bigint }>(); for (const x of r.rows) { const k = S[x.status] ?? x.status; const e = map.get(k) ?? { n: 0, v: 0n }; e.n++; e.v += val(x); map.set(k, e); }
    return { kpis: kp, columns: [{ key: 'what', label: 'Stage' }, { key: 'n', label: 'Quotations', type: 'int', total: true }, { key: 'v', label: 'Value', type: 'money', total: true }], rows: [...map.entries()].map(([k, e]): Row => ({ what: k, n: e.n, v: e.v.toString() })), chart: { kind: 'bar', x: 'what', series: [{ key: 'n', label: 'Quotations' }] }, notes: ['Lost business is recorded only when the customer declines on the quotation page, not when no answer comes.'] };
  },
};

const CAT: Record<string, string> = { PLUMBING: 'Plumbing', ELECTRICAL: 'Electrical', AC: 'Air conditioning', FURNITURE: 'Furniture', APPLIANCE: 'Appliance', CLEANLINESS: 'Cleanliness', SAFETY: 'Safety', FUMIGATION: 'Fumigation', OTHER: 'Other' };
export const preventive: Def = {
  id: 'preventive-due', name: 'Preventive maintenance due', category: 'rooms', kind: 'operational', permissions: ['maintenance.view', 'report.view'], roles: ['maintenance', 'manager'],
  purpose: 'Planned maintenance schedules: what is due, what is overdue, when the next job will be raised, and who looks after it.',
  basis: [{ id: 'due', label: 'Next due date' }], range: 'next30',
  definitions: [{ term: 'Overdue', text: 'The next due date is before the business date and no job has been raised for it.' }, { term: 'Raised on', text: 'The job is created this many days before the due date (the lead time).' }, { term: 'Every', text: 'How often the work repeats.' }],
  async run(c) {
    const bd = c.prop.businessDate;
    const r = await sql<Record<string, any>>`SELECT s.title, s.category, s.priority, s.every_n AS n, s.unit, s.next_due::text AS due, s.lead_days AS lead, coalesce(rm.number, s.area, '') AS where_, u.full_name AS who, v.name AS vendor, s.estimated_cost_minor::text AS est, s.last_created_for::text AS last
      FROM maintenance_schedule s LEFT JOIN room rm ON rm.id = s.room_id LEFT JOIN staff_user u ON u.id = s.assigned_to LEFT JOIN maintenance_vendor v ON v.id = s.vendor_id WHERE s.tenant_id = ${c.tenantId} AND s.property_id = ${c.propertyId} AND s.active AND s.next_due <= ${c.to}::date ORDER BY s.next_due`.execute(c.trx);
    const U: Record<string, string> = { DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' };
    const rows: Row[] = r.rows.map((x): Row => ({ due: x.due, days: Math.round((Date.parse(`${x.due}T00:00:00Z`) - Date.parse(`${bd}T00:00:00Z`)) / 86_400_000), title: x.title, where: x.where_, cat: CAT[x.category] ?? x.category, every: `${x.n} ${U[x.unit] ?? x.unit}${x.n === 1 ? '' : 's'}`, lead: x.lead, who: x.who ?? '', vendor: x.vendor ?? '', est: x.est ?? '0', state: x.due < bd ? 'Overdue' : 'Due soon' }));
    return { kpis: [{ key: 'n', label: 'Schedules due', value: rows.length, type: 'int', definition: 'Due on or before the end of the period.' }, { key: 'od', label: 'Overdue', value: rows.filter((x) => x.state === 'Overdue').length, type: 'int', tone: rows.some((x) => x.state === 'Overdue') ? 'bad' : 'ok', definition: 'Past their due date.' }],
      columns: [{ key: 'due', label: 'Next due', type: 'date' }, { key: 'days', label: 'Days', type: 'int' }, { key: 'title', label: 'Work' }, { key: 'where', label: 'Room or area' }, { key: 'cat', label: 'Category' }, { key: 'every', label: 'Every' }, { key: 'lead', label: 'Raised days before', type: 'int', hidden: true }, { key: 'who', label: 'Assigned to' }, { key: 'vendor', label: 'Vendor', hidden: true }, { key: 'est', label: 'Estimated cost', type: 'money', total: true, hidden: true }, { key: 'state', label: 'State', type: 'badge' }], rows };
  },
};

export const vendors: Def = {
  id: 'vendor-performance', name: 'Maintenance vendor performance', category: 'rooms', kind: 'analytical', permissions: ['maintenance.view', 'report.view'], roles: ['maintenance', 'manager', 'accounts'],
  purpose: 'Each vendor’s jobs: how many, how fast they were finished against the contract time, and what they cost.',
  basis: [{ id: 'done', label: 'Date the job was raised' }], range: 'last30',
  definitions: [{ term: 'Finish time', text: 'Hours from raised to done, for jobs finished.' }, { term: 'Within contract', text: 'Jobs finished within the vendor’s fix time in the contract. Shown only where a fix time is set.' }, { term: 'Cost', text: 'Cost recorded on the jobs.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT v.name, v.sla_fix_hours AS fix, v.sla_response_hours AS resp, count(*)::int AS jobs, count(*) FILTER (WHERE w.done_at IS NOT NULL)::int AS done, coalesce(sum(w.cost_minor), 0)::text AS cost,
        avg(extract(epoch FROM (w.done_at - w.created_at))/3600) FILTER (WHERE w.done_at IS NOT NULL) AS avg_h, avg(extract(epoch FROM (coalesce(w.started_at, w.assigned_at) - w.created_at))/3600) FILTER (WHERE coalesce(w.started_at, w.assigned_at) IS NOT NULL) AS avg_r,
        count(*) FILTER (WHERE w.done_at IS NOT NULL AND v.sla_fix_hours IS NOT NULL AND extract(epoch FROM (w.done_at - w.created_at))/3600 <= v.sla_fix_hours)::int AS within
      FROM work_order w JOIN maintenance_vendor v ON v.tenant_id = w.tenant_id AND v.id = w.vendor_id WHERE w.tenant_id = ${c.tenantId} AND w.property_id = ${c.propertyId} AND w.status NOT IN ('CANCELLED','REJECTED') AND (w.created_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY v.id, v.tenant_id, v.name, v.sla_fix_hours, v.sla_response_hours ORDER BY count(*) DESC`.execute(c.trx);
    const rows: Row[] = r.rows.map((x): Row => ({ vendor: x.name, jobs: x.jobs, done: x.done, avgFix: x.avg_h == null ? '' : String(Math.round(Number(x.avg_h) * 10) / 10), avgResp: x.avg_r == null ? '' : String(Math.round(Number(x.avg_r) * 10) / 10), contract: x.fix == null ? '' : String(x.fix), within: x.fix == null || !x.done ? '' : `${pctOf(x.within, x.done)}%`, cost: x.cost }));
    return { kpis: [{ key: 'v', label: 'Vendors used', value: rows.length, type: 'int', definition: 'Vendors with jobs in the period.' }, { key: 'j', label: 'Jobs', value: rows.reduce((s, x) => s + Number(x.jobs), 0), type: 'int', definition: 'Jobs given to vendors.' }, { key: 'cost', label: 'Cost', value: dec(rows.reduce((s, x) => s + BigInt(x.cost as string), 0n)), type: 'money', definition: 'Recorded cost.' }],
      columns: [{ key: 'vendor', label: 'Vendor' }, { key: 'jobs', label: 'Jobs', type: 'int', total: true }, { key: 'done', label: 'Finished', type: 'int', total: true }, { key: 'avgResp', label: 'Avg to start (h)', type: 'text' }, { key: 'avgFix', label: 'Avg to finish (h)', type: 'text' }, { key: 'contract', label: 'Contract fix time (h)', type: 'text' }, { key: 'within', label: 'Within contract', type: 'text' }, { key: 'cost', label: 'Cost', type: 'money', total: true }], rows, notes: ['Quality of the work and warranty returns are not recorded.'] };
  },
};
