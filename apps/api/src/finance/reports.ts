import { Body, Controller, Get, HttpException, Inject, Injectable, Put, Query } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { DB } from '@hos/db';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { FinanceService } from './finance.js';

type Trx = Transaction<DB>;
const ANY = { anyScope: true } as const;
const err = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-20');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-11');
const uuid = z.string().uuid();
const Range = z.object({ from: date, to: date, branchId: uuid.optional() });
const AsAt = z.object({ to: date, branchId: uuid.optional() });
const Expenses = z.object({ from: date, to: date, branchId: uuid.optional(), account: z.string().regex(/^[0-9]{4,8}$/).optional() });
const Daily = z.object({ date, branchId: uuid.optional() });
const BankBook = z.object({ bankId: uuid, from: date, to: date });
const Register = z.object({ from: date, to: date, type: z.enum(['JV', 'CRV', 'BRV', 'CPV', 'BPV', 'CTV', 'IBEV', 'IBTV', 'PMS']).optional(), status: z.enum(['DRAFT', 'SUBMITTED', 'POSTED', 'REJECTED', 'CANCELLED']).optional(), branchId: uuid.optional() });
const BudgetVs = z.object({ from: month, to: month, branchId: uuid.optional() });
const BudgetSet = z.object({ branchId: uuid.nullable(), account: z.string().regex(/^[0-9]{4,8}$/), month, amount: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 150000') }).strict();
const Dash = z.object({ period: z.enum(['day', 'week', 'month', 'year']).default('month'), date: date.optional() });

export interface TRow { cells: string[]; kind?: 'head' | 'total' | 'sub' | 'row' }
export interface Table { title: string; currency: string; from?: string; to?: string; columns: string[]; numeric: boolean[]; rows: TRow[]; notes: string[]; ok: boolean }
const HO = 'HO';
const CASHISH = ['CASH', 'PETTY_CASH', 'BANK'];

/** The statements a finance manager or owner reads: profit and loss, balance sheet, cash flow and the day-to-day registers, by branch or for the whole company. All of them read the posted ledger only. */
@Injectable()
export class FinanceReportsService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(FinanceService) private readonly fin: FinanceService) {}

  private async cur(trx: Trx) { return (await this.fin.settings(trx)).base_currency; }
  private f(v: bigint, cur: string) { return Money.ofMinor(v, cur).toDecimalString(); }
  private async names(trx: Trx) { return new Map((await trx.selectFrom('property').select(['id', 'name']).execute()).map((p) => [p.id, p.name])); }
  private brSql(branchId?: string) { return branchId ? sql`AND e.property_id = ${branchId}` : sql``; }

  /** Columns for a branch comparison: the chosen branch, or every branch with entries (and head office if it has any). */
  private async branchKeys(trx: Trx, ids: Array<string | null>, branchId?: string): Promise<Array<{ key: string; name: string }>> {
    const n = await this.names(trx);
    if (branchId) return [{ key: branchId, name: n.get(branchId) ?? branchId }];
    const keys = [...new Set(ids.map((x) => x ?? HO))].sort((a, b) => (a === HO ? 1 : b === HO ? -1 : (n.get(a) ?? a).localeCompare(n.get(b) ?? b)));
    return keys.map((k) => ({ key: k, name: k === HO ? 'Head office' : n.get(k) ?? k }));
  }

  async profitLoss(q: z.infer<typeof Range>): Promise<Table> {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx);
      const r = await sql<{ code: string; name: string; type: string; pid: string | null; d: string; c: string }>`SELECT a.code, a.name, a.account_type AS type, e.property_id AS pid, sum(e.debit_minor)::text AS d, sum(e.credit_minor)::text AS c
        FROM gl_entry e JOIN gl_account a ON a.tenant_id = e.tenant_id AND a.id = e.account_id WHERE a.account_type IN ('REVENUE','EXPENSE') AND e.posting_date BETWEEN ${q.from}::date AND ${q.to}::date ${this.brSql(q.branchId)} GROUP BY 1, 2, 3, 4 ORDER BY 1`.execute(trx);
      const cols = await this.branchKeys(trx, r.rows.map((x) => x.pid), q.branchId);
      const val = (x: { type: string; d: string; c: string }) => (x.type === 'REVENUE' ? BigInt(x.c) - BigInt(x.d) : BigInt(x.d) - BigInt(x.c));
      const sec = (type: string, title: string, totalLabel: string): { rows: TRow[]; tot: Map<string, bigint> } => {
        const accts = [...new Set(r.rows.filter((x) => x.type === type).map((x) => `${x.code}|${x.name}`))]; const tot = new Map<string, bigint>(); const rows: TRow[] = [{ cells: [title, ...cols.map(() => ''), ''], kind: 'head' }];
        for (const a of accts) { const [code, name] = a.split('|') as [string, string]; let sum = 0n; const cells = cols.map((c) => { const v = r.rows.filter((x) => x.code === code && (x.pid ?? HO) === c.key).reduce((s, x) => s + val(x), 0n); sum += v; tot.set(c.key, (tot.get(c.key) ?? 0n) + v); return this.f(v, cur); }); rows.push({ cells: [`${code} ${name}`, ...cells, this.f(sum, cur)], kind: 'row' }); }
        const all = [...tot.values()].reduce((s, v) => s + v, 0n); rows.push({ cells: [totalLabel, ...cols.map((c) => this.f(tot.get(c.key) ?? 0n, cur)), this.f(all, cur)], kind: 'total' }); tot.set('ALL', all); return { rows, tot };
      };
      const rev = sec('REVENUE', 'Revenue', 'Total revenue'), exp = sec('EXPENSE', 'Expenses', 'Total expenses');
      const net = [...cols.map((c) => (rev.tot.get(c.key) ?? 0n) - (exp.tot.get(c.key) ?? 0n)), (rev.tot.get('ALL') ?? 0n) - (exp.tot.get('ALL') ?? 0n)];
      return { title: 'Profit and loss', currency: cur, from: q.from, to: q.to, columns: ['', ...cols.map((c) => c.name), 'Total'], numeric: [false, ...cols.map(() => true), true], rows: [...rev.rows, ...exp.rows, { cells: ['Net result', ...net.map((v) => this.f(v, cur))], kind: 'total' }],
        notes: ['Posted entries only, by posting date. Entries held at head office (for example unallocated receipts) show in their own column.'], ok: true };
    });
  }

  async balanceSheet(q: z.infer<typeof AsAt>): Promise<Table> {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx);
      const r = await sql<{ code: string; name: string; type: string; ctl: string | null; pid: string | null; d: string; c: string }>`SELECT a.code, a.name, a.account_type AS type, a.control_type AS ctl, e.property_id AS pid, sum(e.debit_minor)::text AS d, sum(e.credit_minor)::text AS c
        FROM gl_entry e JOIN gl_account a ON a.tenant_id = e.tenant_id AND a.id = e.account_id WHERE e.posting_date <= ${q.to}::date ${this.brSql(q.branchId)} GROUP BY 1, 2, 3, 4, 5 ORDER BY 1`.execute(trx);
      const cols = await this.branchKeys(trx, r.rows.map((x) => x.pid), q.branchId); const notes: string[] = ['Posted entries up to the date. The result of the year so far is shown in equity until the year is closed.'];
      const net = (x: { d: string; c: string }) => BigInt(x.d) - BigInt(x.c);
      const inter = r.rows.filter((x) => x.ctl === 'INTERBRANCH').reduce((s, x) => s + net(x), 0n); const eliminate = !q.branchId && inter === 0n && r.rows.some((x) => x.ctl === 'INTERBRANCH');
      if (eliminate) notes.push('Due From and Due To between branches cancel out in the Total column (shown per branch, left out of the company total).'); if (!q.branchId && inter !== 0n) notes.push(`Inter-branch balances differ by ${this.f(inter < 0n ? -inter : inter, cur)}; they are left in the total so it stays honest. See Finance → Inter-branch.`);
      const section = (types: string[], title: string, sign: 1n | -1n, totalLabel: string) => {
        const accts = [...new Set(r.rows.filter((x) => types.includes(x.type)).map((x) => `${x.code}|${x.name}|${x.ctl ?? ''}`))]; const tot = new Map<string, bigint>(); const rows: TRow[] = [{ cells: [title, ...cols.map(() => ''), ''], kind: 'head' }];
        for (const a of accts) {
          const [code, name, ctl] = a.split('|') as [string, string, string]; let sum = 0n; const isInter = ctl === 'INTERBRANCH';
          const cells = cols.map((c) => { const v = r.rows.filter((x) => x.code === code && (x.pid ?? HO) === c.key).reduce((s, x) => s + sign * net(x), 0n); sum += v; tot.set(c.key, (tot.get(c.key) ?? 0n) + v); return this.f(v, cur); });
          if (isInter && eliminate) { rows.push({ cells: [`${code} ${name}`, ...cells, 'eliminated'], kind: 'row' }); continue; }
          if (sum === 0n && cells.every((x) => x === '0.00')) continue; tot.set('ALL', (tot.get('ALL') ?? 0n) + sum); rows.push({ cells: [`${code} ${name}`, ...cells, this.f(sum, cur)], kind: 'row' });
        }
        const keys = cols.map((c) => c.key); const all = tot.get('ALL') ?? 0n; rows.push({ cells: [totalLabel, ...keys.map((k) => this.f(tot.get(k) ?? 0n, cur)), this.f(all, cur)], kind: 'total' }); return { rows, all, perBranch: keys.map((k) => tot.get(k) ?? 0n) };
      };
      const assets = section(['ASSET'], 'Assets', 1n, 'Total assets'), liab = section(['LIABILITY'], 'Liabilities', -1n, 'Total liabilities'), eq = section(['EQUITY'], 'Equity', -1n, 'Total equity before the result');
      const pl = r.rows.filter((x) => x.type === 'REVENUE' || x.type === 'EXPENSE'); const resBy = cols.map((c) => pl.filter((x) => (x.pid ?? HO) === c.key).reduce((s, x) => s - net(x), 0n)); const resAll = resBy.reduce((s, v) => s + v, 0n);
      const le = cols.map((_, i) => liab.perBranch[i]! + eq.perBranch[i]! + resBy[i]!); const leAll = liab.all + eq.all + resAll;
      const ok = assets.all === leAll;
      if (!ok && !q.branchId) notes.push('The balance sheet does not balance. Tell support.');
      if (q.branchId || cols.length > 1) notes.push('A single branch can show a difference where money is held at head office (unallocated receipts); the company total always balances.');
      return { title: 'Balance sheet', currency: cur, to: q.to, columns: ['', ...cols.map((c) => c.name), 'Total'], numeric: [false, ...cols.map(() => true), true], notes, ok,
        rows: [...assets.rows, ...liab.rows, ...eq.rows, { cells: ['Result of the year so far', ...resBy.map((v) => this.f(v, cur)), this.f(resAll, cur)], kind: 'row' }, { cells: ['Total liabilities and equity', ...le.map((v) => this.f(v, cur)), this.f(leAll, cur)], kind: 'total' }] };
    });
  }

  async cashFlow(q: z.infer<typeof Range>): Promise<Table> {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx);
      const bal = async (on: string) => BigInt((await sql<{ s: string }>`SELECT coalesce(sum(e.debit_minor - e.credit_minor),0)::text AS s FROM gl_entry e JOIN gl_account a ON a.tenant_id = e.tenant_id AND a.id = e.account_id WHERE a.control_type = ANY(${CASHISH}) AND e.posting_date ${sql.raw(on)} ${this.brSql(q.branchId)}`.execute(trx)).rows[0]!.s);
      const opening = await bal(`< '${q.from}'::date`), closing = await bal(`<= '${q.to}'::date`);
      const r = await sql<{ code: string; name: string; type: string; ctl: string | null; amt: string }>`SELECT a.code, a.name, a.account_type AS type, a.control_type AS ctl, sum(e.credit_minor - e.debit_minor)::text AS amt
        FROM gl_entry e JOIN gl_account a ON a.tenant_id = e.tenant_id AND a.id = e.account_id
        WHERE e.posting_date BETWEEN ${q.from}::date AND ${q.to}::date ${this.brSql(q.branchId)} AND NOT (coalesce(a.control_type, '') = ANY(${CASHISH}))
          AND e.voucher_id IN (SELECT e2.voucher_id FROM gl_entry e2 JOIN gl_account a2 ON a2.tenant_id = e2.tenant_id AND a2.id = e2.account_id WHERE a2.control_type = ANY(${CASHISH}) AND e2.posting_date BETWEEN ${q.from}::date AND ${q.to}::date ${sql`AND (${q.branchId ?? null}::uuid IS NULL OR e2.property_id = ${q.branchId ?? null}::uuid)`})
        GROUP BY 1, 2, 3, 4 ORDER BY 1`.execute(trx);
      const cat = (x: { code: string; type: string; ctl: string | null }) => (x.ctl === 'INTERBRANCH' ? 'Financing' : x.type === 'EQUITY' ? 'Financing' : x.type === 'ASSET' && /^15/.test(x.code) ? 'Investing' : 'Operating');
      const label: Record<string, string> = { Operating: 'Operating activities', Investing: 'Investing activities (equipment and fixtures)', Financing: 'Financing (owner funds and inter-branch funding)' };
      const rows: TRow[] = [{ cells: ['Cash and bank at the start', this.f(opening, cur)], kind: 'head' }]; let net = 0n;
      for (const c of ['Operating', 'Investing', 'Financing']) {
        const items = r.rows.filter((x) => cat(x) === c && BigInt(x.amt) !== 0n); let t = 0n; rows.push({ cells: [label[c]!, ''], kind: 'head' });
        for (const x of items) { t += BigInt(x.amt); rows.push({ cells: [`${x.code} ${x.name}`, this.f(BigInt(x.amt), cur)], kind: 'row' }); }
        rows.push({ cells: [`Net cash from ${c.toLowerCase()}`, this.f(t, cur)], kind: 'total' }); net += t;
      }
      const ho = q.branchId ? closing - opening - net : 0n;     // the other side of some of a branch's cash was recorded at head office
      if (ho !== 0n) { rows.push({ cells: ['Recorded through head office (not tagged to a branch)', this.f(ho, cur)], kind: 'row' }); net += ho; }
      rows.push({ cells: ['Net change in cash and bank', this.f(net, cur)], kind: 'total' }, { cells: ['Cash and bank at the end', this.f(closing, cur)], kind: 'head' });
      const ok = opening + net === closing;
      return { title: 'Cash flow', currency: cur, from: q.from, to: q.to, columns: ['', cur], numeric: [false, true], rows, ok, notes: ['Cash and bank means cash, petty cash and bank accounts. Each movement is placed by what the other side of the entry was; moves between cash and bank are not shown.', ...(ok ? [] : ['The cash flow does not add up to the change in cash. Tell support.'])] };
    });
  }

  async dailyCash(q: z.infer<typeof Daily>): Promise<Table> {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx);
      let d = trx.selectFrom('cash_drawer as d').innerJoin('property as p', (j) => j.onRef('p.id', '=', 'd.property_id').onRef('p.tenant_id', '=', 'd.tenant_id')).select(['d.id', 'd.property_id', 'd.kind', 'd.name', 'p.name as branch']).where('d.status', '=', 'ACTIVE').orderBy('p.name').orderBy('d.kind');
      if (q.branchId) d = d.where('d.property_id', '=', q.branchId);
      const rows: TRow[] = [];
      for (const x of await d.execute()) {
        const acct = await trx.selectFrom('gl_account').select('id').where('control_type', '=', x.kind === 'PETTY' ? 'PETTY_CASH' : 'CASH').where('is_group', '=', false).executeTakeFirst(); if (!acct) continue;
        const r = await sql<{ o: string; i: string; p: string; c: string }>`SELECT coalesce(sum(debit_minor - credit_minor) FILTER (WHERE posting_date < ${q.date}::date),0)::text AS o, coalesce(sum(debit_minor) FILTER (WHERE posting_date = ${q.date}::date),0)::text AS i, coalesce(sum(credit_minor) FILTER (WHERE posting_date = ${q.date}::date),0)::text AS p, coalesce(sum(debit_minor - credit_minor),0)::text AS c FROM gl_entry WHERE account_id = ${acct.id} AND property_id = ${x.property_id} AND posting_date <= ${q.date}::date`.execute(trx);
        const cl = await trx.selectFrom('cash_closing').select(['counted_minor', 'variance_minor', 'status']).where('drawer_id', '=', x.id).where('business_date', '=', q.date).executeTakeFirst();
        rows.push({ cells: [`${x.branch} · ${x.name}`, this.f(BigInt(r.rows[0]!.o), cur), this.f(BigInt(r.rows[0]!.i), cur), this.f(BigInt(r.rows[0]!.p), cur), this.f(BigInt(r.rows[0]!.c), cur), cl ? this.f(BigInt(cl.counted_minor), cur) : '—', cl ? this.f(BigInt(cl.variance_minor), cur) : '—', cl ? cl.status.replace('_', ' ').toLowerCase() : 'not closed'], kind: 'row' });
      }
      return { title: 'Daily cash', currency: cur, to: q.date, columns: ['Drawer', 'Opening', 'Received', 'Paid out', 'Expected close', 'Counted', 'Difference', 'Status'], numeric: [false, true, true, true, true, true, true, false], rows, ok: true, notes: ['Expected close is what the books say the drawer should hold at the end of the day.'] };
    });
  }

  async bankBook(q: z.infer<typeof BankBook>): Promise<Table> {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx);
      const b = await trx.selectFrom('payment_account').select(['name', 'gl_account_id']).where('id', '=', q.bankId).where('kind', '=', 'BANK').executeTakeFirst(); if (!b) throw err(404, 'NOT_FOUND', 'No such bank account'); if (!b.gl_account_id) throw err(409, 'BANK_NO_LEDGER', 'This bank account has no ledger account yet');
      const o = await sql<{ s: string }>`SELECT coalesce(sum(debit_minor - credit_minor),0)::text AS s FROM gl_entry WHERE account_id = ${b.gl_account_id} AND posting_date < ${q.from}::date`.execute(trx);
      const e = await sql<{ date: string; no: string; narration: string; d: string; c: string; m: boolean }>`SELECT e.posting_date::text AS date, v.voucher_no AS no, v.narration, e.debit_minor::text AS d, e.credit_minor::text AS c, EXISTS (SELECT 1 FROM bank_match m WHERE m.gl_entry_id = e.id) AS m
        FROM gl_entry e JOIN voucher v ON v.tenant_id = e.tenant_id AND v.id = e.voucher_id WHERE e.account_id = ${b.gl_account_id} AND e.posting_date BETWEEN ${q.from}::date AND ${q.to}::date ORDER BY e.posting_date, v.voucher_no, e.id`.execute(trx);
      let run = BigInt(o.rows[0]!.s); const opening = run; let un = 0;
      const rows: TRow[] = [{ cells: ['', '', 'Opening balance', '', '', this.f(opening, cur), ''], kind: 'head' }, ...e.rows.map((x): TRow => { run += BigInt(x.d) - BigInt(x.c); if (!x.m) un++; return { cells: [x.date, x.no, x.narration, BigInt(x.d) ? this.f(BigInt(x.d), cur) : '', BigInt(x.c) ? this.f(BigInt(x.c), cur) : '', this.f(run, cur), x.m ? 'matched' : 'not on a statement'], kind: 'row' }; }), { cells: ['', '', 'Closing balance', '', '', this.f(run, cur), ''], kind: 'total' }];
      return { title: `Bank book: ${b.name}`, currency: cur, from: q.from, to: q.to, columns: ['Date', 'Voucher', 'Narration', 'Received', 'Paid', 'Balance', 'Bank statement'], numeric: [false, false, false, true, true, true, false], rows, ok: true, notes: [`${un} of ${e.rows.length} entries are not yet matched to a bank statement line.`] };
    });
  }

  async expenses(q: z.infer<typeof Expenses>): Promise<Table> {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx);
      const r = await sql<{ date: string; no: string; branch: string | null; code: string; name: string; narration: string; ref: string | null; amt: string }>`SELECT e.posting_date::text AS date, v.voucher_no AS no, p.name AS branch, a.code, a.name, v.narration, l.reference AS ref, (e.debit_minor - e.credit_minor)::text AS amt
        FROM gl_entry e JOIN gl_account a ON a.tenant_id = e.tenant_id AND a.id = e.account_id JOIN voucher v ON v.tenant_id = e.tenant_id AND v.id = e.voucher_id JOIN voucher_line l ON l.tenant_id = e.tenant_id AND l.id = e.line_id LEFT JOIN property p ON p.tenant_id = e.tenant_id AND p.id = e.property_id
        WHERE a.account_type = 'EXPENSE' AND e.posting_date BETWEEN ${q.from}::date AND ${q.to}::date ${this.brSql(q.branchId)} ${q.account ? sql`AND a.code = ${q.account}` : sql``} ORDER BY a.code, e.posting_date, v.voucher_no`.execute(trx);
      const rows: TRow[] = []; let cur2 = ''; let sub = 0n; let all = 0n;
      const flush = () => { if (cur2) rows.push({ cells: ['', '', '', '', `Total ${cur2}`, '', this.f(sub, cur)], kind: 'total' }); };
      for (const x of r.rows) { const h = `${x.code} ${x.name}`; if (h !== cur2) { flush(); cur2 = h; sub = 0n; rows.push({ cells: [h, '', '', '', '', '', ''], kind: 'head' }); } sub += BigInt(x.amt); all += BigInt(x.amt); rows.push({ cells: ['', x.date, x.no, x.branch ?? 'Head office', x.narration, x.ref ?? '', this.f(BigInt(x.amt), cur)], kind: 'row' }); }
      flush(); rows.push({ cells: ['', '', '', '', 'All expenses', '', this.f(all, cur)], kind: 'total' });
      return { title: 'Expenses', currency: cur, from: q.from, to: q.to, columns: ['Expense', 'Date', 'Voucher', 'Branch', 'What for', 'Vendor / invoice', 'Amount'], numeric: [false, false, false, false, false, false, true], rows, ok: true, notes: [] };
    });
  }

  async register(q: z.infer<typeof Register>): Promise<Table> {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx);
      const r = await sql<{ no: string | null; type: string; date: string; status: string; narration: string; total: string; maker: string | null; checker: string | null; branches: string | null }>`SELECT v.voucher_no AS no, v.voucher_type AS type, v.posting_date::text AS date, v.status, v.narration, v.total_minor::text AS total, u.full_name AS maker, ap.full_name AS checker,
        (SELECT string_agg(DISTINCT coalesce(p.name, 'Head office'), ', ') FROM voucher_line l LEFT JOIN property p ON p.tenant_id = l.tenant_id AND p.id = l.property_id WHERE l.voucher_id = v.id) AS branches
        FROM voucher v LEFT JOIN staff_user u ON u.tenant_id = v.tenant_id AND u.id = v.created_by LEFT JOIN staff_user ap ON ap.tenant_id = v.tenant_id AND ap.id = v.approved_by
        WHERE v.posting_date BETWEEN ${q.from}::date AND ${q.to}::date ${q.type ? sql`AND v.voucher_type = ${q.type}` : sql``} ${q.status ? sql`AND v.status = ${q.status}` : sql``} ${q.branchId ? sql`AND EXISTS (SELECT 1 FROM voucher_line l WHERE l.voucher_id = v.id AND l.property_id = ${q.branchId})` : sql``} ORDER BY v.posting_date, v.voucher_no NULLS LAST LIMIT 1000`.execute(trx);
      const rows = r.rows.map((x): TRow => ({ cells: [x.no ?? 'draft', x.type, x.date, x.branches ?? '', x.narration, this.f(BigInt(x.total), cur), x.status.toLowerCase(), x.maker ?? '', x.checker ?? ''], kind: 'row' }));
      return { title: 'Voucher register', currency: cur, from: q.from, to: q.to, columns: ['Voucher', 'Type', 'Date', 'Branches', 'What for', 'Amount', 'Status', 'Prepared by', 'Approved by'], numeric: [false, false, false, false, false, true, false, false, false], rows, ok: true, notes: r.rows.length >= 1000 ? ['Only the first 1,000 are shown. Narrow the dates.'] : [] };
    });
  }

  // ---- budgets
  async setBudget(userId: string, i: z.infer<typeof BudgetSet>) {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx); const a = await trx.selectFrom('gl_account').select(['id', 'is_group']).where('code', '=', i.account).executeTakeFirst(); if (!a || a.is_group) throw err(400, 'ACCOUNT_UNKNOWN', `Account ${i.account} is not a postable account`);
      if (i.branchId && !(await trx.selectFrom('property').select('id').where('id', '=', i.branchId).executeTakeFirst())) throw err(400, 'BRANCH_UNKNOWN', 'That branch does not exist');
      const amt = Money.parse(i.amount, cur).minor.toString();
      await sql`INSERT INTO gl_budget (tenant_id, property_id, account_id, month, amount_minor, updated_by) VALUES (${currentTenant().tenantId}, ${i.branchId}, ${a.id}, ${`${i.month}-01`}::date, ${amt}, ${userId})
        ON CONFLICT (tenant_id, coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid), account_id, month) DO UPDATE SET amount_minor = EXCLUDED.amount_minor, updated_by = EXCLUDED.updated_by, updated_at = now()`.execute(trx);
      await this.audit.record(trx, { action: 'finance.budget.set', resourceType: 'gl_budget', resourceId: `${i.account}:${i.month}`, after: { branch: i.branchId, amount: i.amount } });
      return { saved: true };
    });
  }
  async budgetVsActual(q: z.infer<typeof BudgetVs>): Promise<Table> {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx); const from = `${q.from}-01`; const last = new Date(Date.UTC(Number(q.to.slice(0, 4)), Number(q.to.slice(5, 7)), 0)).toISOString().slice(0, 10);
      const b = await sql<{ code: string; name: string; type: string; amt: string }>`SELECT a.code, a.name, a.account_type AS type, sum(g.amount_minor)::text AS amt FROM gl_budget g JOIN gl_account a ON a.tenant_id = g.tenant_id AND a.id = g.account_id WHERE g.month BETWEEN ${from}::date AND ${`${q.to}-01`}::date ${q.branchId ? sql`AND g.property_id = ${q.branchId}` : sql``} GROUP BY 1, 2, 3`.execute(trx);
      const a = await sql<{ code: string; name: string; type: string; amt: string }>`SELECT a.code, a.name, a.account_type AS type, sum(CASE WHEN a.account_type = 'REVENUE' THEN e.credit_minor - e.debit_minor ELSE e.debit_minor - e.credit_minor END)::text AS amt
        FROM gl_entry e JOIN gl_account a ON a.tenant_id = e.tenant_id AND a.id = e.account_id WHERE a.account_type IN ('REVENUE','EXPENSE') AND e.posting_date BETWEEN ${from}::date AND ${last}::date ${this.brSql(q.branchId)} GROUP BY 1, 2, 3`.execute(trx);
      const keys = [...new Set([...b.rows, ...a.rows].map((x) => `${x.type}|${x.code}|${x.name}`))].sort((x, y) => (x.split('|')[0] === y.split('|')[0] ? x.split('|')[1]!.localeCompare(y.split('|')[1]!) : x.split('|')[0]! < y.split('|')[0]! ? 1 : -1));
      const rows: TRow[] = keys.map((k): TRow => { const [type, code, name] = k.split('|') as [string, string, string]; const bu = BigInt(b.rows.find((x) => x.code === code)?.amt ?? 0), ac = BigInt(a.rows.find((x) => x.code === code)?.amt ?? 0); const v = ac - bu;
        return { cells: [`${code} ${name}`, type === 'REVENUE' ? 'Revenue' : 'Expense', this.f(bu, cur), this.f(ac, cur), this.f(v, cur), bu > 0n ? `${Math.round(Number((v * 1000n) / bu)) / 10}%` : '—'], kind: 'row' }; });
      return { title: 'Budget against actual', currency: cur, from, to: last, columns: ['Account', 'Kind', 'Budget', 'Actual', 'Actual − budget', '%'], numeric: [false, false, true, true, true, true], rows, ok: true, notes: ['For an expense a positive difference is overspending; for revenue it is more than planned.'] };
    });
  }

  // ---- the owner's dashboard
  async dashboard(q: z.infer<typeof Dash>) {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx); const f = (v: bigint) => this.f(v, cur);
      const today = q.date ?? (await trx.selectFrom('property').select('business_date').orderBy('business_date', 'desc').limit(1).executeTakeFirst())?.business_date ?? new Date().toISOString().slice(0, 10);
      const d = new Date(`${today}T00:00:00Z`); const from = q.period === 'day' ? today : q.period === 'week' ? new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10) : q.period === 'month' ? `${today.slice(0, 8)}01` : `${today.slice(0, 4)}-01-01`;
      const pl = await sql<{ pid: string | null; type: string; v: string }>`SELECT e.property_id AS pid, a.account_type AS type, sum(CASE WHEN a.account_type = 'REVENUE' THEN e.credit_minor - e.debit_minor ELSE e.debit_minor - e.credit_minor END)::text AS v
        FROM gl_entry e JOIN gl_account a ON a.tenant_id = e.tenant_id AND a.id = e.account_id WHERE a.account_type IN ('REVENUE','EXPENSE') AND e.posting_date BETWEEN ${from}::date AND ${today}::date GROUP BY 1, 2`.execute(trx);
      const bal = await sql<{ pid: string | null; ctl: string; v: string }>`SELECT e.property_id AS pid, a.control_type AS ctl, sum(e.debit_minor - e.credit_minor)::text AS v FROM gl_entry e JOIN gl_account a ON a.tenant_id = e.tenant_id AND a.id = e.account_id
        WHERE a.control_type IN ('CASH','PETTY_CASH','BANK','RECEIVABLE','PAYABLE','GUEST_ADVANCE') AND e.posting_date <= ${today}::date GROUP BY 1, 2`.execute(trx);
      const names = await this.names(trx); const ids = [...new Set([...pl.rows.map((x) => x.pid), ...bal.rows.map((x) => x.pid)])];
      const card = (pid: string | 'ALL') => { const inB = (x: { pid: string | null }) => pid === 'ALL' || (x.pid ?? HO) === pid; const sum = (rows: Array<{ pid: string | null; v: string }>) => rows.filter(inB).reduce((s, x) => s + BigInt(x.v), 0n);
        const rev = sum(pl.rows.filter((x) => x.type === 'REVENUE')), exp = sum(pl.rows.filter((x) => x.type === 'EXPENSE')); const b = (c: string[]) => sum(bal.rows.filter((x) => c.includes(x.ctl)));
        return { revenue: f(rev), expenses: f(exp), profit: f(rev - exp), cash: f(b(['CASH', 'PETTY_CASH'])), bank: f(b(['BANK'])), receivables: f(b(['RECEIVABLE'])), payables: f(-b(['PAYABLE'])), advances: f(-b(['GUEST_ADVANCE'])) }; };
      const branches = ids.map((p) => ({ id: p ?? HO, name: p ? names.get(p) ?? p : 'Head office', ...card(p ?? HO) })).sort((a, b) => (a.id === HO ? 1 : b.id === HO ? -1 : a.name.localeCompare(b.name)));
      const trend = await sql<{ m: string; type: string; v: string }>`SELECT to_char(e.posting_date, 'YYYY-MM') AS m, a.account_type AS type, sum(CASE WHEN a.account_type = 'REVENUE' THEN e.credit_minor - e.debit_minor ELSE e.debit_minor - e.credit_minor END)::text AS v
        FROM gl_entry e JOIN gl_account a ON a.tenant_id = e.tenant_id AND a.id = e.account_id WHERE a.account_type IN ('REVENUE','EXPENSE') AND e.posting_date >= (${`${today.slice(0, 8)}01`}::date - interval '5 months') AND e.posting_date <= ${today}::date GROUP BY 1, 2 ORDER BY 1`.execute(trx);
      const months = [...new Set(trend.rows.map((x) => x.m))];
      const count = async (s: ReturnType<typeof sql>) => Number((await sql<{ n: number }>`${s}`.execute(trx)).rows[0]!.n);
      const alerts = {
        vouchersWaiting: await count(sql`SELECT count(*)::int AS n FROM voucher WHERE status = 'SUBMITTED'`), cashDifferences: await count(sql`SELECT count(*)::int AS n FROM cash_closing WHERE status = 'PENDING_APPROVAL'`),
        unallocatedOver3Days: await count(sql`SELECT count(*)::int AS n FROM bank_suspense_item s JOIN bank_statement_line l ON l.tenant_id = s.tenant_id AND l.id = s.statement_line_id WHERE s.status <> 'ALLOCATED' AND l.value_date <= ${today}::date - 3`),
        unmatchedBankLines: await count(sql`SELECT count(*)::int AS n FROM bank_statement_line WHERE status = 'UNMATCHED'`), postingExceptions: await count(sql`SELECT count(*)::int AS n FROM finance_exception WHERE status = 'OPEN'`),
        interBranchDifferences: await count(sql`SELECT count(*)::int AS n FROM (SELECT least(a.property_id::text, a.counterparty_property_id::text) AS x, greatest(a.property_id::text, a.counterparty_property_id::text) AS y FROM gl_entry a JOIN gl_account g ON g.tenant_id = a.tenant_id AND g.id = a.account_id WHERE g.control_type = 'INTERBRANCH' AND a.counterparty_property_id IS NOT NULL AND a.posting_date <= ${today}::date GROUP BY 1, 2 HAVING sum(a.debit_minor - a.credit_minor) <> 0) t`),
      };
      return { currency: cur, period: q.period, from, to: today, total: card('ALL'), branches, trend: months.map((m) => { const rv = BigInt(trend.rows.find((x) => x.m === m && x.type === 'REVENUE')?.v ?? 0), ex = BigInt(trend.rows.find((x) => x.m === m && x.type === 'EXPENSE')?.v ?? 0); return { month: m, revenue: f(rv), expenses: f(ex), profit: f(rv - ex) }; }), alerts };
    });
  }
}

@Controller('v1/finance/reports')
export class FinanceReportsController {
  constructor(@Inject(FinanceReportsService) private readonly svc: FinanceReportsService) {}
  @Get('profit-loss') @RequirePermission('finance.view', ANY) pl(@Query() q: unknown) { return this.svc.profitLoss(parse(Range, q)); }
  @Get('balance-sheet') @RequirePermission('finance.view', ANY) bs(@Query() q: unknown) { return this.svc.balanceSheet(parse(AsAt, q)); }
  @Get('cash-flow') @RequirePermission('finance.view', ANY) cf(@Query() q: unknown) { return this.svc.cashFlow(parse(Range, q)); }
  @Get('daily-cash') @RequirePermission('finance.view', ANY) dc(@Query() q: unknown) { return this.svc.dailyCash(parse(Daily, q)); }
  @Get('bank-book') @RequirePermission('finance.view', ANY) bb(@Query() q: unknown) { return this.svc.bankBook(parse(BankBook, q)); }
  @Get('expenses') @RequirePermission('finance.view', ANY) ex(@Query() q: unknown) { return this.svc.expenses(parse(Expenses, q)); }
  @Get('voucher-register') @RequirePermission('finance.view', ANY) vr(@Query() q: unknown) { return this.svc.register(parse(Register, q)); }
  @Get('budget-vs-actual') @RequirePermission('finance.view', ANY) bva(@Query() q: unknown) { return this.svc.budgetVsActual(parse(BudgetVs, q)); }
  @Put('budget') @RequirePermission('finance.setup', ANY) sb(@Body() b: unknown) { return this.svc.setBudget(currentTenant().actorId!, parse(BudgetSet, b)); }
  @Get('dashboard') @RequirePermission('finance.view', ANY) dash(@Query() q: unknown) { return this.svc.dashboard(parse(Dash, q)); }
}
