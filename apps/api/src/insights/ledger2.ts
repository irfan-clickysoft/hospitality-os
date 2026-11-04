import { sql } from 'kysely';
import type { Def, Row } from './types.js';
import { dec, local } from './util.js';

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/** Company receivables: what each company still owes, aged from the due date. */
export const receivables: Def = {
  id: 'receivables-ageing', name: 'Receivables ledger and ageing', category: 'finance', kind: 'financial', permissions: ['report.view', 'company.view'], roles: ['accounts', 'manager'],
  purpose: 'Company bills billed to the company account, what has been paid against them, and what is still owing, aged from the due date.',
  basis: [{ id: 'asof', label: 'As of the business date' }], range: 'none',
  params: [{ key: 'group', label: 'Show', default: 'company', options: [{ value: 'company', label: 'By company, aged' }, { value: 'items', label: 'Each billing' }, { value: 'overdue', label: 'Overdue billings only' }] }],
  definitions: [{ term: 'Open amount', text: 'Billed amount minus money applied from company receipts. Cancelled billings are left out.' }, { term: 'Ageing', text: 'Days past the due date as of the business date. Not yet due is “Current”.' }, { term: 'Withholding', text: 'Tax a company withholds is recorded with the receipt and counted as paid.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT i.id, co.name AS company, i.confirmation_no AS conf, i.guest_name AS guest, i.item_date::text AS billed, i.due_date::text AS due, i.amount_minor::text AS amt, i.reservation_id AS rid, f.folio_no,
        coalesce((SELECT sum(a.applied_minor) FROM ar_allocation a WHERE a.tenant_id = i.tenant_id AND a.item_id = i.id), 0)::text AS paid
      FROM ar_item i JOIN company co ON co.tenant_id = i.tenant_id AND co.id = i.company_id LEFT JOIN folio f ON f.tenant_id = i.tenant_id AND f.id = i.folio_id
      WHERE i.tenant_id = ${c.tenantId} AND i.property_id = ${c.propertyId} AND NOT EXISTS (SELECT 1 FROM ar_item_void v WHERE v.tenant_id = i.tenant_id AND v.item_id = i.id) ORDER BY i.due_date`.execute(c.trx);
    const bucket = (d: number) => (d <= 0 ? 'Current' : d <= 30 ? '1–30' : d <= 60 ? '31–60' : d <= 90 ? '61–90' : 'Over 90');
    const items: Row[] = r.rows.map((x): Row => { const open = BigInt(x.amt) - BigInt(x.paid); const late = daysBetween(c.prop.businessDate, x.due); return { _res: x.rid, company: x.company, conf: x.conf ?? '', guest: x.guest ?? '', bill: x.folio_no ?? '', billed: x.billed, due: x.due, amount: x.amt, paid: x.paid, open: open.toString(), late: Math.max(0, late), bucket: open === 0n ? 'Paid' : bucket(late) }; }).filter((x) => BigInt(x.open as string) !== 0n);
    const g = c.params.group ?? 'company'; const sum = (rows: Row[], k = 'open') => rows.reduce((s, x) => s + BigInt(x[k] as string), 0n); const overdue = items.filter((x) => x.bucket !== 'Current');
    const kpis = [{ key: 'open', label: 'Total receivable', value: dec(sum(items)), type: 'money' as const, definition: 'Open amount on all billings.' }, { key: 'over', label: 'Overdue', value: dec(sum(overdue)), type: 'money' as const, tone: overdue.length ? ('warn' as const) : ('ok' as const), definition: 'Open amount past its due date.' }, { key: 'n', label: 'Open billings', value: items.length, type: 'int' as const, definition: 'Billings with something still owing.' }];
    const notes = ['Disputes, promises to pay, write-offs and credit limits are not recorded yet.'];
    if (g !== 'company') { const rows = g === 'overdue' ? overdue : items; return { kpis, rows, notes, columns: [{ key: 'company', label: 'Company' }, { key: 'conf', label: 'Booking' }, { key: 'guest', label: 'Guest' }, { key: 'billed', label: 'Billed', type: 'date' }, { key: 'due', label: 'Due', type: 'date' }, { key: 'amount', label: 'Billed amount', type: 'money', total: true }, { key: 'paid', label: 'Paid', type: 'money', total: true }, { key: 'open', label: 'Open', type: 'money', total: true }, { key: 'late', label: 'Days late', type: 'int' }, { key: 'bucket', label: 'Age', type: 'badge' }, { key: 'bill', label: 'Bill', hidden: true }] }; }
    type Ages = { Current: bigint; '1–30': bigint; '31–60': bigint; '61–90': bigint; 'Over 90': bigint; total: bigint }; const map = new Map<string, Ages>();
    for (const x of items) { const m = map.get(x.company as string) ?? { Current: 0n, '1–30': 0n, '31–60': 0n, '61–90': 0n, 'Over 90': 0n, total: 0n }; m[x.bucket as Exclude<keyof Ages, 'total'>] += BigInt(x.open as string); m.total += BigInt(x.open as string); map.set(x.company as string, m); }
    const rows: Row[] = [...map.entries()].sort((a, b) => (a[1].total < b[1].total ? 1 : -1)).map(([k, m]) => ({ company: k, current: m.Current.toString(), d30: m['1–30'].toString(), d60: m['31–60'].toString(), d90: m['61–90'].toString(), d90p: m['Over 90'].toString(), total: m.total.toString() }));
    return { kpis, rows, notes, chart: { kind: 'bar', x: 'company', series: [{ key: 'total', label: 'Open' }] },
      columns: [{ key: 'company', label: 'Company' }, { key: 'current', label: 'Current', type: 'money', total: true }, { key: 'd30', label: '1–30 days', type: 'money', total: true }, { key: 'd60', label: '31–60 days', type: 'money', total: true }, { key: 'd90', label: '61–90 days', type: 'money', total: true }, { key: 'd90p', label: 'Over 90 days', type: 'money', total: true }, { key: 'total', label: 'Total open', type: 'money', total: true }] };
  },
};

/** The guest ledger: every open guest bill of guests in the house, with charges and payments so far. */
export const guestLedger: Def = {
  id: 'guest-ledger', name: 'Guest ledger', category: 'finance', kind: 'financial', permissions: ['report.view', 'folio.view'], roles: ['accounts', 'manager', 'frontdesk'],
  purpose: 'The open bills of guests staying now: what has been charged, taxed and paid so far, and the balance. The total is what the hotel is holding for in-house guests.',
  basis: [{ id: 'asof', label: 'As of now' }], range: 'none',
  definitions: [{ term: 'Charges', text: 'Charges and discounts, before tax.' }, { term: 'Balance', text: 'Charges + tax − payments and deposits. A negative balance is money held for the guest.' }, { term: 'Total', text: 'The sum of all in-house balances: the guest ledger control figure.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT f.folio_no, f.balance_minor::text AS bal, r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, f.id AS fid,
        (SELECT string_agg(DISTINCT rm.number, ', ') FROM reservation_room l2 JOIN room_assignment a ON a.assignment_ref = l2.id AND a.status = 'IN_HOUSE' JOIN room rm ON rm.id = a.room_id WHERE l2.tenant_id = f.tenant_id AND l2.reservation_id = f.reservation_id) AS room,
        (SELECT max(l3.departure)::text FROM reservation_room l3 WHERE l3.tenant_id = f.tenant_id AND l3.reservation_id = f.reservation_id) AS dep,
        coalesce((SELECT sum(p.amount_minor) FROM folio_posting p WHERE p.tenant_id = f.tenant_id AND p.folio_id = f.id AND p.posting_type IN ('CHARGE','DISCOUNT','ADJUSTMENT','REVERSAL')), 0)::text AS ch,
        coalesce((SELECT sum(p.amount_minor) FROM folio_posting p WHERE p.tenant_id = f.tenant_id AND p.folio_id = f.id AND p.posting_type = 'TAX'), 0)::text AS tax
      FROM folio f JOIN reservation r ON r.tenant_id = f.tenant_id AND r.id = f.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = coalesce(f.guest_id, r.guest_id)
      WHERE f.tenant_id = ${c.tenantId} AND f.property_id = ${c.propertyId} AND f.status = 'OPEN' AND f.folio_type = 'GUEST' AND EXISTS (SELECT 1 FROM reservation_room l WHERE l.tenant_id = f.tenant_id AND l.reservation_id = r.id AND l.status = 'CHECKED_IN') ORDER BY room, g.full_name`.execute(c.trx);
    const rows: Row[] = r.rows.map((x): Row => { const paid = BigInt(x.bal) - BigInt(x.ch) - BigInt(x.tax); return { _res: x.rid, room: x.room ?? '', guest: x.guest, conf: x.conf, bill: x.folio_no, departure: x.dep ?? '', charges: x.ch, tax: x.tax, paid: (-paid).toString(), balance: x.bal }; });
    const sum = (k: string) => rows.reduce((s, x) => s + BigInt(x[k] as string), 0n); const owing = rows.filter((x) => BigInt(x.balance as string) > 0n); const held = rows.filter((x) => BigInt(x.balance as string) < 0n);
    return { kpis: [{ key: 'n', label: 'In-house bills', value: rows.length, type: 'int', definition: 'Open guest bills of guests staying now.' }, { key: 'bal', label: 'Guest ledger total', value: dec(sum('balance')), type: 'money', definition: 'Sum of all in-house balances.' },
        { key: 'owe', label: 'Owing', value: dec(owing.reduce((s, x) => s + BigInt(x.balance as string), 0n)), type: 'money', definition: 'In-house guests with a balance to pay.' }, { key: 'held', label: 'Held for guests', value: dec(-held.reduce((s, x) => s + BigInt(x.balance as string), 0n)), type: 'money', definition: 'Deposits and payments above what is charged so far.' }],
      columns: [{ key: 'room', label: 'Room' }, { key: 'guest', label: 'Guest' }, { key: 'conf', label: 'Booking' }, { key: 'bill', label: 'Bill', hidden: true }, { key: 'departure', label: 'Departure', type: 'date' }, { key: 'charges', label: 'Charges', type: 'money', total: true }, { key: 'tax', label: 'Tax', type: 'money', total: true }, { key: 'paid', label: 'Paid', type: 'money', total: true }, { key: 'balance', label: 'Balance', type: 'money', total: true }],
      rows, notes: ['Company and master bills are in the Due and outstanding report.'] };
  },
};

/** Every line posted to bills: the detail behind every other finance figure. */
export const folioDetail: Def = {
  id: 'folio-detail', name: 'Guest bill detail', category: 'finance', kind: 'audit', permissions: ['report.view', 'folio.view'], roles: ['accounts', 'manager'],
  purpose: 'Every charge, tax, discount, payment and correction posted to bills in the period, one line each, with the bill, booking, charge code and who posted it.',
  basis: [{ id: 'posted', label: 'Business date it was posted' }], range: 'today',
  params: [{ key: 'view', label: 'Show', default: 'all', options: [{ value: 'all', label: 'Everything' }, { value: 'charges', label: 'Charges and discounts' }, { value: 'tax', label: 'Tax' }, { value: 'money', label: 'Payments and refunds' }, { value: 'corrections', label: 'Adjustments and reversals' }] }],
  definitions: [{ term: 'Amount', text: 'Positive raises what the guest owes; negative lowers it (payments, discounts, reversals).' }, { term: 'Source', text: 'Where the line came from: night audit, front desk, a manual entry or a system step.' }],
  async run(c) {
    const view = c.params.view ?? 'all'; const types = view === 'charges' ? ['CHARGE', 'DISCOUNT'] : view === 'tax' ? ['TAX'] : view === 'money' ? ['PAYMENT', 'DEPOSIT_RECEIVED', 'REFUND'] : view === 'corrections' ? ['ADJUSTMENT', 'REVERSAL'] : ['CHARGE', 'DISCOUNT', 'TAX', 'PAYMENT', 'DEPOSIT_RECEIVED', 'REFUND', 'ADJUSTMENT', 'REVERSAL'];
    const r = await sql<Record<string, any>>`SELECT p.business_date::text AS bd, ${local(sql.raw('p.posted_at'), c)} AS at, p.posting_type AS t, p.txn_code AS code, p.description, p.amount_minor::text AS amt, p.source_type AS src, f.folio_no, r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, co.name AS company, u.full_name AS by, p.note
      FROM folio_posting p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id LEFT JOIN reservation r ON r.tenant_id = f.tenant_id AND r.id = f.reservation_id LEFT JOIN guest g ON g.tenant_id = f.tenant_id AND g.id = coalesce(f.guest_id, r.guest_id) LEFT JOIN company co ON co.tenant_id = f.tenant_id AND co.id = coalesce(f.company_id, r.company_id) LEFT JOIN staff_user u ON u.id = p.created_by
      WHERE p.tenant_id = ${c.tenantId} AND p.property_id = ${c.propertyId} AND p.posting_type = ANY(${types}) AND p.business_date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY p.posted_at DESC LIMIT 5000`.execute(c.trx);
    const T: Record<string, string> = { CHARGE: 'Charge', DISCOUNT: 'Discount', TAX: 'Tax', PAYMENT: 'Payment', DEPOSIT_RECEIVED: 'Deposit', REFUND: 'Refund', ADJUSTMENT: 'Adjustment', REVERSAL: 'Reversal' };
    const rows: Row[] = r.rows.map((x): Row => ({ _res: x.rid, bd: x.bd, at: x.at, type: T[x.t] ?? x.t, code: x.code, detail: x.description ?? '', who: x.company ?? x.guest ?? '', conf: x.conf ?? '', bill: x.folio_no, amount: x.amt, src: x.src, by: x.by ?? '', note: x.note ?? '' }));
    const sum = (f: (x: Row) => boolean) => rows.filter(f).reduce((s, x) => s + BigInt(x.amount as string), 0n);
    return { kpis: [{ key: 'n', label: 'Postings', value: rows.length, type: 'int', definition: 'Lines in the view.' }, { key: 'net', label: 'Net amount', value: dec(sum(() => true)), type: 'money', definition: 'Sum of the lines shown. Charges are positive, payments negative.' }],
      columns: [{ key: 'bd', label: 'Business date', type: 'date' }, { key: 'at', label: 'Posted', type: 'datetime', hidden: true }, { key: 'type', label: 'Type', type: 'badge' }, { key: 'code', label: 'Code' }, { key: 'detail', label: 'Description' }, { key: 'who', label: 'Guest or company' }, { key: 'conf', label: 'Booking' }, { key: 'bill', label: 'Bill' }, { key: 'amount', label: 'Amount', type: 'money', total: true }, { key: 'src', label: 'Source', hidden: true }, { key: 'by', label: 'Posted by', hidden: true }, { key: 'note', label: 'Note', hidden: true }],
      rows, ...(rows.length >= 5000 ? { warnings: ['Only the latest 5,000 lines are shown. Narrow the dates.'] } : {}) };
  },
};
