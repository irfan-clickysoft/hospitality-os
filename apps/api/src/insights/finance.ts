import { sql } from 'kysely';
import type { Def, Row } from './types.js';
import { dec } from './util.js';

export const cashier: Def = {
  id: 'cashier', name: 'Collection and cashier', category: 'finance', kind: 'financial', permissions: ['report.view', 'cashier.review'], roles: ['accounts', 'manager'],
  purpose: 'Each cashier shift: opening float, what was taken by method, drops, expected cash, the count and the variance. Physical cash is kept apart from cards and transfers.',
  basis: [{ id: 'opened', label: 'Business date the shift opened' }], range: 'today',
  definitions: [{ term: 'Expected closing cash', text: 'Opening float + cash receipts − cash refunds − safe drops.' }, { term: 'Variance', text: 'Counted cash − expected closing cash.' }, { term: 'Open shifts', text: 'Expected cash and variance are shown only after the shift is closed (blind close).' }, { term: 'Non-cash', text: 'Cards, bank transfers and wallets are listed by method and never added to the drawer.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT s.id, s.register_name AS reg, u.full_name AS cashier, s.status, s.opened_business_date::text AS bd, to_char(s.opened_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI') AS opened, to_char(s.closed_at AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI') AS closed,
        s.opening_float_minor::text AS fl, s.counted_minor::text AS counted, s.expected_minor::text AS expected, s.variance_minor::text AS variance, s.close_note, rv.full_name AS reviewer, s.review_note,
        coalesce((SELECT sum(p.amount_minor) FROM payment p WHERE p.cashier_session_id = s.id AND p.method = 'CASH' AND p.kind <> 'REFUND' AND p.status = 'CAPTURED'), 0)::text AS cash_in,
        coalesce((SELECT sum(p.amount_minor) FROM payment p WHERE p.cashier_session_id = s.id AND p.method = 'CASH' AND p.kind = 'REFUND' AND p.status = 'CAPTURED'), 0)::text AS cash_out,
        coalesce((SELECT sum(d.amount_minor) FROM cash_drop d WHERE d.cashier_session_id = s.id), 0)::text AS drops,
        coalesce((SELECT sum(p.amount_minor) FROM payment p WHERE p.cashier_session_id = s.id AND p.method = 'CARD_SLIP' AND p.kind <> 'REFUND' AND p.status = 'CAPTURED'), 0)::text AS card,
        coalesce((SELECT sum(p.amount_minor) FROM payment p WHERE p.cashier_session_id = s.id AND p.method = 'BANK_TRANSFER' AND p.kind <> 'REFUND' AND p.status = 'CAPTURED'), 0)::text AS bank,
        coalesce((SELECT sum(p.amount_minor) FROM payment p WHERE p.cashier_session_id = s.id AND p.method = 'WALLET' AND p.kind <> 'REFUND' AND p.status = 'CAPTURED'), 0)::text AS wallet,
        (SELECT count(*) FROM payment p WHERE p.cashier_session_id = s.id AND p.status IN ('VOIDED','REJECTED'))::int AS voids
      FROM cashier_session s JOIN staff_user u ON u.id = s.user_id LEFT JOIN staff_user rv ON rv.id = s.reviewed_by WHERE s.tenant_id = ${c.tenantId} AND s.property_id = ${c.propertyId} AND s.opened_business_date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY s.opened_at DESC`.execute(c.trx);
    const rows: Row[] = r.rows.map((x) => { const done = x.status !== 'OPEN'; const exp = done ? (x.expected ?? (BigInt(x.fl) + BigInt(x.cash_in) - BigInt(x.cash_out) - BigInt(x.drops)).toString()) : null;
      return { bd: x.bd, reg: x.reg, cashier: x.cashier, status: x.status === 'OPEN' ? 'Open' : x.status === 'REVIEWED' ? 'Reviewed' : 'Closed', opened: x.opened, closed: x.closed ?? '', float: x.fl, cashIn: x.cash_in, cashOut: x.cash_out, drops: x.drops, expected: exp, counted: done ? x.counted : null, variance: done ? x.variance : null, card: x.card, bank: x.bank, wallet: x.wallet, voids: x.voids, note: x.close_note ?? '', reviewer: x.reviewer ?? '' }; });
    const closed = rows.filter((x) => x.status !== 'Open'); const varSum = closed.reduce((s, x) => s + BigInt((x.variance as string | null) ?? '0'), 0n);
    const kp = (k: string) => rows.reduce((s, x) => s + BigInt(x[k] as string), 0n);
    return { kpis: [{ key: 'n', label: 'Shifts', value: rows.length, type: 'int', definition: 'Cashier shifts opened in the period.' }, { key: 'open', label: 'Still open', value: rows.length - closed.length, type: 'int', tone: rows.length > closed.length ? 'warn' : 'ok', definition: 'Shifts not yet closed.' },
        { key: 'cash', label: 'Cash received', value: dec(kp('cashIn')), type: 'money', definition: 'Cash payments and deposits taken, before refunds.' }, { key: 'var', label: 'Net variance (closed shifts)', value: dec(varSum), type: 'money', tone: varSum === 0n ? 'ok' : 'bad', definition: 'Sum of counted − expected over closed shifts.' }],
      columns: [{ key: 'bd', label: 'Business date', type: 'date' }, { key: 'reg', label: 'Register' }, { key: 'cashier', label: 'Cashier' }, { key: 'status', label: 'Status', type: 'badge' }, { key: 'opened', label: 'Opened', type: 'datetime', hidden: true }, { key: 'closed', label: 'Closed', type: 'datetime', hidden: true },
        { key: 'float', label: 'Opening float', type: 'money', total: true }, { key: 'cashIn', label: 'Cash receipts', type: 'money', total: true }, { key: 'cashOut', label: 'Cash refunds', type: 'money', total: true }, { key: 'drops', label: 'Safe drops', type: 'money', total: true }, { key: 'expected', label: 'Expected closing cash', type: 'money', total: true }, { key: 'counted', label: 'Counted cash', type: 'money', total: true }, { key: 'variance', label: 'Variance', type: 'money', total: true },
        { key: 'card', label: 'Cards', type: 'money', total: true }, { key: 'bank', label: 'Bank transfers', type: 'money', total: true }, { key: 'wallet', label: 'Wallets', type: 'money', total: true, hidden: true }, { key: 'voids', label: 'Voids / rejected', type: 'int', total: true }, { key: 'note', label: 'Variance explanation', hidden: true }, { key: 'reviewer', label: 'Reviewed by', hidden: true }],
      rows, notes: ['Paid-outs, online-gateway and OTA virtual-card settlements, and bank-batch references are not recorded by the system yet.'] };
  },
};

export const outstanding: Def = {
  id: 'outstanding', name: 'Due and outstanding', category: 'finance', kind: 'financial', permissions: ['report.view', 'folio.view'], roles: ['accounts', 'manager', 'frontdesk'],
  purpose: 'Open bills with money still owing: guests in the house, guests who have left, and company bills. Aged from the departure date.',
  basis: [{ id: 'asof', label: 'As of the business date' }], range: 'none',
  params: [{ key: 'view', label: 'Show', default: 'all', options: [{ value: 'all', label: 'All open balances' }, { value: 'inhouse', label: 'In-house guests' }, { value: 'departed', label: 'Departed guests' }, { value: 'company', label: 'Company bills' }] }],
  definitions: [{ term: 'Balance', text: 'Charges and taxes minus payments on an open bill. A card pre-authorisation is not a payment.' }, { term: 'Aging', text: 'Days since departure (guests) or since the bill was opened (company bills), as of the business date.' }, { term: 'Credit', text: 'A negative balance: the guest has paid more than owed.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT f.id AS fid, f.folio_no, f.folio_type, f.balance_minor::text AS bal, f.currency, r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, co.name AS company, r.deposit_paid_minor::text AS dep, r.guarantee_type AS guar,
        min(l.arrival)::text AS arrival, max(l.departure)::text AS departure, bool_or(l.status = 'CHECKED_IN') AS inhouse, f.created_at::date::text AS opened
      FROM folio f LEFT JOIN reservation r ON r.tenant_id = f.tenant_id AND r.id = f.reservation_id LEFT JOIN reservation_room l ON l.tenant_id = r.tenant_id AND l.reservation_id = r.id LEFT JOIN guest g ON g.tenant_id = f.tenant_id AND g.id = coalesce(f.guest_id, r.guest_id) LEFT JOIN company co ON co.tenant_id = f.tenant_id AND co.id = coalesce(f.company_id, r.company_id)
      WHERE f.tenant_id = ${c.tenantId} AND f.property_id = ${c.propertyId} AND f.status = 'OPEN' AND f.balance_minor <> 0 AND f.folio_type IN ('GUEST','COMPANY','MASTER') GROUP BY f.id, f.folio_no, f.folio_type, f.balance_minor, f.currency, f.created_at, r.id, r.confirmation_no, r.deposit_paid_minor, r.guarantee_type, g.full_name, co.name ORDER BY f.balance_minor DESC`.execute(c.trx);
    const days = (a: string | null) => (a ? Math.max(0, Math.round((Date.parse(`${c.prop.businessDate}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)) : 0);
    let rows: Row[] = r.rows.map((x) => { const company = x.folio_type !== 'GUEST'; const state = company ? 'Company bill' : x.inhouse ? 'In house' : 'Departed'; const age = state === 'In house' ? 0 : days(company ? x.opened : x.departure);
      return { _res: x.rid, bill: x.folio_no, conf: x.conf ?? '', who: x.company ?? x.guest ?? '', guest: x.guest ?? '', state, arrival: x.arrival ?? '', departure: x.departure ?? '', balance: x.bal, deposit: x.dep, age, bucket: BigInt(x.bal) < 0n ? 'Credit' : state === 'In house' ? 'In house' : age <= 0 ? 'Current' : age <= 30 ? '1–30 days' : age <= 60 ? '31–60 days' : age <= 90 ? '61–90 days' : 'Over 90 days', guarantee: x.guar }; });
    const v = c.params.view; if (v === 'inhouse') rows = rows.filter((x) => x.state === 'In house'); else if (v === 'departed') rows = rows.filter((x) => x.state === 'Departed'); else if (v === 'company') rows = rows.filter((x) => x.state === 'Company bill');
    const owing = rows.filter((x) => BigInt(x.balance as string) > 0n); const sumBy = (f: (x: Row) => boolean) => owing.filter(f).reduce((s, x) => s + BigInt(x.balance as string), 0n);
    return { kpis: [{ key: 'total', label: 'Total owing', value: dec(sumBy(() => true)), type: 'money', definition: 'Open balances above zero in the view.' }, { key: 'inh', label: 'In-house guests', value: dec(sumBy((x) => x.state === 'In house')), type: 'money', definition: 'Owing by guests still staying.' },
        { key: 'dep', label: 'Departed guests', value: dec(sumBy((x) => x.state === 'Departed')), type: 'money', tone: sumBy((x) => x.state === 'Departed') > 0n ? 'warn' : 'ok', definition: 'Owing by guests who have checked out.' }, { key: 'co', label: 'Company bills', value: dec(sumBy((x) => x.state === 'Company bill')), type: 'money', definition: 'Open company and master bills.' }],
      columns: [{ key: 'bill', label: 'Bill' }, { key: 'conf', label: 'Booking' }, { key: 'who', label: 'Guest or company' }, { key: 'state', label: 'Status', type: 'badge' }, { key: 'arrival', label: 'Arrival', type: 'date', hidden: true }, { key: 'departure', label: 'Departure', type: 'date' }, { key: 'balance', label: 'Balance', type: 'money', total: true }, { key: 'deposit', label: 'Deposit paid', type: 'money', total: true, hidden: true }, { key: 'age', label: 'Days', type: 'int' }, { key: 'bucket', label: 'Aging', type: 'badge' }],
      rows, notes: ['Disputed, promised-to-pay and written-off status, credit limits, collection owners and contact notes are not tracked yet. Company receivables with due dates are in the Receivables ageing download.'] };
  },
};

export const discounts: Def = {
  id: 'discounts', name: 'Discounts and complimentary', category: 'finance', kind: 'audit', permissions: ['report.view'], roles: ['manager', 'accounts'],
  purpose: 'Where revenue was given up: discounts on bookings and on bills, and stays that are fully complimentary.',
  basis: [{ id: 'arrival', label: 'Arrival date' }, { id: 'created', label: 'Booking-created date' }], range: 'month',
  definitions: [{ term: 'Reference value', text: 'Room charges before any discount, excluding tax.' }, { term: 'Complimentary', text: 'A room line charged at zero. Partial discounts are not complimentary.' }, { term: 'Folio discount', text: 'A discount posted on a bill after the booking was made.' }],
  async run(c) {
    const col = c.basis === 'created' ? sql.raw(`(r.created_at AT TIME ZONE '${c.prop.timezone.replace(/[^A-Za-z_\/+-]/g, '')}')::date`) : sql.raw('l.arrival');
    const a = await sql<Record<string, any>>`SELECT r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, l.arrival::text AS arrival, l.departure::text AS departure, l.subtotal_minor::text AS ref, l.discount_minor::text AS disc, l.total_minor::text AS charged, l.discount_pct::text AS pct, rp.name AS plan, r.source
      FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id JOIN rate_plan rp ON rp.id = l.rate_plan_id
      WHERE l.tenant_id = ${c.tenantId} AND l.property_id = ${c.propertyId} AND l.status NOT IN ('CANCELLED','NO_SHOW') AND (l.discount_minor > 0 OR (l.total_minor = 0 AND l.subtotal_minor > 0)) AND ${col} BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY l.arrival DESC`.execute(c.trx);
    const b = await sql<Record<string, any>>`SELECT r.id AS rid, r.confirmation_no AS conf, g.full_name AS guest, p.business_date::text AS bd, p.amount_minor::text AS amt, p.description, p.reason_code, u.full_name AS by, f.folio_no
      FROM folio_posting p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id LEFT JOIN reservation r ON r.tenant_id = f.tenant_id AND r.id = f.reservation_id LEFT JOIN guest g ON g.tenant_id = f.tenant_id AND g.id = coalesce(f.guest_id, r.guest_id) LEFT JOIN staff_user u ON u.id = p.created_by
      WHERE p.tenant_id = ${c.tenantId} AND p.property_id = ${c.propertyId} AND p.posting_type = 'DISCOUNT' AND p.business_date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY p.business_date DESC`.execute(c.trx);
    const rows: Row[] = [
      ...a.rows.map((x): Row => { const comp = BigInt(x.charged) === 0n; return { _res: x.rid, kind: comp ? 'Complimentary' : 'Booking discount', conf: x.conf, guest: x.guest, when: x.arrival, stay: `${x.arrival} → ${x.departure}`, ref: x.ref, discount: x.disc, pct: Number(x.ref) > 0 ? Math.round((Number(x.disc) / Number(x.ref)) * 1000) / 10 : 0, charged: x.charged, plan: x.plan, source: x.source, reason: '', by: '' }; }),
      ...b.rows.map((x): Row => ({ _res: x.rid, kind: 'Folio discount', conf: x.conf ?? x.folio_no, guest: x.guest ?? '', when: x.bd, stay: '', ref: '0', discount: (-BigInt(x.amt)).toString(), pct: 0, charged: '0', plan: '', source: '', reason: x.description ?? x.reason_code ?? '', by: x.by ?? '' })),
    ];
    const sum = (k: string, f: (x: Row) => boolean = () => true) => rows.filter(f).reduce((s, x) => s + BigInt(x[k] as string), 0n);
    return { kpis: [{ key: 'n', label: 'Records', value: rows.length, type: 'int', definition: 'Discount and complimentary records in the period.' }, { key: 'disc', label: 'Discounts given', value: dec(sum('discount', (x) => x.kind !== 'Complimentary')), type: 'money', definition: 'Booking and bill discounts, excluding tax.' },
        { key: 'comp', label: 'Complimentary value', value: dec(sum('discount', (x) => x.kind === 'Complimentary')), type: 'money', definition: 'Reference value of lines charged at zero.' }],
      columns: [{ key: 'when', label: 'Date', type: 'date' }, { key: 'kind', label: 'Type', type: 'badge' }, { key: 'conf', label: 'Booking or bill' }, { key: 'guest', label: 'Guest' }, { key: 'stay', label: 'Stay' }, { key: 'ref', label: 'Reference value', type: 'money', total: true }, { key: 'discount', label: 'Discount', type: 'money', total: true }, { key: 'pct', label: '%', type: 'pct' }, { key: 'charged', label: 'Charged', type: 'money', total: true }, { key: 'plan', label: 'Rate plan', hidden: true }, { key: 'source', label: 'Source', hidden: true }, { key: 'reason', label: 'Reason' }, { key: 'by', label: 'Given by' }],
      rows, notes: ['Discount reasons, requested/granted/approved-by, and category (promotional, negotiated, loyalty, house use) are not captured on bookings yet.'] };
  },
};
