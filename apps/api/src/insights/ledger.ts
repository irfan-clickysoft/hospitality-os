import { sql } from 'kysely';
import type { Def, Result, Row } from './types.js';
import { dec, local } from './util.js';

const METHOD: Record<string, string> = { CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', CARD_SLIP: 'Card (slip)', WALLET: 'Wallet' };
const KIND: Record<string, string> = { PAYMENT: 'Payment', DEPOSIT: 'Deposit / advance', REFUND: 'Refund' };
const STATUS: Record<string, string> = { CAPTURED: 'Received', PENDING_VERIFICATION: 'Waiting to be verified', REJECTED: 'Rejected', VOIDED: 'Voided' };
const sumBy = (rows: Row[], k: string, f: (x: Row) => boolean = () => true) => rows.filter(f).reduce((s, x) => s + BigInt(x[k] as string), 0n);

/** Every payment, deposit and refund, one line each, with who took it and on which cashier shift. Also grouped by method, kind or person. */
export const payments: Def = {
  id: 'payments', name: 'Payment receipts and methods', category: 'finance', kind: 'financial', permissions: ['report.view', 'cashier.review'], roles: ['accounts', 'manager'],
  purpose: 'Money received and refunded, by receipt: who paid, how, who took it and on which shift. Group it to see totals by payment method, by deposit or payment or refund, or by cashier.',
  basis: [{ id: 'business', label: 'Business date of the payment' }, { id: 'created', label: 'Date and time it was entered' }], range: 'today',
  params: [
    { key: 'view', label: 'Show', default: 'all', options: [{ value: 'all', label: 'All receipts' }, { value: 'deposits', label: 'Deposits and advances' }, { value: 'payments', label: 'Payments' }, { value: 'refunds', label: 'Refunds' }, { value: 'pending', label: 'Waiting to be verified' }, { value: 'voided', label: 'Voided or rejected' }] },
    { key: 'group', label: 'Group by', default: 'list', options: [{ value: 'list', label: 'Each receipt' }, { value: 'method', label: 'Payment method' }, { value: 'kind', label: 'Deposit, payment or refund' }, { value: 'by', label: 'Taken by' }] },
  ],
  definitions: [
    { term: 'Received', text: 'Payments and deposits that are captured. A bank transfer or slip waiting for verification is shown but not counted as received.' },
    { term: 'Refunds', text: 'Money paid back, shown as a negative amount.' },
    { term: 'Net collected', text: 'Received minus refunds. This is cash collected, not revenue earned and not what is owed.' },
    { term: 'Voided or rejected', text: 'Receipts cancelled or refused. They never count towards money received.' },
  ],
  async run(c) {
    const col = c.basis === 'created' ? sql.raw(`(p.created_at AT TIME ZONE '${c.prop.timezone.replace(/[^A-Za-z_\/+-]/g, '')}')::date`) : sql.raw('p.business_date');
    const r = await sql<Record<string, any>>`SELECT p.id, p.receipt_no, p.kind, p.method, p.status, p.amount_minor::text AS amt, p.reference, p.card_last4, p.counterparty, p.note, p.void_reason, p.business_date::text AS bd, ${local(sql.raw('p.created_at'), c)} AS at,
        f.folio_no, f.folio_type, r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, co.name AS company, u.full_name AS by, cs.register_name AS reg
      FROM payment p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id LEFT JOIN reservation r ON r.tenant_id = f.tenant_id AND r.id = f.reservation_id LEFT JOIN guest g ON g.tenant_id = f.tenant_id AND g.id = coalesce(f.guest_id, r.guest_id)
        LEFT JOIN company co ON co.tenant_id = f.tenant_id AND co.id = coalesce(f.company_id, r.company_id) LEFT JOIN staff_user u ON u.id = p.created_by LEFT JOIN cashier_session cs ON cs.id = p.cashier_session_id
      WHERE p.tenant_id = ${c.tenantId} AND p.property_id = ${c.propertyId} AND ${col} BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY p.created_at DESC`.execute(c.trx);
    let rows: Row[] = r.rows.map((x): Row => { const out = x.kind === 'REFUND'; const counted = x.status === 'CAPTURED';
      return { _res: x.rid, bd: x.bd, at: x.at, receipt: x.receipt_no ?? '', kind: KIND[x.kind] ?? x.kind, method: METHOD[x.method] ?? x.method, status: STATUS[x.status] ?? x.status, bill: x.folio_no, conf: x.conf ?? '', who: x.company ?? x.guest ?? '', amount: out ? (-BigInt(x.amt)).toString() : x.amt, counted: counted ? (out ? (-BigInt(x.amt)).toString() : x.amt) : '0',
        ref: x.reference ?? x.counterparty ?? '', card: x.card_last4 ?? '', by: x.by ?? '', reg: x.reg ?? '', note: x.void_reason ?? x.note ?? '', _k: x.kind, _s: x.status }; });
    const v = c.params.view ?? 'all';
    if (v === 'deposits') rows = rows.filter((x) => x._k === 'DEPOSIT'); else if (v === 'payments') rows = rows.filter((x) => x._k === 'PAYMENT'); else if (v === 'refunds') rows = rows.filter((x) => x._k === 'REFUND');
    else if (v === 'pending') rows = rows.filter((x) => x._s === 'PENDING_VERIFICATION'); else if (v === 'voided') rows = rows.filter((x) => x._s === 'VOIDED' || x._s === 'REJECTED');
    const received = sumBy(rows, 'counted', (x) => x._k !== 'REFUND'); const refunded = sumBy(rows, 'counted', (x) => x._k === 'REFUND'); const pending = sumBy(rows, 'amount', (x) => x._s === 'PENDING_VERIFICATION');
    const kpis: Result['kpis'] = [{ key: 'n', label: 'Receipts', value: rows.length, type: 'int', definition: 'Payments, deposits and refunds in the view.' }, { key: 'rec', label: 'Received', value: dec(received), type: 'money', definition: 'Captured payments and deposits.' },
      { key: 'ref', label: 'Refunded', value: dec(-refunded), type: 'money', definition: 'Captured refunds paid out.' }, { key: 'net', label: 'Net collected', value: dec(received + refunded), type: 'money', definition: 'Received minus refunded.' },
      { key: 'pend', label: 'Waiting to be verified', value: dec(pending), type: 'money', tone: pending > 0n ? 'warn' : 'ok', definition: 'Bank transfers or slips taken but not yet verified. Not counted as received.' }];
    const g = c.params.group ?? 'list';
    if (g === 'list') return { kpis, rows: rows.map(({ _k, _s, ...x }) => x as Row), notes: NOTES,
      columns: [{ key: 'bd', label: 'Business date', type: 'date' }, { key: 'at', label: 'Entered', type: 'datetime', hidden: true }, { key: 'receipt', label: 'Receipt' }, { key: 'kind', label: 'Type', type: 'badge' }, { key: 'method', label: 'Method' }, { key: 'status', label: 'Status', type: 'badge' }, { key: 'who', label: 'Guest or company' }, { key: 'conf', label: 'Booking' }, { key: 'bill', label: 'Bill', hidden: true },
        { key: 'amount', label: 'Amount', type: 'money' }, { key: 'counted', label: 'Counted', type: 'money', total: true }, { key: 'ref', label: 'Reference' }, { key: 'card', label: 'Card last 4', hidden: true }, { key: 'by', label: 'Taken by' }, { key: 'reg', label: 'Register', hidden: true }, { key: 'note', label: 'Note', hidden: true }] };
    const key = g === 'method' ? 'method' : g === 'kind' ? 'kind' : 'by'; const map = new Map<string, { n: number; rec: bigint; ref: bigint }>();
    for (const x of rows) { const k = String(x[key] ?? '') || '—'; const m = map.get(k) ?? { n: 0, rec: 0n, ref: 0n }; m.n++; if (x._k === 'REFUND') m.ref += BigInt(x.counted as string); else m.rec += BigInt(x.counted as string); map.set(k, m); }
    const grouped: Row[] = [...map.entries()].sort((a, b) => (a[1].rec < b[1].rec ? 1 : -1)).map(([k, m]) => ({ what: k, n: m.n, received: m.rec.toString(), refunded: (-m.ref).toString(), net: (m.rec + m.ref).toString() }));
    return { kpis, rows: grouped, notes: NOTES, chart: { kind: 'bar', x: 'what', series: [{ key: 'net', label: 'Net collected' }] },
      columns: [{ key: 'what', label: g === 'method' ? 'Method' : g === 'kind' ? 'Type' : 'Taken by' }, { key: 'n', label: 'Receipts', type: 'int', total: true }, { key: 'received', label: 'Received', type: 'money', total: true }, { key: 'refunded', label: 'Refunded', type: 'money', total: true }, { key: 'net', label: 'Net collected', type: 'money', total: true }] };
  },
};
const NOTES = ['Gateway, OTA virtual-card and bank-deposit settlements are not recorded by the system yet, so this is what the desk entered, not what the bank received.'];

/** Corrections to bills: refunds, voided receipts, adjustments and reversed charges, with the reason and who did it. */
export const refunds: Def = {
  id: 'refunds-adjustments', name: 'Refunds, voids and adjustments', category: 'finance', kind: 'audit', permissions: ['report.view'], roles: ['manager', 'accounts'],
  purpose: 'Every correction to money: refunds paid, receipts voided or rejected, bill adjustments and reversed charges, with the reason and who did it.',
  basis: [{ id: 'business', label: 'Business date' }], range: 'month',
  definitions: [{ term: 'Refund', text: 'Money paid back to a guest, from the payment record.' }, { term: 'Void or rejected receipt', text: 'A payment cancelled by staff or refused on verification. The amount is what was entered.' }, { term: 'Adjustment and reversal', text: 'Bill postings that change or cancel an earlier charge. Negative lowers the bill.' }],
  async run(c) {
    const a = await sql<Record<string, any>>`SELECT p.id, p.receipt_no, p.kind, p.method, p.status, p.amount_minor::text AS amt, p.void_reason, p.note, p.business_date::text AS bd, f.folio_no, r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, u.full_name AS by
      FROM payment p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id LEFT JOIN reservation r ON r.tenant_id = f.tenant_id AND r.id = f.reservation_id LEFT JOIN guest g ON g.tenant_id = f.tenant_id AND g.id = coalesce(f.guest_id, r.guest_id) LEFT JOIN staff_user u ON u.id = p.created_by
      WHERE p.tenant_id = ${c.tenantId} AND p.property_id = ${c.propertyId} AND (p.kind = 'REFUND' OR p.status IN ('VOIDED','REJECTED')) AND p.business_date BETWEEN ${c.from}::date AND ${c.to}::date`.execute(c.trx);
    const b = await sql<Record<string, any>>`SELECT p.id, p.posting_type, p.txn_code, p.description, p.amount_minor::text AS amt, p.reason_code, p.note, p.business_date::text AS bd, f.folio_no, r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, u.full_name AS by
      FROM folio_posting p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id LEFT JOIN reservation r ON r.tenant_id = f.tenant_id AND r.id = f.reservation_id LEFT JOIN guest g ON g.tenant_id = f.tenant_id AND g.id = coalesce(f.guest_id, r.guest_id) LEFT JOIN staff_user u ON u.id = p.created_by
      WHERE p.tenant_id = ${c.tenantId} AND p.property_id = ${c.propertyId} AND p.posting_type IN ('ADJUSTMENT','REVERSAL') AND p.business_date BETWEEN ${c.from}::date AND ${c.to}::date`.execute(c.trx);
    const rows: Row[] = [
      ...a.rows.map((x): Row => ({ _res: x.rid, bd: x.bd, kind: x.kind === 'REFUND' && x.status === 'CAPTURED' ? 'Refund' : x.status === 'REJECTED' ? 'Rejected receipt' : x.status === 'VOIDED' ? 'Voided receipt' : 'Refund (not paid)', ref: x.receipt_no ?? '', bill: x.folio_no, conf: x.conf ?? '', guest: x.guest ?? '', detail: METHOD[x.method] ?? x.method, amount: x.amt, reason: x.void_reason ?? x.note ?? '', by: x.by ?? '' })),
      ...b.rows.map((x): Row => ({ _res: x.rid, bd: x.bd, kind: x.posting_type === 'REVERSAL' ? 'Reversed charge' : 'Adjustment', ref: x.txn_code, bill: x.folio_no, conf: x.conf ?? '', guest: x.guest ?? '', detail: x.description ?? '', amount: x.amt, reason: x.note ?? x.reason_code ?? '', by: x.by ?? '' })),
    ].sort((p, q) => String(q.bd).localeCompare(String(p.bd)));
    const sum = (f: (x: Row) => boolean) => rows.filter(f).reduce((s, x) => s + BigInt(x.amount as string), 0n); const n = (k: string) => rows.filter((x) => x.kind === k).length;
    return { kpis: [{ key: 'ref', label: 'Refunds paid', value: dec(sum((x) => x.kind === 'Refund')), type: 'money', definition: 'Captured refunds in the period.' }, { key: 'void', label: 'Voided or rejected receipts', value: n('Voided receipt') + n('Rejected receipt'), type: 'int', tone: n('Voided receipt') + n('Rejected receipt') > 0 ? 'warn' : 'ok', definition: 'Receipts cancelled or refused.' },
        { key: 'adj', label: 'Adjustments and reversals', value: n('Adjustment') + n('Reversed charge'), type: 'int', definition: 'Bill postings that changed or cancelled a charge.' }, { key: 'adjv', label: 'Net adjustment value', value: dec(sum((x) => x.kind === 'Adjustment' || x.kind === 'Reversed charge')), type: 'money', definition: 'Sum of adjustments and reversals. Negative lowers bills.' }],
      columns: [{ key: 'bd', label: 'Business date', type: 'date' }, { key: 'kind', label: 'Type', type: 'badge' }, { key: 'ref', label: 'Receipt or code' }, { key: 'conf', label: 'Booking' }, { key: 'guest', label: 'Guest' }, { key: 'bill', label: 'Bill', hidden: true }, { key: 'detail', label: 'Detail' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'reason', label: 'Reason' }, { key: 'by', label: 'By' }],
      rows, notes: ['Amounts are as entered. Refunds and voids are shown once; a refund against a voided payment appears on its own line.'] };
  },
};

const TXN: Record<string, string> = { ROOM: 'Room', ROOM_DISCOUNT: 'Room discount', DISCOUNT: 'Bill discount', EXTRA_BED: 'Extra bed', LATE_CHECKOUT: 'Late checkout', EARLY_CHECKIN: 'Early check-in', CANCEL_FEE: 'Cancellation fee', NO_SHOW_FEE: 'No-show fee', DAMAGE: 'Damage' };
const txnName = (code: string) => TXN[code] ?? code.replace(/_/g, ' ').toLowerCase().replace(/^./, (m) => m.toUpperCase());

/** Revenue as it was posted to bills for the business day. It is neither cash collected nor a forecast. */
export const revenueSummary: Def = {
  id: 'revenue-summary', name: 'Daily revenue summary', category: 'finance', kind: 'financial', permissions: ['report.view'], roles: ['accounts', 'manager'],
  purpose: 'Revenue posted to guest and company bills, by charge type or by day: charges, discounts, corrections and the net, before tax.',
  basis: [{ id: 'posted', label: 'Business date it was posted' }], range: 'month',
  params: [{ key: 'group', label: 'Group by', default: 'code', options: [{ value: 'code', label: 'Charge type' }, { value: 'day', label: 'Day' }] }],
  definitions: [
    { term: 'Charges', text: 'Room and other charges posted to bills, before tax.' }, { term: 'Discounts', text: 'Discounts posted on bills, shown as negative.' }, { term: 'Corrections', text: 'Adjustments and reversed charges, before tax. Negative lowers revenue.' },
    { term: 'Net revenue', text: 'Charges + discounts + corrections, before tax. Posted revenue only: not cash collected, not what is owed and not a forecast.' }, { term: 'Tax', text: 'Taxes charged on top. Shown separately and never part of net revenue.' },
  ],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT p.business_date::text AS bd, p.txn_code AS code, p.posting_type AS t, sum(p.amount_minor)::text AS amt, count(*)::int AS n
      FROM folio_posting p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id
      WHERE p.tenant_id = ${c.tenantId} AND p.property_id = ${c.propertyId} AND f.folio_type <> 'HOUSE' AND p.posting_type IN ('CHARGE','DISCOUNT','ADJUSTMENT','REVERSAL','TAX') AND p.business_date BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY 1, 2, 3`.execute(c.trx);
    const map = new Map<string, { ch: bigint; di: bigint; co: bigint; tax: bigint; n: number }>(); const g = c.params.group ?? 'code';
    for (const x of r.rows) {
      const k = g === 'day' ? x.bd : txnName(x.code === 'TAX' ? 'Tax' : x.code); if (x.t === 'TAX' && g !== 'day') continue;
      const m = map.get(k) ?? { ch: 0n, di: 0n, co: 0n, tax: 0n, n: 0 }; const v = BigInt(x.amt);
      if (x.t === 'CHARGE') { m.ch += v; m.n += x.n; } else if (x.t === 'DISCOUNT') m.di += v; else if (x.t === 'TAX') m.tax += v; else m.co += v; map.set(k, m);
    }
    const rows: Row[] = [...map.entries()].sort((a, b) => (g === 'day' ? a[0].localeCompare(b[0]) : a[1].ch < b[1].ch ? 1 : -1)).map(([k, m]) => ({ what: k, n: m.n, charges: m.ch.toString(), discounts: m.di.toString(), corrections: m.co.toString(), net: (m.ch + m.di + m.co).toString(), tax: m.tax.toString() }));
    const sum = (k: string) => rows.reduce((s, x) => s + BigInt(x[k] as string), 0n);
    return { kpis: [{ key: 'ch', label: 'Charges', value: dec(sum('charges')), type: 'money', definition: 'Posted charges before tax.' }, { key: 'di', label: 'Discounts', value: dec(sum('discounts')), type: 'money', definition: 'Discounts posted on bills (negative).' }, { key: 'net', label: 'Net revenue', value: dec(sum('net')), type: 'money', definition: 'Charges + discounts + corrections, before tax.' }],
      columns: [{ key: 'what', label: g === 'day' ? 'Business date' : 'Charge type', ...(g === 'day' ? { type: 'date' as const } : {}) }, { key: 'n', label: 'Charges posted', type: 'int', total: true }, { key: 'charges', label: 'Charges', type: 'money', total: true }, { key: 'discounts', label: 'Discounts', type: 'money', total: true }, { key: 'corrections', label: 'Corrections', type: 'money', total: true }, { key: 'net', label: 'Net revenue', type: 'money', total: true }, ...(g === 'day' ? [{ key: 'tax', label: 'Tax (separate)', type: 'money' as const, total: true }] : [])],
      rows, chart: { kind: g === 'day' ? 'line' : 'bar', x: 'what', series: [{ key: 'net', label: 'Net revenue' }] }, notes: ['House accounts are left out. Tax is shown only when grouped by day; see the Taxes report for the breakdown.'] };
  },
};

/** Tax and service charges posted, by code and rate, with the amount they were charged on. */
export const taxes: Def = {
  id: 'taxes', name: 'Taxes and service charges', category: 'finance', kind: 'financial', permissions: ['report.view', 'tax.configure'], roles: ['accounts', 'manager'],
  purpose: 'Tax and service charge posted to bills, by tax code and rate: the amount charged on, and the tax.',
  basis: [{ id: 'posted', label: 'Business date it was posted' }], range: 'month',
  definitions: [{ term: 'Taxable amount', text: 'The charge the tax was worked out on. Discounts and reversals lower it.' }, { term: 'Tax', text: 'Tax posted. Negative amounts are tax taken back by a discount or reversal.' }, { term: 'Not a filing', text: 'This lists what the system posted. It is not a tax return.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT coalesce(p.tax_code, p.txn_code) AS code, p.tax_rate_bp AS bp, sum(coalesce(p.taxable_minor, 0))::text AS base, sum(p.amount_minor)::text AS tax, count(*)::int AS n
      FROM folio_posting p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id WHERE p.tenant_id = ${c.tenantId} AND p.property_id = ${c.propertyId} AND p.posting_type = 'TAX' AND f.folio_type <> 'HOUSE' AND p.business_date BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY 1, 2 ORDER BY 1, 2`.execute(c.trx);
    const rows: Row[] = r.rows.map((x): Row => ({ code: x.code, rate: x.bp == null ? '' : `${(x.bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`, n: x.n, base: x.base, tax: x.tax }));
    const tot = rows.reduce((s, x) => s + BigInt(x.tax as string), 0n);
    return { kpis: [{ key: 'tax', label: 'Tax posted', value: dec(tot), type: 'money', definition: 'Net tax posted to bills in the period.' }, { key: 'codes', label: 'Tax codes', value: new Set(rows.map((x) => x.code)).size, type: 'int', definition: 'Different tax codes used.' }],
      columns: [{ key: 'code', label: 'Tax code' }, { key: 'rate', label: 'Rate' }, { key: 'n', label: 'Postings', type: 'int', total: true }, { key: 'base', label: 'Charged on', type: 'money', total: true }, { key: 'tax', label: 'Tax', type: 'money', total: true }],
      rows, notes: ['Service charge is listed here only if the property posts it as a tax code. Input tax and tax paid are not recorded.'] };
  },
};

/** Things that do not add up or were done outside the normal path. Each line says what and where. */
export const exceptions: Def = {
  id: 'financial-exceptions', name: 'Financial exceptions', category: 'finance', kind: 'audit', permissions: ['report.view'], roles: ['manager', 'accounts'],
  purpose: 'Bills that do not add up, closed bills that still owe money, cash taken outside a cashier shift, receipts waiting too long to be verified, and shifts that closed with a cash difference.',
  basis: [{ id: 'business', label: 'Business date' }], range: 'month',
  definitions: [
    { term: 'Bill does not add up', text: 'The balance stored on the bill differs from the total of its postings.' }, { term: 'Closed with balance', text: 'A bill that was closed while it still showed an amount owing or a credit.' }, { term: 'Cash outside a shift', text: 'A cash receipt or refund with no cashier shift, so it cannot be counted in a cash drawer.' },
    { term: 'Waiting to be verified', text: 'A bank transfer or slip entered more than two days ago and still not verified.' }, { term: 'Cash difference', text: 'A closed shift where the counted cash differs from what was expected.' },
  ],
  async run(c) {
    const out: Row[] = [];
    const a = await sql<Record<string, any>>`SELECT f.folio_no, f.balance_minor::text AS bal, f.status, f.closed_at::date::text AS closed, r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, coalesce((SELECT sum(amount_minor) FROM folio_posting x WHERE x.tenant_id = f.tenant_id AND x.folio_id = f.id), 0)::text AS posted
      FROM folio f LEFT JOIN reservation r ON r.tenant_id = f.tenant_id AND r.id = f.reservation_id LEFT JOIN guest g ON g.tenant_id = f.tenant_id AND g.id = coalesce(f.guest_id, r.guest_id) WHERE f.tenant_id = ${c.tenantId} AND f.property_id = ${c.propertyId} AND f.folio_type <> 'HOUSE'`.execute(c.trx);
    for (const x of a.rows) {
      if (BigInt(x.bal) !== BigInt(x.posted)) out.push({ _res: x.rid, bd: c.prop.businessDate, kind: 'Bill does not add up', sev: 'High', what: x.folio_no, conf: x.conf ?? '', guest: x.guest ?? '', amount: (BigInt(x.bal) - BigInt(x.posted)).toString(), detail: `Stored balance ${dec(x.bal)}, postings total ${dec(x.posted)}` });
      if (x.status === 'CLOSED' && BigInt(x.bal) !== 0n && x.closed && x.closed >= c.from && x.closed <= c.to) out.push({ _res: x.rid, bd: x.closed, kind: 'Closed with balance', sev: 'High', what: x.folio_no, conf: x.conf ?? '', guest: x.guest ?? '', amount: x.bal, detail: BigInt(x.bal) > 0n ? 'Closed while the guest still owed money' : 'Closed with a credit left on the bill' });
    }
    const b = await sql<Record<string, any>>`SELECT p.business_date::text AS bd, p.kind, p.method, p.status, p.amount_minor::text AS amt, p.receipt_no, p.created_at::date::text AS entered, f.folio_no, r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, u.full_name AS by, p.cashier_session_id
      FROM payment p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id LEFT JOIN reservation r ON r.tenant_id = f.tenant_id AND r.id = f.reservation_id LEFT JOIN guest g ON g.tenant_id = f.tenant_id AND g.id = coalesce(f.guest_id, r.guest_id) LEFT JOIN staff_user u ON u.id = p.created_by
      WHERE p.tenant_id = ${c.tenantId} AND p.property_id = ${c.propertyId} AND p.business_date BETWEEN ${c.from}::date AND ${c.to}::date AND ((p.method = 'CASH' AND p.cashier_session_id IS NULL AND p.status = 'CAPTURED') OR (p.status = 'PENDING_VERIFICATION' AND p.business_date < ${c.prop.businessDate}::date - 2))`.execute(c.trx);
    for (const x of b.rows) out.push({ _res: x.rid, bd: x.bd, kind: x.status === 'PENDING_VERIFICATION' ? 'Waiting to be verified' : 'Cash outside a shift', sev: x.status === 'PENDING_VERIFICATION' ? 'Medium' : 'High', what: x.receipt_no ?? x.folio_no, conf: x.conf ?? '', guest: x.guest ?? '', amount: x.kind === 'REFUND' ? (-BigInt(x.amt)).toString() : x.amt, detail: `${x.kind === 'REFUND' ? 'Refund' : 'Receipt'} entered by ${x.by ?? 'unknown'}` });
    const d = await sql<Record<string, any>>`SELECT s.opened_business_date::text AS bd, s.register_name AS reg, s.variance_minor::text AS v, u.full_name AS cashier, s.close_note FROM cashier_session s JOIN staff_user u ON u.id = s.user_id WHERE s.tenant_id = ${c.tenantId} AND s.property_id = ${c.propertyId} AND s.status <> 'OPEN' AND coalesce(s.variance_minor, 0) <> 0 AND s.opened_business_date BETWEEN ${c.from}::date AND ${c.to}::date`.execute(c.trx);
    for (const x of d.rows) out.push({ bd: x.bd, kind: 'Cash difference', sev: 'Medium', what: x.reg, conf: '', guest: '', amount: x.v, detail: `Cashier ${x.cashier}${x.close_note ? `: ${x.close_note}` : ''}` });
    out.sort((p, q) => String(q.bd).localeCompare(String(p.bd)));
    const n = (k: string) => out.filter((x) => x.kind === k).length;
    return { kpis: [{ key: 'n', label: 'Exceptions', value: out.length, type: 'int', tone: out.length ? 'bad' : 'ok', definition: 'Items that need a look.' }, { key: 'bill', label: 'Bills not adding up', value: n('Bill does not add up'), type: 'int', tone: n('Bill does not add up') ? 'bad' : 'ok', definition: 'Stored balance differs from postings.' },
        { key: 'closed', label: 'Closed with balance', value: n('Closed with balance'), type: 'int', definition: 'Bills closed with money owing or a credit.' }, { key: 'cash', label: 'Cash outside a shift', value: n('Cash outside a shift'), type: 'int', definition: 'Cash with no cashier shift.' }],
      columns: [{ key: 'bd', label: 'Date', type: 'date' }, { key: 'kind', label: 'Exception', type: 'badge' }, { key: 'sev', label: 'Level' }, { key: 'what', label: 'Bill, receipt or register' }, { key: 'conf', label: 'Booking' }, { key: 'guest', label: 'Guest' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'detail', label: 'What happened' }],
      rows: out, notes: ['“Does not add up” checks every bill at the property today, whatever the dates. The other checks use the dates chosen. Reopened bills, write-offs and payment-gateway differences are not recorded by the system yet.'] };
  },
};
