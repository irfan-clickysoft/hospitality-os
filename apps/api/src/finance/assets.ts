import { Body, Controller, Get, HttpException, Inject, Injectable, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
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
import { FinanceScope } from './scope.js';

type Trx = Transaction<DB>;
const ANY = { anyScope: true } as const;
const err = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-20');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-11');
const amount = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 150000');
const uuid = z.string().uuid();
const CATEGORIES = ['FURNITURE', 'EQUIPMENT', 'ELECTRONICS', 'VEHICLE', 'BUILDING_IMPROVEMENT', 'OTHER'] as const;
const AssetIn = z.object({ name: z.string().trim().min(2).max(120), category: z.enum(CATEGORIES), branchId: uuid, acquiredOn: date, cost: amount, salvage: amount.default('0'), lifeMonths: z.number().int().min(1).max(600), depreciateFrom: month.optional(), openingAccumulated: amount.default('0'), serialNo: z.string().trim().max(80).optional(), note: z.string().trim().max(300).optional() }).strict();
const AssetEdit = z.object({ name: z.string().trim().min(2).max(120).optional(), serialNo: z.string().trim().max(80).nullish(), note: z.string().trim().max(300).nullish() }).strict();
const Run = z.object({ month }).strict();
const Dispose = z.object({ date, proceeds: amount.default('0'), money: z.object({ kind: z.enum(['CASH', 'PETTY', 'BANK']), bankId: uuid.nullish() }).strict().optional(), reason: z.string().trim().min(3).max(300) }).strict();

const lastDay = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

/** The register of equipment, furniture and vehicles the hotels own, the monthly depreciation of each, and what happens when one is sold or scrapped. Buying an asset is recorded as usual (a bill or a payment to the asset account); registering it here is what lets it wear out. */
@Injectable()
export class AssetsService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(FinanceService) private readonly fin: FinanceService, @Inject(BankingService) private readonly bank: BankingService, @Inject(FinanceScope) private readonly scope: FinanceScope) {}

  private async cur(trx: Trx) { return (await this.fin.settings(trx)).base_currency; }
  private async account(trx: Trx, code: string, create?: { name: string; type: string; parent: string }) {
    let a = await trx.selectFrom('gl_account').select(['id', 'code', 'is_group', 'active']).where('code', '=', code).executeTakeFirst();
    if (!a && create) { const p = await trx.selectFrom('gl_account').select('id').where('code', '=', create.parent).executeTakeFirst(); a = await trx.insertInto('gl_account').values({ tenant_id: currentTenant().tenantId, code, name: create.name, parent_id: p?.id ?? null, account_type: create.type, normal_balance: create.type === 'EXPENSE' ? 'DEBIT' : 'CREDIT', is_group: false } as never).returning(['id', 'code', 'is_group', 'active']).executeTakeFirstOrThrow(); }
    if (!a || a.is_group || !a.active) throw err(409, 'NO_CHART', `Account ${code} does not exist or cannot be posted to. Load or fix the chart of accounts.`);
    return a;
  }

  async create(userId: string, i: z.infer<typeof AssetIn>) {
    return this.tdb.tx(async (trx) => {
      const s = await this.fin.settings(trx); const cur = s.base_currency; const cost = Money.parse(i.cost, cur).minor, salv = Money.parse(i.salvage, cur).minor, open = Money.parse(i.openingAccumulated, cur).minor;
      if (!(await trx.selectFrom('property').select('id').where('id', '=', i.branchId).executeTakeFirst())) throw err(400, 'BRANCH_UNKNOWN', 'That branch does not exist');
      if (cost < BigInt(s.capitalisation_threshold_minor)) throw err(409, 'ASSET_BELOW_THRESHOLD', `Items under ${Money.ofMinor(BigInt(s.capitalisation_threshold_minor), cur).toDecimalString()} are not kept as assets; they are an expense.`);
      if (salv >= cost) throw err(400, 'VALIDATION_FAILED', 'The value left at the end must be less than the cost'); if (open > cost - salv) throw err(400, 'VALIDATION_FAILED', 'Depreciation already taken cannot be more than cost less the value left at the end');
      const from = `${i.depreciateFrom ?? i.acquiredOn.slice(0, 7)}-01`;
      for (let tries = 0; tries < 4; tries++) {
        const seq = Number((await sql<{ n: number }>`SELECT coalesce(max(seq),0)::int + 1 AS n FROM fixed_asset`.execute(trx)).rows[0]!.n);
        await sql`SAVEPOINT fa_seq`.execute(trx);
        try {
          const r = await trx.insertInto('fixed_asset').values({ tenant_id: currentTenant().tenantId, seq, asset_no: `FA-${String(seq).padStart(4, '0')}`, name: i.name, category: i.category, property_id: i.branchId, acquired_on: i.acquiredOn, cost_minor: cost.toString(), salvage_minor: salv.toString(), life_months: i.lifeMonths, dep_from: from, opening_accum_minor: open.toString(), accumulated_minor: open.toString(), serial_no: i.serialNo ?? null, note: i.note ?? null, created_by: userId } as never).returning(['id', 'asset_no']).executeTakeFirstOrThrow();
          await sql`RELEASE SAVEPOINT fa_seq`.execute(trx);
          await this.audit.record(trx, { action: 'finance.asset.add', resourceType: 'fixed_asset', resourceId: r.id, propertyId: i.branchId, after: { assetNo: r.asset_no, cost: i.cost, lifeMonths: i.lifeMonths } });
          return { id: r.id, assetNo: r.asset_no };
        } catch (e) { await sql`ROLLBACK TO SAVEPOINT fa_seq`.execute(trx); if ((e as { code?: string }).code !== '23505') throw e; }
      }
      throw err(409, 'TRY_AGAIN', 'Another asset was being added at the same time. Try again.');
    });
  }
  async edit(userId: string, id: string, i: z.infer<typeof AssetEdit>) {
    return this.tdb.tx(async (trx) => {
      const m: Record<string, unknown> = {}; if (i.name !== undefined) m.name = i.name; if (i.serialNo !== undefined) m.serial_no = i.serialNo; if (i.note !== undefined) m.note = i.note;
      if (!Object.keys(m).length) return { saved: true };
      const r = await trx.updateTable('fixed_asset').set(m as never).where('id', '=', id).returning('id').executeTakeFirst(); if (!r) throw err(404, 'NOT_FOUND', 'No such asset');
      await this.audit.record(trx, { action: 'finance.asset.edit', resourceType: 'fixed_asset', resourceId: id, after: m });
      return { saved: true };
    });
  }

  private monthly(a: { cost_minor: string; salvage_minor: string; life_months: number }) { const base = BigInt(a.cost_minor) - BigInt(a.salvage_minor); const life = BigInt(a.life_months); return (2n * base + life) / (2n * life); }
  /** What an asset would be charged for a month, given what has been charged and is still waiting for approval. */
  private charge(a: { cost_minor: string; salvage_minor: string; life_months: number; dep_from: string; accumulated_minor: string }, pending: bigint, m: string): bigint {
    const idx = monthsBetween(String(a.dep_from).slice(0, 7), m); if (idx < 0) return 0n;
    const remaining = BigInt(a.cost_minor) - BigInt(a.salvage_minor) - BigInt(a.accumulated_minor) - pending; if (remaining <= 0n) return 0n;
    return idx >= a.life_months - 1 ? remaining : (() => { const c = this.monthly(a); return c > remaining ? remaining : c; })();
  }
  private async pending(trx: Trx): Promise<Map<string, bigint>> {
    const r = await sql<{ id: string; v: string }>`SELECT l.asset_id AS id, sum(l.amount_minor)::text AS v FROM depreciation_line l JOIN depreciation_run r ON r.tenant_id = l.tenant_id AND r.id = l.run_id JOIN voucher v ON v.tenant_id = r.tenant_id AND v.id = r.voucher_id WHERE NOT r.voided AND v.status IN ('DRAFT','SUBMITTED','REJECTED') GROUP BY 1`.execute(trx);
    return new Map(r.rows.map((x) => [x.id, BigInt(x.v)]));
  }

  async list() {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx); const f = (v: bigint) => Money.ofMinor(v, cur).toDecimalString(); const sc = await this.scope.of('finance.view');
      const rows = await trx.selectFrom('fixed_asset as a').innerJoin('property as p', (j) => j.onRef('p.id', '=', 'a.property_id').onRef('p.tenant_id', '=', 'a.tenant_id')).select(['a.id', 'a.asset_no', 'a.name', 'a.category', 'a.property_id', 'p.name as branch', 'a.acquired_on', 'a.cost_minor', 'a.salvage_minor', 'a.life_months', 'a.dep_from', 'a.accumulated_minor', 'a.status', 'a.disposed_on', 'a.serial_no', 'a.note', 'a.disposal_voucher_id']).orderBy('a.seq').execute();
      return { items: rows.filter((a) => this.scope.allows(sc, a.property_id)).map((a) => { const nbv = BigInt(a.cost_minor) - BigInt(a.accumulated_minor); return { id: a.id, assetNo: a.asset_no, name: a.name, category: a.category, propertyId: a.property_id, branch: a.branch, acquiredOn: a.acquired_on, cost: f(BigInt(a.cost_minor)), salvage: f(BigInt(a.salvage_minor)), lifeMonths: a.life_months, depreciateFrom: String(a.dep_from).slice(0, 7), accumulated: f(BigInt(a.accumulated_minor)), netBookValue: f(nbv), monthly: f(this.monthly(a)), status: a.status, disposedOn: a.disposed_on, serialNo: a.serial_no, note: a.note, disposalPending: !!a.disposal_voucher_id && a.status === 'IN_SERVICE' }; }) };
    });
  }
  /** The register against the ledger: they should agree, and any difference is something bought but not registered, or the other way round. */
  async summary() {
    return this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx); const f = (v: bigint) => Money.ofMinor(v, cur).toDecimalString(); const sc = await this.scope.of('finance.view');
      const reg = (await this.list()).items.filter((a) => a.status === 'IN_SERVICE'); const sum = (k: 'cost' | 'accumulated') => reg.reduce((t, a) => t + Money.parse(a[k], cur).minor, 0n);
      const bal = async (code: string) => BigInt((await sql<{ s: string }>`SELECT coalesce(sum(e.debit_minor - e.credit_minor),0)::text AS s FROM gl_entry e JOIN gl_account a ON a.tenant_id = e.tenant_id AND a.id = e.account_id WHERE a.code = ${code} ${this.scope.filter(sc, 'e.property_id')}`.execute(trx)).rows[0]!.s);
      const cost = await bal('1500'), accum = -(await bal('1590')); const rc = sum('cost'), ra = sum('accumulated');
      return { currency: cur, register: { cost: f(rc), accumulated: f(ra), netBookValue: f(rc - ra) }, ledger: { cost: f(cost), accumulated: f(accum), netBookValue: f(cost - accum) }, difference: { cost: f(cost - rc), accumulated: f(accum - ra) }, agrees: cost === rc && accum === ra };
    });
  }

  /** Prepares one voucher for the month: every asset's charge, by branch, debiting depreciation expense and crediting accumulated depreciation. A second person approves it. */
  async run(userId: string, m: string) {
    const plan = await this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx); const today = (await trx.selectFrom('property').select('business_date').orderBy('business_date', 'desc').limit(1).executeTakeFirst())?.business_date ?? new Date().toISOString().slice(0, 10);
      if (m > today.slice(0, 7)) throw err(409, 'FUTURE_MONTH', 'That month has not started yet.');
      if (await trx.selectFrom('depreciation_run').select('id').where('month', '=', `${m}-01`).where('voided', '=', false).executeTakeFirst()) throw err(409, 'RUN_EXISTS', `Depreciation for ${m} is already prepared. Cancel its voucher to prepare it again.`);
      await this.account(trx, '5180'); await this.account(trx, '1590');
      const assets = await trx.selectFrom('fixed_asset').selectAll().where('status', '=', 'IN_SERVICE').execute(); const pend = await this.pending(trx);
      const lines = assets.map((a) => ({ a, c: this.charge(a, pend.get(a.id) ?? 0n, m) })).filter((x) => x.c > 0n);
      if (!lines.length) throw err(409, 'NOTHING_TO_DEPRECIATE', `No asset has depreciation to take for ${m}.`);
      const by = new Map<string, bigint>(); for (const x of lines) by.set(x.a.property_id, (by.get(x.a.property_id) ?? 0n) + x.c);
      return { cur, lines, by };
    });
    const dec = (v: bigint) => Money.ofMinor(v, plan.cur).toDecimalString();
    const v = await this.fin.create(userId, { type: 'DEP', date: lastDay(m), narration: `Depreciation for ${m}`, lines: [...plan.by].flatMap(([b, t]) => [{ account: '5180', branchId: b, debit: dec(t), reference: `Depreciation ${m}` }, { account: '1590', branchId: b, credit: dec(t), reference: `Depreciation ${m}` }]) });
    return this.tdb.tx(async (trx) => {
      const r = await trx.insertInto('depreciation_run').values({ tenant_id: currentTenant().tenantId, month: `${m}-01`, voucher_id: v.id, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('depreciation_line').values(plan.lines.map((x) => ({ tenant_id: currentTenant().tenantId, run_id: r.id, asset_id: x.a.id, amount_minor: x.c.toString() })) as never).execute();
      await this.audit.record(trx, { action: 'finance.asset.run', resourceType: 'depreciation_run', resourceId: r.id, after: { month: m, assets: plan.lines.length, total: dec(plan.lines.reduce((t, x) => t + x.c, 0n)) } });
      return { voucherId: v.id, assets: plan.lines.length, total: dec(plan.lines.reduce((t, x) => t + x.c, 0n)) };
    });
  }

  /** Selling or scrapping an asset: take it off the cost and the accumulated depreciation, record what came in, and the gain or loss is the difference to what it was worth in the books. */
  async dispose(userId: string, id: string, i: z.infer<typeof Dispose>) {
    const plan = await this.tdb.tx(async (trx) => {
      const cur = await this.cur(trx); const a = await trx.selectFrom('fixed_asset').selectAll().where('id', '=', id).executeTakeFirst(); if (!a) throw err(404, 'NOT_FOUND', 'No such asset');
      if (a.status !== 'IN_SERVICE') throw err(409, 'ALREADY_DISPOSED', 'This asset has already been sold or scrapped'); if (a.disposal_voucher_id) throw err(409, 'DISPOSAL_PENDING', 'A disposal for this asset is already waiting for approval');
      if ((await this.pending(trx)).get(id)) throw err(409, 'DEPRECIATION_PENDING', 'Depreciation for this asset is waiting for approval. Approve or cancel it first.');
      const proceeds = Money.parse(i.proceeds, cur).minor; if (proceeds > 0n && !i.money) throw err(400, 'VALIDATION_FAILED', 'Say where the money was received');
      const gain = await this.account(trx, '4110', { name: 'Gain on Disposal of Assets', type: 'REVENUE', parent: '4000' }), loss = await this.account(trx, '5185', { name: 'Loss on Disposal of Assets', type: 'EXPENSE', parent: '5000' });
      void gain; void loss; const cost = BigInt(a.cost_minor), accum = BigInt(a.accumulated_minor);
      return { a, cur, cost, accum, proceeds };
    });
    const f = (v: bigint) => Money.ofMinor(v < 0n ? -v : v, plan.cur).toDecimalString(); const nbv = plan.cost - plan.accum; const result = plan.proceeds - nbv; const b = plan.a.property_id;
    const money = plan.proceeds > 0n ? await this.tdb.tx((trx) => this.bank.moneyLine(trx, { ...i.money!, branchId: b })) : null;
    const lines: Array<{ account: string; branchId: string; debit?: string; credit?: string; reference?: string }> = [{ account: '1500', branchId: b, credit: f(plan.cost), reference: plan.a.asset_no }];
    if (plan.accum > 0n) lines.push({ account: '1590', branchId: b, debit: f(plan.accum), reference: plan.a.asset_no });
    if (money) lines.push({ account: money.account, branchId: b, debit: f(plan.proceeds), reference: plan.a.asset_no });
    if (result > 0n) lines.push({ account: '4110', branchId: b, credit: f(result), reference: plan.a.asset_no }); if (result < 0n) lines.push({ account: '5185', branchId: b, debit: f(result), reference: plan.a.asset_no });
    const v = await this.fin.create(userId, { type: 'DSP', date: i.date, narration: `Disposal of ${plan.a.asset_no} ${plan.a.name}: ${i.reason}`.slice(0, 500), lines });
    return this.tdb.tx(async (trx) => {
      await trx.updateTable('fixed_asset').set({ disposal_voucher_id: v.id } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'finance.asset.dispose', resourceType: 'fixed_asset', resourceId: id, propertyId: b, after: { voucherId: v.id, proceeds: i.proceeds, result: result.toString() } });
      return { voucherId: v.id, gainOrLoss: Money.ofMinor(result, plan.cur).toDecimalString() };
    });
  }
}

@Controller('v1/finance/assets')
export class AssetsController {
  constructor(@Inject(AssetsService) private readonly svc: AssetsService) {}
  private me() { return currentTenant().actorId!; }
  @Get() @RequirePermission('finance.view', ANY) list() { return this.svc.list(); }
  @Get('summary') @RequirePermission('finance.view', ANY) summary() { return this.svc.summary(); }
  @Post() @RequirePermission('finance.setup') create(@Body() b: unknown) { return this.svc.create(this.me(), parse(AssetIn, b)); }
  @Put(':id') @RequirePermission('finance.setup') edit(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.edit(this.me(), id, parse(AssetEdit, b)); }
  @Post('depreciation') @RequirePermission('finance.prepare') run(@Body() b: unknown) { return this.svc.run(this.me(), parse(Run, b).month); }
  @Post(':id/dispose') @RequirePermission('finance.prepare', ANY) dispose(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.dispose(this.me(), id, parse(Dispose, b)); }
}
