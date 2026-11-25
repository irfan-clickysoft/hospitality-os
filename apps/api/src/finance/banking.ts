import { Body, Controller, ForbiddenException, Get, HttpCode, HttpException, Inject, Injectable, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { DB } from '@hos/db';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission, Authenticated } from '../authz/decorators.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { parse } from '../common/validate.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { FinanceService, type VType } from './finance.js';

type Trx = Transaction<DB>;
const ANY = { anyScope: true } as const;
const err = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-20');
const amount = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 15000 or 15000.50');
const uuid = z.string().uuid();
const mask = (v: string | null) => (v ? `•••• ${v.replace(/[^0-9A-Za-z]/g, '').slice(-4)}` : null);

const BankEdit = z.object({ accountType: z.enum(['CURRENT', 'SAVINGS', 'OTHER']), purpose: z.enum(['COLLECTIONS', 'EXPENSES', 'BOTH', 'PAYROLL', 'REFUNDS', 'OTHER']), branchIds: z.array(uuid).min(1).max(50) }).strict();
const Authorise = z.object({ note: z.string().trim().min(5).max(500) }).strict();
const DrawerIn = z.object({ propertyId: uuid, kind: z.enum(['CASH', 'PETTY']), name: z.string().trim().min(2).max(80), custodianId: uuid.nullish(), openingFloat: amount.default('0'), maxLimit: amount.nullish() }).strict();
const DrawerEdit = z.object({ name: z.string().trim().min(2).max(80).optional(), custodianId: uuid.nullish(), maxLimit: amount.nullish(), active: z.boolean().optional() }).strict();
const Close = z.object({ date, counted: amount, note: z.string().trim().max(500).optional() }).strict();
const Decide = z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() }).strict();
const MoneyRef = z.object({ kind: z.enum(['CASH', 'PETTY', 'BANK']), branchId: uuid.nullish(), bankId: uuid.nullish() }).strict();
const Quick = z.object({ type: z.enum(['CRV', 'BRV', 'CPV', 'BPV', 'CTV']), date, narration: z.string().trim().min(3).max(500), amount, money: MoneyRef.optional(), other: z.string().regex(/^[0-9]{4,8}$/).optional(), from: MoneyRef.optional(), to: MoneyRef.optional() }).strict();
const ClosingsQ = z.object({ status: z.enum(['CLOSED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED']).optional() });

/** Bank accounts as the books see them (which branches use them, what for, whether they may be used), branch cash and petty cash with daily closing, and the simple cash, bank and transfer vouchers. */
@Injectable()
export class BankingService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(FinanceService) private readonly fin: FinanceService, @Inject(AuthorizationService) private readonly authz: AuthorizationService) {}

  private async accountByKey(trx: Trx, key: string, fallbackCode: string, create?: { name: string; type: string; parent: string }): Promise<{ id: string; code: string }> {
    const m = await trx.selectFrom('gl_posting_map as m').innerJoin('gl_account as a', (j) => j.onRef('a.id', '=', 'm.account_id').onRef('a.tenant_id', '=', 'm.tenant_id')).select(['a.id', 'a.code']).where('m.key', '=', key).executeTakeFirst();
    if (m) return m;
    let a = await trx.selectFrom('gl_account').select(['id', 'code']).where('code', '=', fallbackCode).where('is_group', '=', false).executeTakeFirst();
    if (!a && create) {
      const parent = await trx.selectFrom('gl_account').select('id').where('code', '=', create.parent).executeTakeFirst();
      a = await trx.insertInto('gl_account').values({ tenant_id: currentTenant().tenantId, code: fallbackCode, name: create.name, parent_id: parent?.id ?? null, account_type: create.type, normal_balance: create.type === 'EXPENSE' || create.type === 'ASSET' ? 'DEBIT' : 'CREDIT', is_group: false } as never).returning(['id', 'code']).executeTakeFirstOrThrow();
    }
    if (!a) throw err(409, 'NO_CHART', `Account ${fallbackCode} does not exist. Load the chart of accounts first.`);
    return a;
  }
  private drawerAccount(trx: Trx, kind: string) { return kind === 'PETTY' ? this.accountByKey(trx, 'PETTY', '1040') : this.accountByKey(trx, 'CASH', '1010'); }

  // ---- banks
  async banks() {
    return this.tdb.tx(async (trx) => {
      const rows = await trx.selectFrom('payment_account as p').leftJoin('gl_account as g', (j) => j.onRef('g.id', '=', 'p.gl_account_id').onRef('g.tenant_id', '=', 'p.tenant_id')).leftJoin('staff_user as u', (j) => j.onRef('u.id', '=', 'p.authorised_by').onRef('u.tenant_id', '=', 'p.tenant_id'))
        .select(['p.id', 'p.name', 'p.bank_name', 'p.branch', 'p.account_title', 'p.iban', 'p.account_number', 'p.owner_type', 'p.owner_name', 'p.account_type', 'p.purpose', 'p.authorised_at', 'p.authorisation_note', 'g.code as gl_code', 'g.name as gl_name', 'u.full_name as authorised_by', 'p.status'])
        .where('p.kind', '=', 'BANK').where('p.status', '=', 'ACTIVE').orderBy('p.name').execute();
      const maps = await trx.selectFrom('payment_account_branch as b').innerJoin('property as pr', (j) => j.onRef('pr.id', '=', 'b.property_id').onRef('pr.tenant_id', '=', 'b.tenant_id')).select(['b.payment_account_id', 'pr.id as pid', 'pr.name']).execute();
      return { items: rows.map((r) => {
        const branches = maps.filter((m) => m.payment_account_id === r.id).map((m) => ({ id: m.pid, name: m.name }));
        const ownerFlag = r.owner_type !== 'COMPANY';
        const status = !r.purpose || !r.account_type || branches.length === 0 ? 'NEEDS_SETUP' : ownerFlag && !r.authorised_at ? 'NEEDS_AUTHORISATION' : 'READY';
        return { id: r.id, name: r.name, bankName: r.bank_name, bankBranch: r.branch, accountTitle: r.account_title, iban: mask(r.iban), accountNumber: mask(r.account_number), ownerType: r.owner_type, ownerName: r.owner_name, accountType: r.account_type, purpose: r.purpose, branches,
          ledger: r.gl_code ? { code: r.gl_code, name: r.gl_name } : null, authorised: r.authorised_at ? { at: r.authorised_at, by: r.authorised_by, note: r.authorisation_note } : null, status };
      }) };
    });
  }
  async editBank(userId: string, id: string, i: z.infer<typeof BankEdit>) {
    return this.tdb.tx(async (trx) => {
      if (!(await trx.selectFrom('payment_account').select('id').where('id', '=', id).where('kind', '=', 'BANK').executeTakeFirst())) throw err(404, 'NOT_FOUND', 'No such bank account');
      for (const b of i.branchIds) if (!(await trx.selectFrom('property').select('id').where('id', '=', b).executeTakeFirst())) throw err(400, 'BRANCH_UNKNOWN', 'One of the branches does not exist');
      await trx.updateTable('payment_account').set({ account_type: i.accountType, purpose: i.purpose } as never).where('id', '=', id).execute();
      await trx.deleteFrom('payment_account_branch').where('payment_account_id', '=', id).execute();
      await trx.insertInto('payment_account_branch').values(i.branchIds.map((b) => ({ tenant_id: currentTenant().tenantId, payment_account_id: id, property_id: b })) as never).execute();
      await this.audit.record(trx, { action: 'finance.bank.setup', resourceType: 'payment_account', resourceId: id, after: { accountType: i.accountType, purpose: i.purpose, branches: i.branchIds.length } });
      return { saved: true };
    });
  }
  async authorise(userId: string, id: string, note: string) {
    return this.tdb.tx(async (trx) => {
      const b = await trx.selectFrom('payment_account').select(['owner_type', 'name']).where('id', '=', id).where('kind', '=', 'BANK').executeTakeFirst();
      if (!b) throw err(404, 'NOT_FOUND', 'No such bank account');
      if (b.owner_type === 'COMPANY') throw err(409, 'NOT_NEEDED', 'This account is in the company’s own name; it needs no authorisation');
      await trx.updateTable('payment_account').set({ authorised_by: userId, authorised_at: new Date(), authorisation_note: note } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'finance.bank.authorise', resourceType: 'payment_account', resourceId: id, after: { note }, reasonCode: 'OWNER_ACCOUNT' });
      return { authorised: true };
    });
  }
  /** Gives a bank account its own ledger account and sends PMS bank receipts for it there (instead of the suspense account). */
  async ledgerAccount(userId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const b = await trx.selectFrom('payment_account').select(['name', 'gl_account_id']).where('id', '=', id).where('kind', '=', 'BANK').executeTakeFirst();
      if (!b) throw err(404, 'NOT_FOUND', 'No such bank account'); if (b.gl_account_id) throw err(409, 'ALREADY_LINKED', 'This bank account already has a ledger account');
      const parent = await trx.selectFrom('gl_account').select('id').where('code', '=', '1100').executeTakeFirst(); if (!parent) throw err(409, 'NO_CHART', 'Load the chart of accounts first.');
      const used = new Set((await trx.selectFrom('gl_account').select('code').where('code', '>', '1100').where('code', '<', '1200').execute()).map((x) => x.code));
      let code = ''; for (let n = 1101; n < 1200; n++) if (!used.has(String(n))) { code = String(n); break; }
      if (!code) throw err(409, 'NO_FREE_CODE', 'The bank account codes 1101 to 1199 are all used');
      const a = await trx.insertInto('gl_account').values({ tenant_id: currentTenant().tenantId, code, name: `Bank – ${b.name}`.slice(0, 120), parent_id: parent.id, account_type: 'ASSET', normal_balance: 'DEBIT', is_group: false, control_type: 'BANK', created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await trx.updateTable('payment_account').set({ gl_account_id: a.id } as never).where('id', '=', id).execute();
      await trx.insertInto('gl_posting_map').values({ tenant_id: currentTenant().tenantId, key: `PAYACC:${id}`, account_id: a.id, updated_by: userId } as never).onConflict((oc) => oc.columns(['tenant_id', 'key']).doUpdateSet({ account_id: a.id } as never)).execute();
      await this.audit.record(trx, { action: 'finance.bank.ledger', resourceType: 'payment_account', resourceId: id, after: { code } });
      return { code };
    });
  }
  async reveal(userId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const b = await trx.selectFrom('payment_account').select(['iban', 'account_number', 'name']).where('id', '=', id).where('kind', '=', 'BANK').executeTakeFirst();
      if (!b) throw err(404, 'NOT_FOUND', 'No such bank account');
      await this.audit.record(trx, { action: 'finance.bank.reveal', resourceType: 'payment_account', resourceId: id, after: {} });
      return { iban: b.iban, accountNumber: b.account_number };
    });
  }

  // ---- cash and petty cash
  private async ledgerBalance(trx: Trx, accountId: string, propertyId: string, upTo: string): Promise<bigint> {
    const r = await sql<{ s: string }>`SELECT coalesce(sum(debit_minor - credit_minor),0)::text AS s FROM gl_entry WHERE account_id = ${accountId} AND property_id = ${propertyId} AND posting_date <= ${upTo}::date`.execute(trx);
    return BigInt(r.rows[0]!.s);
  }
  async drawers(propertyId?: string) {
    return this.tdb.tx(async (trx) => {
      const cur = (await this.fin.settings(trx)).base_currency;
      let q = trx.selectFrom('cash_drawer as d').innerJoin('property as p', (j) => j.onRef('p.id', '=', 'd.property_id').onRef('p.tenant_id', '=', 'd.tenant_id')).leftJoin('staff_user as u', (j) => j.onRef('u.id', '=', 'd.custodian_user_id').onRef('u.tenant_id', '=', 'd.tenant_id'))
        .select(['d.id', 'd.property_id', 'p.name as branch', 'p.business_date', 'd.kind', 'd.name', 'd.custodian_user_id', 'u.full_name as custodian', 'd.opening_float_minor', 'd.max_limit_minor', 'd.status']).where('d.status', '=', 'ACTIVE').orderBy('p.name').orderBy('d.kind');
      if (propertyId) q = q.where('d.property_id', '=', propertyId);
      const rows = await q.execute(); const out = [];
      for (const d of rows) {
        const acct = await this.drawerAccount(trx, d.kind).catch(() => null);
        const bal = acct ? await this.ledgerBalance(trx, acct.id, d.property_id, '9999-12-31') : 0n;
        const last = await trx.selectFrom('cash_closing').select(['business_date', 'status', 'variance_minor']).where('drawer_id', '=', d.id).orderBy('business_date', 'desc').limit(1).executeTakeFirst();
        out.push({ id: d.id, propertyId: d.property_id, branch: d.branch, businessDate: d.business_date, kind: d.kind, name: d.name, custodianId: d.custodian_user_id, custodian: d.custodian, openingFloat: Money.ofMinor(BigInt(d.opening_float_minor), cur).toDecimalString(), maxLimit: d.max_limit_minor ? Money.ofMinor(BigInt(d.max_limit_minor), cur).toDecimalString() : null,
          balance: Money.ofMinor(bal, cur).toDecimalString(), overLimit: !!d.max_limit_minor && bal > BigInt(d.max_limit_minor), last: last ? { date: last.business_date, status: last.status, variance: Money.ofMinor(BigInt(last.variance_minor), cur).toDecimalString() } : null });
      }
      return { items: out };
    });
  }
  async addDrawer(userId: string, i: z.infer<typeof DrawerIn>) {
    return this.tdb.tx(async (trx) => {
      const cur = (await this.fin.settings(trx)).base_currency;
      if (!(await trx.selectFrom('property').select('id').where('id', '=', i.propertyId).executeTakeFirst())) throw err(404, 'NOT_FOUND', 'No such branch');
      if (await trx.selectFrom('cash_drawer').select('id').where('property_id', '=', i.propertyId).where('kind', '=', i.kind).where('status', '=', 'ACTIVE').executeTakeFirst()) throw err(409, 'DRAWER_EXISTS', `This branch already has ${i.kind === 'PETTY' ? 'a petty cash drawer' : 'a cash drawer'}`);
      const r = await trx.insertInto('cash_drawer').values({ tenant_id: currentTenant().tenantId, property_id: i.propertyId, kind: i.kind, name: i.name, custodian_user_id: i.custodianId ?? null, opening_float_minor: Money.parse(i.openingFloat, cur).minor.toString(), max_limit_minor: i.maxLimit ? Money.parse(i.maxLimit, cur).minor.toString() : null } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'finance.drawer.add', resourceType: 'cash_drawer', resourceId: r.id, propertyId: i.propertyId, after: { kind: i.kind, name: i.name } });
      return { id: r.id };
    });
  }
  async editDrawer(userId: string, id: string, i: z.infer<typeof DrawerEdit>) {
    return this.tdb.tx(async (trx) => {
      const cur = (await this.fin.settings(trx)).base_currency; const set: Record<string, unknown> = {};
      if (i.name !== undefined) set.name = i.name; if (i.custodianId !== undefined) set.custodian_user_id = i.custodianId; if (i.maxLimit !== undefined) set.max_limit_minor = i.maxLimit ? Money.parse(i.maxLimit, cur).minor.toString() : null; if (i.active === false) set.status = 'CLOSED';
      if (!Object.keys(set).length) return { saved: true };
      const r = await trx.updateTable('cash_drawer').set(set as never).where('id', '=', id).returning('id').executeTakeFirst(); if (!r) throw err(404, 'NOT_FOUND', 'No such drawer');
      await this.audit.record(trx, { action: 'finance.drawer.edit', resourceType: 'cash_drawer', resourceId: id, after: set });
      return { saved: true };
    });
  }
  async closeDay(userId: string, id: string, i: z.infer<typeof Close>) {
    return this.tdb.tx(async (trx) => {
      const cur = (await this.fin.settings(trx)).base_currency;
      const d = await trx.selectFrom('cash_drawer').selectAll().where('id', '=', id).where('status', '=', 'ACTIVE').executeTakeFirst(); if (!d) throw err(404, 'NOT_FOUND', 'No such drawer');
      if (await trx.selectFrom('cash_closing').select('id').where('drawer_id', '=', id).where('business_date', '=', i.date).executeTakeFirst()) throw err(409, 'ALREADY_CLOSED', 'This drawer is already closed for that date');
      const acct = await this.drawerAccount(trx, d.kind);
      const expected = await this.ledgerBalance(trx, acct.id, d.property_id, i.date); const counted = Money.parse(i.counted, cur).minor; const variance = counted - expected;
      if (variance !== 0n && (i.note?.length ?? 0) < 3) throw err(400, 'EXPLANATION_REQUIRED', `The count is ${variance < 0n ? 'short' : 'over'} by ${Money.ofMinor(variance < 0n ? -variance : variance, cur).toDecimalString()}. Say why.`);
      const r = await trx.insertInto('cash_closing').values({ tenant_id: currentTenant().tenantId, drawer_id: id, business_date: i.date, expected_minor: expected.toString(), counted_minor: counted.toString(), variance_minor: variance.toString(), note: i.note ?? null, status: variance === 0n ? 'CLOSED' : 'PENDING_APPROVAL', created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'finance.cash.close', resourceType: 'cash_closing', resourceId: r.id, propertyId: d.property_id, after: { date: i.date, expected: expected.toString(), counted: counted.toString(), variance: variance.toString() } });
      return { id: r.id, expected: Money.ofMinor(expected, cur).toDecimalString(), counted: Money.ofMinor(counted, cur).toDecimalString(), variance: Money.ofMinor(variance, cur).toDecimalString(), status: variance === 0n ? 'CLOSED' : 'PENDING_APPROVAL', overLimit: !!d.max_limit_minor && counted > BigInt(d.max_limit_minor) };
    });
  }
  async closings(status?: string) {
    return this.tdb.tx(async (trx) => {
      const cur = (await this.fin.settings(trx)).base_currency;
      let q = trx.selectFrom('cash_closing as c').innerJoin('cash_drawer as d', (j) => j.onRef('d.id', '=', 'c.drawer_id').onRef('d.tenant_id', '=', 'c.tenant_id')).innerJoin('property as p', (j) => j.onRef('p.id', '=', 'd.property_id').onRef('p.tenant_id', '=', 'd.tenant_id')).leftJoin('staff_user as u', (j) => j.onRef('u.id', '=', 'c.created_by').onRef('u.tenant_id', '=', 'c.tenant_id'))
        .select(['c.id', 'c.business_date', 'p.name as branch', 'd.kind', 'd.name', 'c.expected_minor', 'c.counted_minor', 'c.variance_minor', 'c.note', 'c.status', 'c.created_by', 'u.full_name as by', 'c.decision_note']).orderBy('c.business_date', 'desc').orderBy('c.created_at', 'desc').limit(200);
      if (status) q = q.where('c.status', '=', status);
      const f = (v: string) => Money.ofMinor(BigInt(v), cur).toDecimalString();
      return { items: (await q.execute()).map((c) => ({ id: c.id, date: c.business_date, branch: c.branch, kind: c.kind, drawer: c.name, expected: f(c.expected_minor), counted: f(c.counted_minor), variance: f(c.variance_minor), note: c.note, status: c.status, by: c.by, byId: c.created_by, decisionNote: c.decision_note })) };
    });
  }
  /** A shortage or excess is only posted once a second person has looked at the explanation. */
  async decide(userId: string, id: string, i: z.infer<typeof Decide>) {
    return this.tdb.tx(async (trx) => {
      const c = await trx.selectFrom('cash_closing').selectAll().where('id', '=', id).forUpdate().executeTakeFirst(); if (!c) throw err(404, 'NOT_FOUND', 'No such closing');
      if (c.status !== 'PENDING_APPROVAL') throw err(409, 'NOT_PENDING', 'This closing is not waiting for a decision');
      if (c.created_by === userId) throw err(403, 'FINANCE_SELF_APPROVAL', 'You did this count, so someone else has to decide');
      if (!i.approve && (i.note?.length ?? 0) < 3) throw err(400, 'EXPLANATION_REQUIRED', 'Say why the explanation is not accepted');
      let voucherId: string | null = null;
      if (i.approve) {
        const d = await trx.selectFrom('cash_drawer').select(['property_id', 'kind']).where('id', '=', c.drawer_id).executeTakeFirstOrThrow();
        const cash = await this.drawerAccount(trx, d.kind); const so = await this.accountByKey(trx, 'SHORTOVER', '5210', { name: 'Cash Short and Over', type: 'EXPENSE', parent: '5000' });
        const v = BigInt(c.variance_minor); const a = v < 0n ? -v : v;
        voucherId = await this.fin.postSystem(trx, { type: 'JV', date: String(c.business_date).slice(0, 10), narration: `Cash ${v < 0n ? 'shortage' : 'excess'} at closing: ${c.note ?? ''}`.slice(0, 500), module: 'CASH_CLOSE', eventId: c.id, userId,
          lines: v < 0n ? [{ accountId: so.id, propertyId: d.property_id, debit: a, credit: 0n }, { accountId: cash.id, propertyId: d.property_id, debit: 0n, credit: a }] : [{ accountId: cash.id, propertyId: d.property_id, debit: a, credit: 0n }, { accountId: so.id, propertyId: d.property_id, debit: 0n, credit: a }] });
      }
      await trx.updateTable('cash_closing').set({ status: i.approve ? 'APPROVED' : 'REJECTED', decided_by: userId, decided_at: new Date(), decision_note: i.note ?? null, voucher_id: voucherId } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: i.approve ? 'finance.cash.approve' : 'finance.cash.reject', resourceType: 'cash_closing', resourceId: id, after: { note: i.note ?? null } });
      return { id, status: i.approve ? 'APPROVED' : 'REJECTED' };
    });
  }

  // ---- simple vouchers
  private async moneyLine(trx: Trx, m: z.infer<typeof MoneyRef>): Promise<{ account: string; branchId: string | null; ref: string }> {
    if (m.kind === 'BANK') {
      if (!m.bankId) throw err(400, 'VALIDATION_FAILED', 'Choose the bank account');
      const b = await trx.selectFrom('payment_account as p').leftJoin('gl_account as g', (j) => j.onRef('g.id', '=', 'p.gl_account_id').onRef('g.tenant_id', '=', 'p.tenant_id')).select(['g.code', 'p.name']).where('p.id', '=', m.bankId).where('p.kind', '=', 'BANK').executeTakeFirst();
      if (!b) throw err(404, 'NOT_FOUND', 'No such bank account'); if (!b.code) throw err(409, 'BANK_NO_LEDGER', `The bank account “${b.name}” has no ledger account yet. Create it under Banks.`);
      return { account: b.code, branchId: m.branchId ?? null, ref: `bank:${m.bankId}` };
    }
    if (!m.branchId) throw err(400, 'VALIDATION_FAILED', 'Choose the branch whose cash this is');
    const a = await this.drawerAccount(trx, m.kind); return { account: a.code, branchId: m.branchId, ref: `${m.kind}:${m.branchId}` };
  }
  async quick(userId: string, i: z.infer<typeof Quick>) {
    const lines = await this.tdb.tx(async (trx) => {
      if (i.type === 'CTV') {
        if (!i.from || !i.to) throw err(400, 'VALIDATION_FAILED', 'Choose where the money comes from and where it goes');
        const f = await this.moneyLine(trx, i.from), t = await this.moneyLine(trx, i.to);
        if (f.ref === t.ref) throw err(400, 'VALIDATION_FAILED', 'The money cannot move to the same place it came from');
        if (i.from.kind !== 'BANK' && i.to.kind !== 'BANK' && f.branchId !== t.branchId) throw err(409, 'USE_INTERBRANCH', 'Money moving between two branches is an inter-branch transfer, not a contra voucher.');
        return [{ account: t.account, branchId: t.branchId, debit: i.amount }, { account: f.account, branchId: f.branchId, credit: i.amount }];
      }
      if (!i.money || !i.other) throw err(400, 'VALIDATION_FAILED', 'Choose the cash or bank account and the other account');
      const wantBank = i.type === 'BRV' || i.type === 'BPV';
      if ((i.money.kind === 'BANK') !== wantBank) throw err(400, 'VALIDATION_FAILED', wantBank ? 'A bank voucher needs a bank account' : 'A cash voucher needs cash or petty cash');
      const m = await this.moneyLine(trx, i.money);
      return i.type === 'CRV' || i.type === 'BRV' ? [{ account: m.account, branchId: m.branchId, debit: i.amount }, { account: i.other, branchId: m.branchId, credit: i.amount }] : [{ account: i.other, branchId: m.branchId, debit: i.amount }, { account: m.account, branchId: m.branchId, credit: i.amount }];
    });
    return this.fin.create(userId, { type: i.type as VType, date: i.date, narration: i.narration, lines });
  }
  async mayClose(userId: string) { return (await this.authz.holdsAnywhere(userId, 'cashier.operate')) || (await this.authz.holdsAnywhere(userId, 'finance.prepare')); }
}

@Controller('v1/finance')
export class BankingController {
  constructor(@Inject(BankingService) private readonly svc: BankingService) {}
  private me() { return currentTenant().actorId!; }
  @Get('banks') @RequirePermission('finance.view', ANY) banks() { return this.svc.banks(); }
  @Put('banks/:id') @RequirePermission('finance.setup', ANY) editBank(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.editBank(this.me(), id, parse(BankEdit, b)); }
  @Post('banks/:id/authorise') @HttpCode(200) @RequirePermission('finance.bank_details', ANY) authorise(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.authorise(this.me(), id, parse(Authorise, b).note); }
  @Post('banks/:id/ledger-account') @HttpCode(200) @RequirePermission('finance.setup', ANY) ledger(@Param('id', new ParseUUIDPipe()) id: string) { return this.svc.ledgerAccount(this.me(), id); }
  @Get('banks/:id/reveal') @RequirePermission('finance.bank_details', ANY) reveal(@Param('id', new ParseUUIDPipe()) id: string) { return this.svc.reveal(this.me(), id); }
  @Get('cash/drawers') @RequirePermission('finance.view', ANY) drawers(@Query('propertyId') pid?: string) { return this.svc.drawers(pid ? parse(uuid, pid) : undefined); }
  @Post('cash/drawers') @RequirePermission('finance.setup', ANY) addDrawer(@Body() b: unknown) { return this.svc.addDrawer(this.me(), parse(DrawerIn, b)); }
  @Put('cash/drawers/:id') @RequirePermission('finance.setup', ANY) editDrawer(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.editDrawer(this.me(), id, parse(DrawerEdit, b)); }
  @Post('cash/drawers/:id/close') @Authenticated() close(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.guardClose().then(() => this.svc.closeDay(this.me(), id, parse(Close, b))); }
  @Get('cash/closings') @RequirePermission('finance.view', ANY) closings(@Query() q: unknown) { return this.svc.closings(parse(ClosingsQ, q).status); }
  @Post('cash/closings/:id/decide') @HttpCode(200) @RequirePermission('finance.approve', ANY) decide(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.decide(this.me(), id, parse(Decide, b)); }
  @Post('vouchers/quick') @RequirePermission('finance.prepare', ANY) quick(@Body() b: unknown) { return this.svc.quick(this.me(), parse(Quick, b)); }
  private async guardClose() { if (!(await this.svc.mayClose(this.me()))) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You do not have permission to close a cash drawer' }); }
}
