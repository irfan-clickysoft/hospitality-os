import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, HttpException, Inject, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { DB } from '@hos/db';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';

type Trx = Transaction<DB>;
const ANY = { anyScope: true } as const;
const err = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-20');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-11');
const amount = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 15000 or 15000.50');
const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
const NORMAL: Record<string, 'DEBIT' | 'CREDIT'> = { ASSET: 'DEBIT', EXPENSE: 'DEBIT', LIABILITY: 'CREDIT', EQUITY: 'CREDIT', REVENUE: 'CREDIT' };
const Control = z.enum(['CASH', 'PETTY_CASH', 'BANK', 'RECEIVABLE', 'PAYABLE', 'INTERBRANCH', 'SUSPENSE', 'TAX', 'GUEST_ADVANCE', 'GUEST_DEPOSIT']);

const AccountIn = z.object({ code: z.string().regex(/^[0-9]{4,8}$/, 'Use 4 to 8 digits'), name: z.string().trim().min(2).max(120), type: z.enum(TYPES), parentCode: z.string().regex(/^[0-9]{4,8}$/).optional(), isGroup: z.boolean().default(false), control: Control.optional(), normalBalance: z.enum(['DEBIT', 'CREDIT']).optional(), note: z.string().trim().max(300).optional() }).strict();
const AccountEdit = z.object({ name: z.string().trim().min(2).max(120).optional(), active: z.boolean().optional(), note: z.string().trim().max(300).nullish() }).strict();
const Line = z.object({ account: z.string().regex(/^[0-9]{4,8}$/, 'Use the account code'), branchId: z.string().uuid().nullish(), counterpartyBranchId: z.string().uuid().nullish(), supplierId: z.string().uuid().nullish(), debit: amount.optional(), credit: amount.optional(), description: z.string().trim().max(300).optional(), reference: z.string().trim().max(120).optional() }).strict();
const VoucherIn = z.object({ type: z.literal('JV'), date, postingDate: date.optional(), narration: z.string().trim().min(3).max(500), lines: z.array(Line).min(2).max(100) }).strict();
const Reverse = z.object({ date, reason: z.string().trim().min(3).max(300) }).strict();
const Reject = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
const Settings = z.object({ selfApproveLimit: amount }).strict();
const Period = z.object({ reason: z.string().trim().min(3).max(300).optional() }).strict();
const ListQ = z.object({ status: z.enum(['DRAFT', 'SUBMITTED', 'POSTED', 'REJECTED', 'CANCELLED']).optional(), from: date.optional(), to: date.optional() });
const TbQ = z.object({ from: date, to: date, branchId: z.string().uuid().optional() });
const GlQ = z.object({ account: z.string().regex(/^[0-9]{4,8}$/), from: date, to: date, branchId: z.string().uuid().optional() });

/** Starter chart of accounts for a hotel company. The branch is a dimension on each line, so one cash account serves every branch. The finance controller approves the final list. */
export type VType = 'JV' | 'CRV' | 'BRV' | 'CPV' | 'BPV' | 'CTV' | 'IBEV' | 'IBTV' | 'SBV' | 'SPV';
export type CreateArgs = Omit<z.infer<typeof VoucherIn>, 'type'> & { type: VType };

export const STARTER_COA: ReadonlyArray<[string, string, string, boolean, string | null, string | null]> = [
  // code, name, type, group, parent, control
  ['1000', 'Assets', 'ASSET', true, null, null], ['1010', 'Cash in Hand', 'ASSET', false, '1000', 'CASH'], ['1040', 'Petty Cash', 'ASSET', false, '1000', 'PETTY_CASH'], ['1100', 'Bank Accounts', 'ASSET', true, '1000', 'BANK'],
  ['1200', 'Guest / Corporate Receivables', 'ASSET', false, '1000', 'RECEIVABLE'], ['1210', 'OTA Receivables', 'ASSET', false, '1000', 'RECEIVABLE'], ['1300', 'Supplier Advances', 'ASSET', false, '1000', null], ['1310', 'Prepaid Expenses', 'ASSET', false, '1000', null],
  ['1400', 'Inventory / Operating Supplies', 'ASSET', false, '1000', null], ['1500', 'Furniture, Fixtures & Equipment', 'ASSET', false, '1000', null], ['1590', 'Accumulated Depreciation', 'ASSET', false, '1000', null],
  ['1700', 'Due From Other Branches', 'ASSET', false, '1000', 'INTERBRANCH'], ['1800', 'Unallocated Bank Receipts (Suspense)', 'ASSET', false, '1000', 'SUSPENSE'],
  ['2000', 'Liabilities', 'LIABILITY', true, null, null], ['2010', 'Accounts Payable – Suppliers', 'LIABILITY', false, '2000', 'PAYABLE'], ['2020', 'Accrued Expenses', 'LIABILITY', false, '2000', null], ['2030', 'Salaries Payable', 'LIABILITY', false, '2000', null], ['2040', 'Utilities Payable', 'LIABILITY', false, '2000', null],
  ['2100', 'Booking Advances / Unearned Guest Revenue', 'LIABILITY', false, '2000', 'GUEST_ADVANCE'], ['2110', 'Guest Security Deposits Payable', 'LIABILITY', false, '2000', 'GUEST_DEPOSIT'], ['2120', 'Guest Refunds Payable', 'LIABILITY', false, '2000', null],
  ['2130', 'Card / Payment Gateway Payable', 'LIABILITY', false, '2000', null], ['2140', 'Taxes / Withholding Payable', 'LIABILITY', false, '2000', 'TAX'], ['2200', 'Due To Other Branches', 'LIABILITY', false, '2000', 'INTERBRANCH'],
  ['3000', 'Equity', 'EQUITY', true, null, null], ['3010', 'Owner Capital', 'EQUITY', false, '3000', null], ['3020', 'Additional Capital', 'EQUITY', false, '3000', null], ['3030', 'Owner Drawings', 'EQUITY', false, '3000', null], ['3040', 'Retained Earnings', 'EQUITY', false, '3000', null], ['3050', 'Current Year Profit / Loss', 'EQUITY', false, '3000', null],
  ['4000', 'Revenue', 'REVENUE', true, null, null], ['4010', 'Room Revenue', 'REVENUE', false, '4000', null], ['4020', 'Early Check-in / Late Checkout', 'REVENUE', false, '4000', null], ['4030', 'Extra Guest / Extra Bed', 'REVENUE', false, '4000', null], ['4040', 'Laundry Revenue', 'REVENUE', false, '4000', null],
  ['4050', 'Cleaning / Housekeeping Services', 'REVENUE', false, '4000', null], ['4060', 'Food & Beverage Revenue', 'REVENUE', false, '4000', null], ['4070', 'Airport Transfer / Transport Revenue', 'REVENUE', false, '4000', null], ['4080', 'Other Guest Services Revenue', 'REVENUE', false, '4000', null],
  ['4090', 'Cancellation / No-show Revenue', 'REVENUE', false, '4000', null], ['4100', 'Damage Recovery Revenue', 'REVENUE', false, '4000', null],
  ['5000', 'Operating Expenses', 'EXPENSE', true, null, null], ['5010', 'Salaries & Wages', 'EXPENSE', false, '5000', null], ['5020', 'Electricity Expense', 'EXPENSE', false, '5000', null], ['5030', 'Gas Expense', 'EXPENSE', false, '5000', null], ['5040', 'Water Expense', 'EXPENSE', false, '5000', null],
  ['5050', 'Internet & Telephone', 'EXPENSE', false, '5000', null], ['5060', 'Rent / Lease Expense', 'EXPENSE', false, '5000', null], ['5070', 'Housekeeping & Cleaning Supplies', 'EXPENSE', false, '5000', null], ['5080', 'Laundry Expense', 'EXPENSE', false, '5000', null], ['5090', 'Guest Amenities & Consumables', 'EXPENSE', false, '5000', null],
  ['5100', 'Repairs & Maintenance', 'EXPENSE', false, '5000', null], ['5110', 'Marketing & Advertising', 'EXPENSE', false, '5000', null], ['5120', 'OTA / Channel Commission', 'EXPENSE', false, '5000', null], ['5130', 'Bank & Payment Gateway Charges', 'EXPENSE', false, '5000', null],
  ['5140', 'Office & Administration', 'EXPENSE', false, '5000', null], ['5150', 'Transport & Fuel', 'EXPENSE', false, '5000', null], ['5160', 'Security Services', 'EXPENSE', false, '5000', null], ['5170', 'Software & IT Expense', 'EXPENSE', false, '5000', null], ['5180', 'Depreciation Expense', 'EXPENSE', false, '5000', null],
  ['5190', 'Staff Meals & Welfare', 'EXPENSE', false, '5000', null], ['5200', 'Miscellaneous Approved Expense', 'EXPENSE', false, '5000', null],
];

const minor = (v: string | undefined, cur: string): bigint => (v ? Money.parse(v, cur).minor : 0n);
const dec = (m: bigint | string, cur: string) => Money.ofMinor(BigInt(m), cur).toDecimalString();

/** The accounting core: chart of accounts, vouchers that need a second person to approve, an immutable ledger, and month locks. Branch (property) is a dimension on every line. */
@Injectable()
export class FinanceService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService) {}

  async settings(trx: Trx) {
    const t = currentTenant().tenantId;
    await sql`INSERT INTO gl_settings (tenant_id) VALUES (${t}) ON CONFLICT DO NOTHING`.execute(trx);
    return trx.selectFrom('gl_settings').selectAll().executeTakeFirstOrThrow();
  }
  async nextVoucherNo(trx: Trx, type: string, year: number): Promise<string> {
    const n = await sql<{ n: number }>`INSERT INTO voucher_counter (tenant_id, voucher_type, year, last_no) VALUES (${currentTenant().tenantId}, ${type}, ${year}, 1) ON CONFLICT (tenant_id, voucher_type, year) DO UPDATE SET last_no = voucher_counter.last_no + 1 RETURNING last_no AS n`.execute(trx);
    return `${type}-${year}-${String(n.rows[0]!.n).padStart(6, '0')}`;
  }
  /** The date a system posting lands on: its own date, or the first day of the next open month when that month is closed (the posting is never refused). */
  async openDateFrom(trx: Trx, date: string): Promise<string> {
    let d = date;
    for (let i = 0; i < 36; i++) {
      const p = await trx.selectFrom('gl_period').select('status').where('month', '=', `${d.slice(0, 7)}-01`).executeTakeFirst();
      if (p?.status !== 'CLOSED') return d;
      const [y, m] = d.split('-').map(Number) as [number, number]; d = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    }
    return d;
  }
  /** Writes a balanced, already-approved voucher straight to the ledger for a system source (one voucher per source event: a repeat does nothing). Returns the voucher id, or null if it already existed. */
  async postSystem(trx: Trx, a: { type: 'PMS' | 'JV'; date: string; narration: string; module: string; eventId: string; userId?: string | null; lines: Array<{ accountId: string; propertyId: string | null; debit: bigint; credit: bigint; description?: string | null; reference?: string | null }> }): Promise<string | null> {
    if (await trx.selectFrom('voucher').select('id').where('source_module', '=', a.module).where('source_event_id', '=', a.eventId).executeTakeFirst()) return null;
    const d = a.lines.reduce((s, l) => s + l.debit, 0n), c = a.lines.reduce((s, l) => s + l.credit, 0n);
    if (d !== c || d === 0n) throw err(409, 'NOT_BALANCED', `System posting is not balanced (${d} vs ${c})`);
    const s = await this.settings(trx);
    const by = a.userId ?? currentTenant().actorId ?? (await trx.selectFrom('staff_user').select('id').orderBy('created_at').limit(1).executeTakeFirstOrThrow()).id;
    const posting = await this.openDateFrom(trx, a.date); const late = posting !== a.date;
    const no = await this.nextVoucherNo(trx, a.type, Number(posting.slice(0, 4)));
    const v = await trx.insertInto('voucher').values({ tenant_id: currentTenant().tenantId, voucher_no: no, voucher_type: a.type, voucher_date: a.date, posting_date: posting, narration: (late ? `${a.narration} (month ${a.date.slice(0, 7)} was closed)` : a.narration).slice(0, 500), currency: s.base_currency, total_minor: d.toString(), source_module: a.module, source_event_id: a.eventId, created_by: by, submitted_by: by, submitted_at: new Date() } as never).returning('id').executeTakeFirstOrThrow();
    const lines = await trx.insertInto('voucher_line').values(a.lines.map((l, i) => ({ tenant_id: currentTenant().tenantId, voucher_id: v.id, line_no: i + 1, account_id: l.accountId, property_id: l.propertyId, debit_minor: l.debit.toString(), credit_minor: l.credit.toString(), description: l.description ?? null, reference: l.reference ?? null })) as never).returning(['id', 'account_id', 'property_id', 'debit_minor', 'credit_minor']).execute();
    await trx.insertInto('gl_entry').values(lines.map((l) => ({ tenant_id: currentTenant().tenantId, voucher_id: v.id, line_id: l.id, account_id: l.account_id, property_id: l.property_id, posting_date: posting, debit_minor: l.debit_minor, credit_minor: l.credit_minor })) as never).execute();
    const now = new Date();
    await trx.updateTable('voucher').set({ status: 'POSTED', approved_by: by, approved_at: now, posted_by: by, posted_at: now } as never).where('id', '=', v.id).execute();
    return v.id;
  }
  private async assertOpen(trx: Trx, postingDate: string) {
    const p = await trx.selectFrom('gl_period').select('status').where('month', '=', `${postingDate.slice(0, 7)}-01`).executeTakeFirst();
    if (p?.status === 'CLOSED') throw err(409, 'PERIOD_CLOSED', `The month ${postingDate.slice(0, 7)} is closed. A finance manager must reopen it first.`);
  }

  // ---- chart of accounts
  async accounts() {
    return this.tdb.tx(async (trx) => {
      const a = await trx.selectFrom('gl_account').selectAll().orderBy('code').execute();
      const code = new Map(a.map((x) => [x.id, x.code]));
      return { items: a.map((x) => ({ id: x.id, code: x.code, name: x.name, type: x.account_type, normalBalance: x.normal_balance, isGroup: x.is_group, control: x.control_type, parentCode: x.parent_id ? code.get(x.parent_id) ?? null : null, active: x.active, note: x.note })) };
    });
  }
  async addAccount(userId: string, i: z.infer<typeof AccountIn>) {
    return this.tdb.tx(async (trx) => {
      const type = i.type.toUpperCase();
      if (await trx.selectFrom('gl_account').select('id').where('code', '=', i.code).executeTakeFirst()) throw err(409, 'ACCOUNT_EXISTS', `Account ${i.code} already exists`);
      let parent: string | null = null;
      if (i.parentCode) { const p = await trx.selectFrom('gl_account').select(['id', 'is_group', 'account_type']).where('code', '=', i.parentCode).executeTakeFirst(); if (!p) throw err(404, 'NOT_FOUND', `Parent account ${i.parentCode} does not exist`); if (!p.is_group) throw err(409, 'PARENT_NOT_GROUP', 'The parent must be a heading account'); if (p.account_type !== type) throw err(409, 'PARENT_TYPE', 'The parent is a different type of account'); parent = p.id; }
      const row = await trx.insertInto('gl_account').values({ tenant_id: currentTenant().tenantId, code: i.code, name: i.name, parent_id: parent, account_type: type, normal_balance: i.normalBalance ?? NORMAL[type]!, is_group: i.isGroup, control_type: i.control ?? null, note: i.note ?? null, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'finance.account.add', resourceType: 'gl_account', resourceId: row.id, after: { code: i.code, name: i.name, type } });
      return { id: row.id };
    });
  }
  async editAccount(userId: string, id: string, i: z.infer<typeof AccountEdit>) {
    return this.tdb.tx(async (trx) => {
      const a = await trx.selectFrom('gl_account').selectAll().where('id', '=', id).executeTakeFirst(); if (!a) throw err(404, 'NOT_FOUND', 'No such account');
      const set: Record<string, unknown> = {}; if (i.name !== undefined) set.name = i.name; if (i.active !== undefined) set.active = i.active; if (i.note !== undefined) set.note = i.note;
      if (!Object.keys(set).length) return { saved: true };
      await trx.updateTable('gl_account').set(set as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'finance.account.edit', resourceType: 'gl_account', resourceId: id, before: { name: a.name, active: a.active }, after: set });
      return { saved: true };
    });
  }
  async loadStarter(userId: string) {
    return this.tdb.tx(async (trx) => {
      if ((await trx.selectFrom('gl_account').select('id').limit(1).executeTakeFirst())) throw err(409, 'CHART_EXISTS', 'This company already has accounts. Add or edit them one by one.');
      const ids = new Map<string, string>();
      for (const [code, name, type, grp, parent, control] of STARTER_COA) {
        const row = await trx.insertInto('gl_account').values({ tenant_id: currentTenant().tenantId, code, name, parent_id: parent ? ids.get(parent) ?? null : null, account_type: type, normal_balance: NORMAL[type]!, is_group: grp, control_type: control, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
        ids.set(code, row.id);
      }
      await this.audit.record(trx, { action: 'finance.account.starter', resourceType: 'gl_account', resourceId: 'starter', after: { accounts: STARTER_COA.length } });
      return { loaded: STARTER_COA.length };
    });
  }
  async getSettings() { return this.tdb.tx(async (trx) => { const s = await this.settings(trx); return { baseCurrency: s.base_currency, selfApproveLimit: dec(s.self_approve_limit_minor, s.base_currency) }; }); }
  async saveSettings(userId: string, i: z.infer<typeof Settings>) {
    return this.tdb.tx(async (trx) => {
      const s = await this.settings(trx); const v = minor(i.selfApproveLimit, s.base_currency);
      await trx.updateTable('gl_settings').set({ self_approve_limit_minor: v.toString(), updated_by: userId, updated_at: new Date() } as never).execute();
      await this.audit.record(trx, { action: 'finance.settings', resourceType: 'gl_settings', resourceId: currentTenant().tenantId, before: { selfApproveLimit: dec(s.self_approve_limit_minor, s.base_currency) }, after: { selfApproveLimit: i.selfApproveLimit } });
      return { saved: true };
    });
  }

  // ---- vouchers
  private async lines(trx: Trx, cur: string, lines: z.infer<typeof Line>[]) {
    const out: Array<{ account_id: string; property_id: string | null; counterparty_property_id: string | null; supplier_id: string | null; debit_minor: string; credit_minor: string; description: string | null; reference: string | null }> = [];
    for (const [n, l] of lines.entries()) {
      const d = minor(l.debit, cur), c = minor(l.credit, cur);
      if ((d > 0n) === (c > 0n)) throw err(400, 'VALIDATION_FAILED', `Line ${n + 1}: enter either a debit or a credit, not both and not neither`);
      const a = await trx.selectFrom('gl_account').select(['id', 'active', 'is_group', 'control_type']).where('code', '=', l.account).executeTakeFirst();
      if (!a) throw err(400, 'ACCOUNT_UNKNOWN', `Line ${n + 1}: account ${l.account} does not exist`);
      if (a.is_group) throw err(400, 'ACCOUNT_IS_HEADING', `Line ${n + 1}: account ${l.account} is a heading; post to one of the accounts under it`);
      if (!a.active) throw err(400, 'ACCOUNT_INACTIVE', `Line ${n + 1}: account ${l.account} is switched off`);
      if (l.branchId) { const p = await trx.selectFrom('property').select('id').where('id', '=', l.branchId).executeTakeFirst(); if (!p) throw err(400, 'BRANCH_UNKNOWN', `Line ${n + 1}: that branch does not exist`); }
      if (a.control_type === 'INTERBRANCH') {
        if (!l.branchId || !l.counterpartyBranchId) throw err(400, 'INTERBRANCH_BRANCHES', `Line ${n + 1}: a Due From / Due To line needs both branches`);
        if (l.branchId === l.counterpartyBranchId) throw err(400, 'SAME_BRANCH', `Line ${n + 1}: the two branches must be different`);
      } else if (l.counterpartyBranchId) throw err(400, 'INTERBRANCH_BRANCHES', `Line ${n + 1}: only a Due From / Due To line names another branch`);
      if (l.counterpartyBranchId && !(await trx.selectFrom('property').select('id').where('id', '=', l.counterpartyBranchId).executeTakeFirst())) throw err(400, 'BRANCH_UNKNOWN', `Line ${n + 1}: the other branch does not exist`);
      if (a.control_type === 'PAYABLE') { if (!l.supplierId) throw err(400, 'SUPPLIER_REQUIRED', `Line ${n + 1}: a line on the payables account must name the supplier`); }
      else if (l.supplierId) throw err(400, 'SUPPLIER_REQUIRED', `Line ${n + 1}: only a line on the payables account names a supplier`);
      if (l.supplierId && !(await trx.selectFrom('supplier').select('id').where('id', '=', l.supplierId).executeTakeFirst())) throw err(400, 'SUPPLIER_UNKNOWN', `Line ${n + 1}: that supplier does not exist`);
      await this.checkBank(trx, a.id, l.branchId ?? null, n + 1);
      out.push({ account_id: a.id, property_id: l.branchId ?? null, counterparty_property_id: l.counterpartyBranchId ?? null, supplier_id: l.supplierId ?? null, debit_minor: d.toString(), credit_minor: c.toString(), description: l.description ?? null, reference: l.reference ?? null });
    }
    return out;
  }
  /** A bank account's ledger account can be used only once it is set up: branches and purpose confirmed, and (if it is held in someone else's name) authorised. */
  private async checkBank(trx: Trx, accountId: string, branchId: string | null, n: number) {
    const b = await trx.selectFrom('payment_account').select(['id', 'name', 'purpose', 'owner_type', 'authorised_at']).where('gl_account_id', '=', accountId).executeTakeFirst();
    if (!b) return;
    const maps = await trx.selectFrom('payment_account_branch').select('property_id').where('payment_account_id', '=', b.id).execute();
    if (!b.purpose || maps.length === 0) throw err(409, 'BANK_NOT_MAPPED', `Line ${n}: the bank account “${b.name}” has no branch or purpose set yet`);
    if (b.owner_type !== 'COMPANY' && !b.authorised_at) throw err(409, 'BANK_NOT_AUTHORISED', `Line ${n}: the bank account “${b.name}” is held in someone else's name and has not been authorised for company use`);
    if (branchId && !maps.some((m) => m.property_id === branchId)) throw err(409, 'BANK_BRANCH_NOT_MAPPED', `Line ${n}: the bank account “${b.name}” is not set up for that branch`);
  }
  private async writeLines(trx: Trx, voucherId: string, rows: Awaited<ReturnType<FinanceService['lines']>>) {
    await trx.deleteFrom('voucher_line').where('voucher_id', '=', voucherId).execute();
    await trx.insertInto('voucher_line').values(rows.map((r, i) => ({ tenant_id: currentTenant().tenantId, voucher_id: voucherId, line_no: i + 1, ...r })) as never).execute();
    const d = rows.reduce((s, r) => s + BigInt(r.debit_minor), 0n);
    return d;
  }

  async create(userId: string, i: CreateArgs, source?: { module: string; eventId: string }) {
    return this.tdb.tx(async (trx) => {
      const s = await this.settings(trx); const cur = s.base_currency; const posting = i.postingDate ?? i.date;
      await this.assertOpen(trx, posting);
      const rows = await this.lines(trx, cur, i.lines);
      const d = rows.reduce((t, r) => t + BigInt(r.debit_minor), 0n), c = rows.reduce((t, r) => t + BigInt(r.credit_minor), 0n);
      const v = await trx.insertInto('voucher').values({ tenant_id: currentTenant().tenantId, voucher_type: i.type, voucher_date: i.date, posting_date: posting, narration: i.narration, currency: cur, total_minor: d.toString(), created_by: userId, source_module: source?.module ?? null, source_event_id: source?.eventId ?? null } as never).returning('id').executeTakeFirstOrThrow();
      await this.writeLines(trx, v.id, rows);
      await this.audit.record(trx, { action: 'finance.voucher.create', resourceType: 'voucher', resourceId: v.id, after: { type: i.type, total: dec(d, cur), balanced: d === c } });
      return { id: v.id, balanced: d === c, total: dec(d, cur), difference: dec(d > c ? d - c : c - d, cur) };
    });
  }

  private async load(trx: Trx, id: string) { const v = await trx.selectFrom('voucher').selectAll().where('id', '=', id).executeTakeFirst(); if (!v) throw err(404, 'NOT_FOUND', 'No such voucher'); return v; }

  async edit(userId: string, id: string, i: z.infer<typeof VoucherIn>) {
    return this.tdb.tx(async (trx) => {
      const v = await this.load(trx, id);
      if (!['DRAFT', 'REJECTED'].includes(v.status)) throw err(409, 'VOUCHER_LOCKED', `A ${v.status.toLowerCase()} voucher cannot be edited`);
      if (v.created_by !== userId) throw err(403, 'FIN_NOT_YOURS', 'Only the person who prepared this voucher can edit it');
      const posting = i.postingDate ?? i.date; await this.assertOpen(trx, posting);
      const rows = await this.lines(trx, v.currency, i.lines);
      const d = await this.writeLines(trx, id, rows); const c = rows.reduce((t, r) => t + BigInt(r.credit_minor), 0n);
      await trx.updateTable('voucher').set({ voucher_date: i.date, posting_date: posting, narration: i.narration, total_minor: d.toString(), status: 'DRAFT', reject_reason: null } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'finance.voucher.edit', resourceType: 'voucher', resourceId: id, after: { total: dec(d, v.currency) } });
      return { id, balanced: d === c, total: dec(d, v.currency) };
    });
  }

  async submit(userId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const v = await this.load(trx, id);
      if (!['DRAFT', 'REJECTED'].includes(v.status)) throw err(409, 'VOUCHER_LOCKED', `A ${v.status.toLowerCase()} voucher cannot be submitted`);
      await this.assertOpen(trx, v.posting_date);
      const sums = await sql<{ d: string; c: string }>`SELECT coalesce(sum(debit_minor),0)::text AS d, coalesce(sum(credit_minor),0)::text AS c FROM voucher_line WHERE voucher_id = ${id}`.execute(trx);
      const d = BigInt(sums.rows[0]!.d), c = BigInt(sums.rows[0]!.c);
      if (d !== c || d === 0n) throw err(409, 'NOT_BALANCED', `Debits ${dec(d, v.currency)} and credits ${dec(c, v.currency)} differ by ${dec(d > c ? d - c : c - d, v.currency)}`);
      const no = v.voucher_no ?? (await this.nextVoucherNo(trx, v.voucher_type, Number(v.voucher_date.slice(0, 4))));
      await trx.updateTable('voucher').set({ status: 'SUBMITTED', voucher_no: no, submitted_by: userId, submitted_at: new Date(), reject_reason: null } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'finance.voucher.submit', resourceType: 'voucher', resourceId: id, after: { voucherNo: no } });
      return { id, voucherNo: no, status: 'SUBMITTED' };
    });
  }

  /** Approving posts. The person who prepared it may not approve it unless it is within the self-approval limit (0 by default). */
  async approve(userId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const v = await this.load(trx, id);
      if (v.status !== 'SUBMITTED') throw err(409, 'VOUCHER_NOT_SUBMITTED', 'Only a submitted voucher can be approved');
      const s = await this.settings(trx);
      const ownerTitled = await sql<{ n: number }>`SELECT count(*)::int AS n FROM voucher_line l JOIN payment_account b ON b.tenant_id = l.tenant_id AND b.gl_account_id = l.account_id WHERE l.voucher_id = ${id} AND b.owner_type <> 'COMPANY'`.execute(trx);
      if (v.created_by === userId && (ownerTitled.rows[0]!.n > 0 || v.voucher_type === 'IBEV' || v.voucher_type === 'IBTV' || BigInt(v.total_minor) > BigInt(s.self_approve_limit_minor))) throw err(403, 'FINANCE_SELF_APPROVAL', 'You prepared this voucher, so someone else has to approve it');
      await this.assertOpen(trx, v.posting_date);
      const lines = await trx.selectFrom('voucher_line').selectAll().where('voucher_id', '=', id).orderBy('line_no').execute();
      await trx.insertInto('gl_entry').values(lines.map((l) => ({ tenant_id: currentTenant().tenantId, voucher_id: id, line_id: l.id, account_id: l.account_id, property_id: l.property_id, counterparty_property_id: l.counterparty_property_id, supplier_id: l.supplier_id, posting_date: v.posting_date, debit_minor: l.debit_minor, credit_minor: l.credit_minor })) as never).execute();
      const now = new Date();
      await trx.updateTable('voucher').set({ status: 'POSTED', approved_by: userId, approved_at: now, posted_by: userId, posted_at: now } as never).where('id', '=', id).execute();
      await sql`UPDATE bank_suspense_item SET status = 'ALLOCATED' WHERE allocated_voucher_id = ${id}`.execute(trx);
      if (v.reverses_voucher_id) {                           // undoing a supplier payment gives the bills back what was paid; undoing a bill voids it
        await sql`UPDATE supplier_bill b SET paid_minor = b.paid_minor - a.amount_minor FROM supplier_payment p JOIN supplier_payment_alloc a ON a.tenant_id = p.tenant_id AND a.payment_id = p.id WHERE p.voucher_id = ${v.reverses_voucher_id} AND b.tenant_id = a.tenant_id AND b.id = a.bill_id`.execute(trx);
        await sql`UPDATE supplier_bill SET reversed = true WHERE voucher_id = ${v.reverses_voucher_id}`.execute(trx);
      } else await sql`UPDATE supplier_bill b SET paid_minor = b.paid_minor + a.amount_minor FROM supplier_payment p JOIN supplier_payment_alloc a ON a.tenant_id = p.tenant_id AND a.payment_id = p.id WHERE p.voucher_id = ${id} AND b.tenant_id = a.tenant_id AND b.id = a.bill_id`.execute(trx);
      await this.audit.record(trx, { action: 'finance.voucher.post', resourceType: 'voucher', resourceId: id, after: { voucherNo: v.voucher_no, total: dec(v.total_minor, v.currency), postingDate: v.posting_date } });
      return { id, voucherNo: v.voucher_no, status: 'POSTED' };
    });
  }

  async reject(userId: string, id: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      const v = await this.load(trx, id);
      if (v.status !== 'SUBMITTED') throw err(409, 'VOUCHER_NOT_SUBMITTED', 'Only a submitted voucher can be rejected');
      await trx.updateTable('voucher').set({ status: 'REJECTED', rejected_by: userId, reject_reason: reason } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'finance.voucher.reject', resourceType: 'voucher', resourceId: id, after: { reason } });
      return { id, status: 'REJECTED' };
    });
  }

  async cancel(userId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const v = await this.load(trx, id);
      if (!['DRAFT', 'REJECTED'].includes(v.status)) throw err(409, 'VOUCHER_LOCKED', 'Only a draft or rejected voucher can be cancelled; a posted one is reversed');
      if (v.created_by !== userId) throw err(403, 'FIN_NOT_YOURS', 'Only the person who prepared this voucher can cancel it');
      await trx.updateTable('voucher').set({ status: 'CANCELLED' } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'finance.voucher.cancel', resourceType: 'voucher', resourceId: id, after: {} });
      return { id, status: 'CANCELLED' };
    });
  }

  /** A posted voucher is never edited. This prepares a new draft with every line swapped, linked to the original; it is submitted and approved like any other. */
  async reverse(userId: string, id: string, i: z.infer<typeof Reverse>) {
    return this.tdb.tx(async (trx) => {
      const v = await this.load(trx, id);
      if (v.status !== 'POSTED') throw err(409, 'NOT_POSTED', 'Only a posted voucher can be reversed');
      if (v.voucher_type === 'SBV') { const b = await trx.selectFrom('supplier_bill').select(['id', 'paid_minor']).where('voucher_id', '=', id).executeTakeFirst(); const pend = b ? await sql<{ n: number }>`SELECT count(*)::int AS n FROM supplier_payment_alloc a JOIN supplier_payment p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id JOIN voucher pv ON pv.tenant_id = p.tenant_id AND pv.id = p.voucher_id WHERE a.bill_id = ${b.id} AND pv.status IN ('DRAFT','SUBMITTED','REJECTED','POSTED') AND NOT EXISTS (SELECT 1 FROM voucher r WHERE r.reverses_voucher_id = pv.id AND r.status = 'POSTED')`.execute(trx) : null; if (b && (BigInt(b.paid_minor) > 0n || (pend?.rows[0]?.n ?? 0) > 0)) throw err(409, 'SUPPLIER_BILL_HAS_PAYMENTS', 'This bill has payments against it. Reverse those first.'); }
      const live = await trx.selectFrom('voucher').select('id').where('reverses_voucher_id', '=', id).where('status', 'in', ['DRAFT', 'SUBMITTED', 'POSTED']).executeTakeFirst();
      if (live) throw err(409, 'ALREADY_REVERSED', 'This voucher already has a reversal');
      await this.assertOpen(trx, i.date);
      const lines = await trx.selectFrom('voucher_line').selectAll().where('voucher_id', '=', id).orderBy('line_no').execute();
      const r = await trx.insertInto('voucher').values({ tenant_id: currentTenant().tenantId, voucher_type: v.voucher_type, voucher_date: i.date, posting_date: i.date, narration: `Reversal of ${v.voucher_no}: ${i.reason}`.slice(0, 500), currency: v.currency, total_minor: v.total_minor, reverses_voucher_id: id, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await this.writeLines(trx, r.id, lines.map((l) => ({ account_id: l.account_id, property_id: l.property_id, counterparty_property_id: l.counterparty_property_id, supplier_id: l.supplier_id, debit_minor: l.credit_minor, credit_minor: l.debit_minor, description: l.description, reference: l.reference })));
      await this.audit.record(trx, { action: 'finance.voucher.reverse', resourceType: 'voucher', resourceId: id, after: { reversal: r.id, reason: i.reason } });
      return { id: r.id };
    });
  }

  async list(q: z.infer<typeof ListQ>) {
    return this.tdb.tx(async (trx) => {
      let b = trx.selectFrom('voucher as v').leftJoin('staff_user as u', (j) => j.onRef('u.id', '=', 'v.created_by').onRef('u.tenant_id', '=', 'v.tenant_id'))
        .select(['v.id', 'v.voucher_no', 'v.voucher_type', 'v.voucher_date', 'v.posting_date', 'v.status', 'v.narration', 'v.total_minor', 'v.currency', 'v.created_by', 'u.full_name as by', 'v.reverses_voucher_id', 'v.reject_reason']).orderBy('v.created_at', 'desc').limit(300);
      if (q.status) b = b.where('v.status', '=', q.status); if (q.from) b = b.where('v.posting_date', '>=', q.from); if (q.to) b = b.where('v.posting_date', '<=', q.to);
      return { items: (await b.execute()).map((v) => ({ id: v.id, voucherNo: v.voucher_no, type: v.voucher_type, date: v.voucher_date, postingDate: v.posting_date, status: v.status, narration: v.narration, total: dec(v.total_minor, v.currency), preparedBy: v.by, preparedById: v.created_by, reversesId: v.reverses_voucher_id, rejectReason: v.reject_reason })) };
    });
  }

  async get(id: string) {
    return this.tdb.tx(async (trx) => {
      const v = await this.load(trx, id);
      const lines = await trx.selectFrom('voucher_line as l').innerJoin('gl_account as a', (j) => j.onRef('a.id', '=', 'l.account_id').onRef('a.tenant_id', '=', 'l.tenant_id')).leftJoin('property as p', (j) => j.onRef('p.id', '=', 'l.property_id').onRef('p.tenant_id', '=', 'l.tenant_id'))
        .leftJoin('property as cp', (j) => j.onRef('cp.id', '=', 'l.counterparty_property_id').onRef('cp.tenant_id', '=', 'l.tenant_id')).select(['l.line_no', 'a.code', 'a.name', 'l.property_id', 'p.name as branch', 'cp.name as other', 'l.debit_minor', 'l.credit_minor', 'l.description', 'l.reference']).where('l.voucher_id', '=', id).orderBy('l.line_no').execute();
      const rev = await trx.selectFrom('voucher').select(['id', 'voucher_no', 'status']).where('reverses_voucher_id', '=', id).where('status', 'in', ['DRAFT', 'SUBMITTED', 'POSTED']).executeTakeFirst();
      return { id: v.id, voucherNo: v.voucher_no, type: v.voucher_type, date: v.voucher_date, postingDate: v.posting_date, status: v.status, narration: v.narration, currency: v.currency, total: dec(v.total_minor, v.currency), preparedById: v.created_by, rejectReason: v.reject_reason, reversesId: v.reverses_voucher_id, reversal: rev ? { id: rev.id, voucherNo: rev.voucher_no, status: rev.status } : null,
        lines: lines.map((l) => ({ lineNo: l.line_no, account: l.code, accountName: l.name, branchId: l.property_id, branch: l.branch ?? 'Head office', otherBranch: l.other ?? null, debit: dec(l.debit_minor, v.currency), credit: dec(l.credit_minor, v.currency), description: l.description, reference: l.reference })) };
    });
  }

  // ---- periods
  async periods() { return this.tdb.tx(async (trx) => ({ items: (await trx.selectFrom('gl_period').selectAll().orderBy('month', 'desc').execute()).map((p) => ({ month: p.month.slice(0, 7), status: p.status, reason: p.reason, changedAt: p.changed_at })) })); }
  async setPeriod(userId: string, m: string, status: 'CLOSED' | 'OPEN', reason?: string) {
    return this.tdb.tx(async (trx) => {
      if (status === 'CLOSED') {
        const pending = await trx.selectFrom('voucher').select('id').where('status', '=', 'SUBMITTED').where('posting_date', '>=', `${m}-01`).where(sql<boolean>`posting_date < (${m + '-01'}::date + interval '1 month')`).limit(1).executeTakeFirst();
        if (pending) throw err(409, 'PENDING_VOUCHERS', 'Vouchers for this month are still waiting for approval');
      } else if (!reason) throw err(400, 'VALIDATION_FAILED', 'Say why the month is being reopened');
      await trx.insertInto('gl_period').values({ tenant_id: currentTenant().tenantId, month: `${m}-01`, status, changed_by: userId, reason: reason ?? null } as never).onConflict((oc) => oc.columns(['tenant_id', 'month']).doUpdateSet({ status, changed_by: userId, changed_at: new Date(), reason: reason ?? null } as never)).execute();
      await this.audit.record(trx, { action: status === 'CLOSED' ? 'finance.period.close' : 'finance.period.reopen', resourceType: 'gl_period', resourceId: m, after: { reason: reason ?? null } });
      return { month: m, status };
    });
  }

  // ---- reports
  async trialBalance(q: z.infer<typeof TbQ>) {
    return this.tdb.tx(async (trx) => {
      const cur = (await this.settings(trx)).base_currency;
      const br = q.branchId ? sql`AND e.property_id = ${q.branchId}` : sql``;
      const r = await sql<{ code: string; name: string; type: string; open_d: string; open_c: string; d: string; c: string }>`
        SELECT a.code, a.name, a.account_type AS type,
          coalesce(sum(e.debit_minor) FILTER (WHERE e.posting_date < ${q.from}::date), 0)::text AS open_d, coalesce(sum(e.credit_minor) FILTER (WHERE e.posting_date < ${q.from}::date), 0)::text AS open_c,
          coalesce(sum(e.debit_minor) FILTER (WHERE e.posting_date BETWEEN ${q.from}::date AND ${q.to}::date), 0)::text AS d, coalesce(sum(e.credit_minor) FILTER (WHERE e.posting_date BETWEEN ${q.from}::date AND ${q.to}::date), 0)::text AS c
        FROM gl_account a LEFT JOIN gl_entry e ON e.tenant_id = a.tenant_id AND e.account_id = a.id AND e.posting_date <= ${q.to}::date ${br}
        WHERE a.is_group = false GROUP BY a.code, a.name, a.account_type ORDER BY a.code`.execute(trx);
      let td = 0n, tc = 0n, cd = 0n, cc = 0n; const rows = [];
      for (const x of r.rows) {
        const od = BigInt(x.open_d), oc = BigInt(x.open_c), d = BigInt(x.d), c = BigInt(x.c);
        if (od === 0n && oc === 0n && d === 0n && c === 0n) continue;
        const open = od - oc, close = open + d - c;
        td += d; tc += c; cd += close > 0n ? close : 0n; cc += close < 0n ? -close : 0n;
        rows.push({ code: x.code, name: x.name, type: x.type, openingDr: dec(open > 0n ? open : 0n, cur), openingCr: dec(open < 0n ? -open : 0n, cur), debit: dec(d, cur), credit: dec(c, cur), closingDr: dec(close > 0n ? close : 0n, cur), closingCr: dec(close < 0n ? -close : 0n, cur) });
      }
      return { currency: cur, from: q.from, to: q.to, rows, totals: { debit: dec(td, cur), credit: dec(tc, cur), closingDr: dec(cd, cur), closingCr: dec(cc, cur) }, balanced: td === tc && cd === cc };
    });
  }

  async generalLedger(q: z.infer<typeof GlQ>) {
    return this.tdb.tx(async (trx) => {
      const cur = (await this.settings(trx)).base_currency;
      const a = await trx.selectFrom('gl_account').selectAll().where('code', '=', q.account).executeTakeFirst(); if (!a) throw err(404, 'NOT_FOUND', 'No such account');
      const br = q.branchId ? sql`AND e.property_id = ${q.branchId}` : sql``; const sign = a.normal_balance === 'DEBIT' ? 1n : -1n;
      const open = await sql<{ d: string; c: string }>`SELECT coalesce(sum(e.debit_minor),0)::text AS d, coalesce(sum(e.credit_minor),0)::text AS c FROM gl_entry e WHERE e.account_id = ${a.id} AND e.posting_date < ${q.from}::date ${br}`.execute(trx);
      const ent = await sql<{ date: string; no: string; narration: string; d: string; c: string; branch: string | null; vid: string }>`SELECT e.posting_date::text AS date, v.voucher_no AS no, v.narration, e.debit_minor::text AS d, e.credit_minor::text AS c, p.name AS branch, v.id AS vid
        FROM gl_entry e JOIN voucher v ON v.tenant_id = e.tenant_id AND v.id = e.voucher_id LEFT JOIN property p ON p.tenant_id = e.tenant_id AND p.id = e.property_id
        WHERE e.account_id = ${a.id} AND e.posting_date BETWEEN ${q.from}::date AND ${q.to}::date ${br} ORDER BY e.posting_date, v.voucher_no, e.id`.execute(trx);
      const opening = (BigInt(open.rows[0]!.d) - BigInt(open.rows[0]!.c)) * sign; let run = opening;
      const rows = ent.rows.map((x) => { run += (BigInt(x.d) - BigInt(x.c)) * sign; return { date: x.date, voucherNo: x.no, voucherId: x.vid, narration: x.narration, branch: x.branch ?? 'Head office', debit: dec(x.d, cur), credit: dec(x.c, cur), balance: dec(run, cur) }; });
      return { currency: cur, account: { code: a.code, name: a.name, normalBalance: a.normal_balance }, from: q.from, to: q.to, opening: dec(opening, cur), closing: dec(run, cur), rows };
    });
  }
}

@Controller('v1/finance')
export class FinanceController {
  constructor(@Inject(FinanceService) private readonly svc: FinanceService) {}
  private me() { return currentTenant().actorId!; }
  @Get('accounts') @RequirePermission('finance.view', ANY) accounts() { return this.svc.accounts(); }
  @Post('accounts') @RequirePermission('finance.setup', ANY) addAccount(@Body() b: unknown) { return this.svc.addAccount(this.me(), parse(AccountIn, b)); }
  @Post('accounts/starter') @HttpCode(200) @RequirePermission('finance.setup', ANY) starter() { return this.svc.loadStarter(this.me()); }
  @Put('accounts/:id') @RequirePermission('finance.setup', ANY) editAccount(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.editAccount(this.me(), id, parse(AccountEdit, b)); }
  @Get('settings') @RequirePermission('finance.view', ANY) settings() { return this.svc.getSettings(); }
  @Put('settings') @RequirePermission('finance.setup', ANY) saveSettings(@Body() b: unknown) { return this.svc.saveSettings(this.me(), parse(Settings, b)); }
  @Get('vouchers') @RequirePermission('finance.view', ANY) list(@Query() q: unknown) { return this.svc.list(parse(ListQ, q)); }
  @Post('vouchers') @RequirePermission('finance.prepare', ANY) create(@Body() b: unknown) { return this.svc.create(this.me(), parse(VoucherIn, b)); }
  @Get('vouchers/:id') @RequirePermission('finance.view', ANY) get(@Param('id', new ParseUUIDPipe()) id: string) { return this.svc.get(id); }
  @Put('vouchers/:id') @RequirePermission('finance.prepare', ANY) edit(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.edit(this.me(), id, parse(VoucherIn, b)); }
  @Post('vouchers/:id/submit') @HttpCode(200) @RequirePermission('finance.prepare', ANY) submit(@Param('id', new ParseUUIDPipe()) id: string) { return this.svc.submit(this.me(), id); }
  @Post('vouchers/:id/approve') @HttpCode(200) @RequirePermission('finance.approve', ANY) approve(@Param('id', new ParseUUIDPipe()) id: string) { return this.svc.approve(this.me(), id); }
  @Post('vouchers/:id/reject') @HttpCode(200) @RequirePermission('finance.approve', ANY) reject(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.reject(this.me(), id, parse(Reject, b).reason); }
  @Post('vouchers/:id/cancel') @HttpCode(200) @RequirePermission('finance.prepare', ANY) cancel(@Param('id', new ParseUUIDPipe()) id: string) { return this.svc.cancel(this.me(), id); }
  @Post('vouchers/:id/reverse') @RequirePermission('finance.prepare', ANY) reverse(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.reverse(this.me(), id, parse(Reverse, b)); }
  @Get('periods') @RequirePermission('finance.view', ANY) periods() { return this.svc.periods(); }
  @Post('periods/:month/close') @HttpCode(200) @RequirePermission('finance.period', ANY) close(@Param('month') m: string) { return this.svc.setPeriod(this.me(), parse(month, m), 'CLOSED'); }
  @Post('periods/:month/reopen') @HttpCode(200) @RequirePermission('finance.period', ANY) reopen(@Param('month') m: string, @Body() b: unknown) { return this.svc.setPeriod(this.me(), parse(month, m), 'OPEN', parse(Period, b ?? {}).reason); }
  @Get('reports/trial-balance') @RequirePermission('finance.view', ANY) tb(@Query() q: unknown) { return this.svc.trialBalance(parse(TbQ, q)); }
  @Get('reports/general-ledger') @RequirePermission('finance.view', ANY) gl(@Query() q: unknown) { return this.svc.generalLedger(parse(GlQ, q)); }
}
