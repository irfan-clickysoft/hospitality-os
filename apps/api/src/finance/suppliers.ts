import { Body, Controller, Get, HttpException, Inject, Injectable, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { DB } from '@hos/db';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { BankingService } from './banking.js';
import { FinanceService } from './finance.js';

type Trx = Transaction<DB>;
const ANY = { anyScope: true } as const;
const err = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-20');
const amount = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 15000 or 15000.50');
const uuid = z.string().uuid();
const text = (n: number) => z.string().trim().max(n);
const mask = (v: string | null) => (v ? `•••• ${v.replace(/[^0-9A-Za-z]/g, '').slice(-4)}` : null);
const iban = z.string().trim().transform((v) => v.replace(/\s+/g, '').toUpperCase()).refine((v) => /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(v), 'This IBAN is not valid');

const SupplierIn = z.object({ name: z.string().trim().min(2).max(120), legalName: text(160).optional(), contactName: text(120).optional(), phone: text(40).optional(), email: text(160).optional(), ntn: text(30).optional(), paymentTermsDays: z.number().int().min(0).max(365).default(30), note: text(300).optional() }).strict();
const SupplierEdit = SupplierIn.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() }).strict();
const BankIn = z.object({ bankName: text(80).nullish(), accountTitle: text(120).nullish(), iban: iban.nullish(), accountNumber: z.string().trim().regex(/^[0-9A-Za-z -]{4,34}$/, 'Enter the account number as printed').nullish() }).strict();
const BillIn = z.object({ supplierId: uuid, branchId: uuid, billNo: z.string().trim().min(1).max(60), billDate: date, dueDate: date.optional(), narration: z.string().trim().min(3).max(500), lines: z.array(z.object({ account: z.string().regex(/^[0-9]{4,8}$/), amount, description: text(300).optional() }).strict()).min(1).max(50) }).strict();
const PayIn = z.object({ supplierId: uuid, branchId: uuid, date, reference: text(120).optional(), money: z.object({ kind: z.enum(['CASH', 'PETTY', 'BANK']), bankId: uuid.nullish() }).strict(), allocations: z.array(z.object({ billId: uuid, amount }).strict()).min(1).max(50) }).strict();
const BillsQ = z.object({ supplierId: uuid.optional(), unpaid: z.enum(['true', 'false']).optional() });
const LedgerQ = z.object({ supplierId: uuid, from: date, to: date });
const AgeQ = z.object({ asAt: date });

/** What the hotels owe their suppliers. A bill and a payment are vouchers, so a second person approves each; the payables account is always broken down by supplier. */
@Injectable()
export class SuppliersService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(FinanceService) private readonly fin: FinanceService, @Inject(BankingService) private readonly bank: BankingService) {}
  private cur(trx: Trx) { return this.fin.settings(trx).then((s) => s.base_currency); }

  async list() {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx); const f = (v: string) => Money.ofMinor(BigInt(v), cur).toDecimalString();
      const rows = await trx.selectFrom('supplier').selectAll().orderBy('name').execute();
      const owed = await sql<{ id: string; v: string }>`SELECT supplier_id AS id, sum(credit_minor - debit_minor)::text AS v FROM gl_entry WHERE supplier_id IS NOT NULL GROUP BY 1`.execute(trx);
      return { items: rows.map((s) => ({ id: s.id, name: s.name, legalName: s.legal_name, contactName: s.contact_name, phone: s.phone, email: s.email, ntn: s.ntn, termsDays: s.payment_terms_days, status: s.status, note: s.note, bankName: s.bank_name, accountTitle: s.account_title, iban: mask(s.iban), accountNumber: mask(s.account_number), owed: f(owed.rows.find((o) => o.id === s.id)?.v ?? '0') })) };
    });
  }
  async create(userId: string, i: z.infer<typeof SupplierIn>) {
    return this.tdb.tx(async (trx) => {
      if (await trx.selectFrom('supplier').select('id').where(sql<boolean>`lower(name) = ${i.name.toLowerCase()}`).executeTakeFirst()) throw err(409, 'SUPPLIER_EXISTS', `A supplier called “${i.name}” already exists`);
      const r = await trx.insertInto('supplier').values({ tenant_id: currentTenant().tenantId, name: i.name, legal_name: i.legalName ?? null, contact_name: i.contactName ?? null, phone: i.phone ?? null, email: i.email ?? null, ntn: i.ntn ?? null, payment_terms_days: i.paymentTermsDays, note: i.note ?? null, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'finance.supplier.add', resourceType: 'supplier', resourceId: r.id, after: { name: i.name } });
      return { id: r.id };
    });
  }
  async edit(userId: string, id: string, i: z.infer<typeof SupplierEdit>) {
    return this.tdb.tx(async (trx) => {
      const m: Record<string, unknown> = {}; const map: Record<string, string> = { name: 'name', legalName: 'legal_name', contactName: 'contact_name', phone: 'phone', email: 'email', ntn: 'ntn', paymentTermsDays: 'payment_terms_days', note: 'note', status: 'status' };
      for (const [k, c] of Object.entries(map)) if ((i as Record<string, unknown>)[k] !== undefined) m[c] = (i as Record<string, unknown>)[k];
      if (!Object.keys(m).length) return { saved: true };
      const r = await trx.updateTable('supplier').set(m as never).where('id', '=', id).returning('id').executeTakeFirst(); if (!r) throw err(404, 'NOT_FOUND', 'No such supplier');
      await this.audit.record(trx, { action: 'finance.supplier.edit', resourceType: 'supplier', resourceId: id, after: Object.keys(m).reduce((o, k) => ({ ...o, [k]: m[k] }), {}) });
      return { saved: true };
    });
  }
  async setBank(userId: string, id: string, i: z.infer<typeof BankIn>) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.updateTable('supplier').set({ bank_name: i.bankName ?? null, account_title: i.accountTitle ?? null, iban: i.iban ?? null, account_number: i.accountNumber ?? null } as never).where('id', '=', id).returning('id').executeTakeFirst(); if (!r) throw err(404, 'NOT_FOUND', 'No such supplier');
      await this.audit.record(trx, { action: 'finance.supplier.bank', resourceType: 'supplier', resourceId: id, after: { changed: true } });
      return { saved: true };
    });
  }
  async reveal(userId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const s = await trx.selectFrom('supplier').select(['iban', 'account_number', 'bank_name', 'account_title']).where('id', '=', id).executeTakeFirst(); if (!s) throw err(404, 'NOT_FOUND', 'No such supplier');
      await this.audit.record(trx, { action: 'finance.supplier.reveal', resourceType: 'supplier', resourceId: id, after: {} });
      return { bankName: s.bank_name, accountTitle: s.account_title, iban: s.iban, accountNumber: s.account_number };
    });
  }

  // ---- bills
  async addBill(userId: string, i: z.infer<typeof BillIn>) {
    const parts = await this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx);
      const s = await trx.selectFrom('supplier').select(['id', 'status', 'payment_terms_days']).where('id', '=', i.supplierId).executeTakeFirst(); if (!s) throw err(404, 'NOT_FOUND', 'No such supplier'); if (s.status !== 'ACTIVE') throw err(409, 'SUPPLIER_INACTIVE', 'This supplier is switched off');
      if (await trx.selectFrom('supplier_bill').select('id').where('supplier_id', '=', i.supplierId).where('bill_no', '=', i.billNo).executeTakeFirst()) throw err(409, 'DUPLICATE_BILL', `Invoice ${i.billNo} from this supplier is already entered`);
      const ap = await trx.selectFrom('gl_account').select('code').where('control_type', '=', 'PAYABLE').where('is_group', '=', false).where('active', '=', true).executeTakeFirst(); if (!ap) throw err(409, 'NO_CHART', 'The payables account does not exist. Load the chart of accounts first.');
      for (const l of i.lines) { const a = await trx.selectFrom('gl_account').select(['account_type']).where('code', '=', l.account).executeTakeFirst(); if (!a) throw err(400, 'ACCOUNT_UNKNOWN', `Account ${l.account} does not exist`); if (a.account_type !== 'EXPENSE' && a.account_type !== 'ASSET') throw err(400, 'ACCOUNT_KIND', `Account ${l.account} is not an expense or asset account`); }
      const total = i.lines.reduce((t, l) => t + Money.parse(l.amount, cur).minor, 0n);
      const due = i.dueDate ?? new Date(Date.parse(i.billDate) + s.payment_terms_days * 86_400_000).toISOString().slice(0, 10);
      return { ap: ap.code, total, due, cur };
    });
    const v = await this.fin.create(userId, { type: 'SBV', date: i.billDate, narration: `Bill ${i.billNo}: ${i.narration}`.slice(0, 500), lines: [
      ...i.lines.map((l) => ({ account: l.account, branchId: i.branchId, debit: l.amount, description: l.description, reference: i.billNo })),
      { account: parts.ap, branchId: i.branchId, supplierId: i.supplierId, credit: Money.ofMinor(parts.total, parts.cur).toDecimalString(), reference: i.billNo, description: `Owed to supplier` }] });
    return this.tdb.tx(async (trx) => {
      const b = await trx.insertInto('supplier_bill').values({ tenant_id: currentTenant().tenantId, supplier_id: i.supplierId, property_id: i.branchId, bill_no: i.billNo, bill_date: i.billDate, due_date: parts.due, total_minor: parts.total.toString(), voucher_id: v.id, narration: i.narration, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'finance.bill.add', resourceType: 'supplier_bill', resourceId: b.id, after: { supplier: i.supplierId, billNo: i.billNo, total: parts.total.toString() } });
      return { id: b.id, voucherId: v.id };
    });
  }
  async bills(q: z.infer<typeof BillsQ>) {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx); const f = (v: bigint) => Money.ofMinor(v, cur).toDecimalString();
      const today = (await trx.selectFrom('property').select('business_date').orderBy('business_date', 'desc').limit(1).executeTakeFirst())?.business_date ?? new Date().toISOString().slice(0, 10);
      const rows = await sql<{ id: string; sid: string; supplier: string; branch: string; no: string; bdate: string; due: string; total: string; paid: string; pending: string; vstatus: string; vid: string; reversed: boolean; narration: string }>`
        SELECT b.id, b.supplier_id AS sid, s.name AS supplier, p.name AS branch, b.bill_no AS no, b.bill_date::text AS bdate, b.due_date::text AS due, b.total_minor::text AS total, b.paid_minor::text AS paid, b.reversed, b.narration, v.status AS vstatus, v.id AS vid,
          coalesce((SELECT sum(a.amount_minor) FROM supplier_payment_alloc a JOIN supplier_payment sp ON sp.tenant_id = a.tenant_id AND sp.id = a.payment_id JOIN voucher pv ON pv.tenant_id = sp.tenant_id AND pv.id = sp.voucher_id WHERE a.bill_id = b.id AND pv.status IN ('DRAFT','SUBMITTED','REJECTED')),0)::text AS pending
        FROM supplier_bill b JOIN supplier s ON s.tenant_id = b.tenant_id AND s.id = b.supplier_id JOIN property p ON p.tenant_id = b.tenant_id AND p.id = b.property_id JOIN voucher v ON v.tenant_id = b.tenant_id AND v.id = b.voucher_id
        WHERE v.status <> 'CANCELLED' ${q.supplierId ? sql`AND b.supplier_id = ${q.supplierId}` : sql``} ORDER BY b.due_date, b.bill_no LIMIT 500`.execute(trx);
      const items = rows.rows.map((b) => { const out = BigInt(b.total) - BigInt(b.paid); const od = b.vstatus === 'POSTED' && !b.reversed && out > 0n ? Math.max(0, Math.round((Date.parse(today) - Date.parse(b.due)) / 86_400_000)) : 0;
        return { id: b.id, supplierId: b.sid, supplier: b.supplier, branch: b.branch, billNo: b.no, billDate: b.bdate, dueDate: b.due, total: f(BigInt(b.total)), paid: f(BigInt(b.paid)), outstanding: f(b.reversed ? 0n : out), available: f(b.vstatus === 'POSTED' && !b.reversed ? out - BigInt(b.pending) : 0n), status: b.reversed ? 'REVERSED' : b.vstatus !== 'POSTED' ? b.vstatus : out === 0n ? 'PAID' : BigInt(b.paid) > 0n ? 'PART_PAID' : 'OPEN', overdueDays: od, voucherId: b.vid, narration: b.narration }; });
      return { items: q.unpaid === 'true' ? items.filter((x) => x.status === 'OPEN' || x.status === 'PART_PAID') : items };
    });
  }

  // ---- payments
  async pay(userId: string, i: z.infer<typeof PayIn>) {
    const plan = await this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx);
      const s = await trx.selectFrom('supplier').select('id').where('id', '=', i.supplierId).executeTakeFirst(); if (!s) throw err(404, 'NOT_FOUND', 'No such supplier');
      const ap = await trx.selectFrom('gl_account').select('code').where('control_type', '=', 'PAYABLE').where('is_group', '=', false).executeTakeFirstOrThrow();
      let total = 0n;
      const ids = i.allocations.map((a) => a.billId); if (new Set(ids).size !== ids.length) throw err(400, 'VALIDATION_FAILED', 'A bill appears twice');
      for (const a of i.allocations) {
        const b = (await this.bills({ supplierId: i.supplierId })).items.find((x) => x.id === a.billId); if (!b) throw err(404, 'NOT_FOUND', 'One of the bills is not this supplier\'s');
        const want = Money.parse(a.amount, cur).minor; if (want <= 0n) throw err(400, 'VALIDATION_FAILED', 'Each amount must be more than zero');
        if (b.status !== 'OPEN' && b.status !== 'PART_PAID') throw err(409, 'BILL_NOT_PAYABLE', `Bill ${b.billNo} is ${b.status === 'PAID' ? 'already paid' : 'not approved yet'}`);
        if (want > Money.parse(b.available, cur).minor) throw err(409, 'OVERPAYMENT', `Bill ${b.billNo}: only ${b.available} can still be paid`);
        const br = await trx.selectFrom('supplier_bill').select('property_id').where('id', '=', a.billId).executeTakeFirstOrThrow(); if (br.property_id !== i.branchId) throw err(409, 'USE_INTERBRANCH', `Bill ${b.billNo} belongs to another branch. Pay it from that branch, or use an inter-branch expense voucher.`);
        total += want;
      }
      return { ap: ap.code, total, cur };
    });
    const money = await this.tdb.tx((trx) => this.bank.moneyLine(trx, { ...i.money, branchId: i.branchId }));
    const amt = Money.ofMinor(plan.total, plan.cur).toDecimalString();
    const v = await this.fin.create(userId, { type: 'SPV', date: i.date, narration: `Supplier payment${i.reference ? ` ${i.reference}` : ''}`, lines: [{ account: plan.ap, branchId: i.branchId, supplierId: i.supplierId, debit: amt, reference: i.reference }, { account: money.account, branchId: i.branchId, credit: amt, reference: i.reference }] });
    return this.tdb.tx(async (trx) => {
      const p = await trx.insertInto('supplier_payment').values({ tenant_id: currentTenant().tenantId, supplier_id: i.supplierId, property_id: i.branchId, paid_on: i.date, total_minor: plan.total.toString(), reference: i.reference ?? null, voucher_id: v.id, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('supplier_payment_alloc').values(i.allocations.map((a) => ({ tenant_id: currentTenant().tenantId, payment_id: p.id, bill_id: a.billId, amount_minor: Money.parse(a.amount, plan.cur).minor.toString() })) as never).execute();
      await this.audit.record(trx, { action: 'finance.supplier.pay', resourceType: 'supplier_payment', resourceId: p.id, after: { supplier: i.supplierId, total: plan.total.toString(), bills: i.allocations.length } });
      return { id: p.id, voucherId: v.id };
    });
  }

  // ---- ledger and ageing
  async ledger(q: z.infer<typeof LedgerQ>) {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx); const f = (v: bigint) => Money.ofMinor(v, cur).toDecimalString();
      const s = await trx.selectFrom('supplier').select(['name']).where('id', '=', q.supplierId).executeTakeFirst(); if (!s) throw err(404, 'NOT_FOUND', 'No such supplier');
      const o = await sql<{ v: string }>`SELECT coalesce(sum(credit_minor - debit_minor),0)::text AS v FROM gl_entry WHERE supplier_id = ${q.supplierId} AND posting_date < ${q.from}::date`.execute(trx);
      const e = await sql<{ date: string; no: string; narration: string; d: string; c: string; ref: string | null; branch: string | null }>`SELECT e.posting_date::text AS date, v.voucher_no AS no, v.narration, e.debit_minor::text AS d, e.credit_minor::text AS c, l.reference AS ref, p.name AS branch
        FROM gl_entry e JOIN voucher v ON v.tenant_id = e.tenant_id AND v.id = e.voucher_id JOIN voucher_line l ON l.tenant_id = e.tenant_id AND l.id = e.line_id LEFT JOIN property p ON p.tenant_id = e.tenant_id AND p.id = e.property_id
        WHERE e.supplier_id = ${q.supplierId} AND e.posting_date BETWEEN ${q.from}::date AND ${q.to}::date ORDER BY e.posting_date, v.voucher_no, e.id`.execute(trx);
      let run = BigInt(o.rows[0]!.v); const opening = run;
      return { currency: cur, supplier: s.name, opening: f(opening), rows: e.rows.map((x) => { run += BigInt(x.c) - BigInt(x.d); return { date: x.date, voucherNo: x.no, narration: x.narration, reference: x.ref, branch: x.branch ?? 'Head office', billed: f(BigInt(x.c)), paid: f(BigInt(x.d)), balance: f(run) }; }), closing: f(run) };
    });
  }
  /** Outstanding bills by how long past their due date they are, for each supplier. */
  async ageing(asAt: string) {
    const all = (await this.bills({ unpaid: 'true' })).items; const cur = await this.tdb.tx((trx) => this.cur(trx));
    const bucket = (d: number) => (d <= 0 ? 0 : d <= 30 ? 1 : d <= 60 ? 2 : d <= 90 ? 3 : 4);
    const by = new Map<string, { name: string; b: bigint[] }>();
    for (const b of all) { const days = Math.round((Date.parse(asAt) - Date.parse(b.dueDate)) / 86_400_000); const e = by.get(b.supplierId) ?? { name: b.supplier, b: [0n, 0n, 0n, 0n, 0n] }; e.b[bucket(days)]! += Money.parse(b.outstanding, cur).minor; by.set(b.supplierId, e); }
    const f = (v: bigint) => Money.ofMinor(v, cur).toDecimalString(); const tot = [0n, 0n, 0n, 0n, 0n];
    const rows = [...by.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([id, e]) => { e.b.forEach((v, i) => (tot[i]! += v)); return { supplierId: id, supplier: e.name, current: f(e.b[0]!), d30: f(e.b[1]!), d60: f(e.b[2]!), d90: f(e.b[3]!), over90: f(e.b[4]!), total: f(e.b.reduce((s, v) => s + v, 0n)) }; });
    return { currency: cur, asAt, rows, totals: { current: f(tot[0]!), d30: f(tot[1]!), d60: f(tot[2]!), d90: f(tot[3]!), over90: f(tot[4]!), total: f(tot.reduce((s, v) => s + v, 0n)) } };
  }
}

@Controller('v1/finance')
export class SuppliersController {
  constructor(@Inject(SuppliersService) private readonly svc: SuppliersService) {}
  private me() { return currentTenant().actorId!; }
  @Get('suppliers') @RequirePermission('finance.view', ANY) list() { return this.svc.list(); }
  @Post('suppliers') @RequirePermission('finance.prepare', ANY) create(@Body() b: unknown) { return this.svc.create(this.me(), parse(SupplierIn, b)); }
  @Put('suppliers/:id') @RequirePermission('finance.prepare', ANY) edit(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.edit(this.me(), id, parse(SupplierEdit, b)); }
  @Put('suppliers/:id/bank') @RequirePermission('finance.bank_details', ANY) bank(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.setBank(this.me(), id, parse(BankIn, b)); }
  @Get('suppliers/:id/reveal') @RequirePermission('finance.bank_details', ANY) reveal(@Param('id', new ParseUUIDPipe()) id: string) { return this.svc.reveal(this.me(), id); }
  @Get('supplier-bills') @RequirePermission('finance.view', ANY) bills(@Query() q: unknown) { return this.svc.bills(parse(BillsQ, q)); }
  @Post('supplier-bills') @RequirePermission('finance.prepare', ANY) addBill(@Body() b: unknown) { return this.svc.addBill(this.me(), parse(BillIn, b)); }
  @Post('supplier-payments') @RequirePermission('finance.prepare', ANY) pay(@Body() b: unknown) { return this.svc.pay(this.me(), parse(PayIn, b)); }
  @Get('reports/supplier-ledger') @RequirePermission('finance.view', ANY) ledger(@Query() q: unknown) { return this.svc.ledger(parse(LedgerQ, q)); }
  @Get('reports/payables-ageing') @RequirePermission('finance.view', ANY) ageing(@Query() q: unknown) { return this.svc.ageing(parse(AgeQ, q).asAt); }
}
