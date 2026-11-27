import { Body, Controller, Get, HttpException, Inject, Injectable, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { FinanceService } from './finance.js';
import { FinanceScope } from './scope.js';
import { SuppliersService } from './suppliers.js';

const ANY = { anyScope: true } as const;
const err = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-11');
const amount = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 150000');
const uuid = z.string().uuid();
const Lines = z.array(z.object({ account: z.string().regex(/^[0-9]{4,8}$/), amount, description: z.string().trim().max(300).optional() }).strict()).min(1).max(20);
const TemplateIn = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,23}$/, 'Use 2 to 24 letters, digits or dashes, like RENT-ISB'), name: z.string().trim().min(2).max(120), supplierId: uuid, branchId: uuid, frequency: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']), dayOfMonth: z.number().int().min(1).max(28), startMonth: month, endMonth: month.nullish(), narration: z.string().trim().min(3).max(300), lines: Lines }).strict();
const TemplateEdit = TemplateIn.partial().omit({ code: true }).extend({ active: z.boolean().optional() }).strict();
const DueQ = z.object({ month });
const PrepareIn = z.object({ month, lines: Lines.optional() }).strict();
const PrepareAll = z.object({ month }).strict();
const STEP = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 } as const;
const idx = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));

/** Bills that come round again: rent, internet, software. The system prepares each period's bill as a draft; someone reviews it (change the amount if this month's bill differs) and a second person approves it. */
@Injectable()
export class RecurringService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(FinanceService) private readonly fin: FinanceService, @Inject(SuppliersService) private readonly suppliers: SuppliersService, @Inject(FinanceScope) private readonly scope: FinanceScope) {}

  private isDue(t: { frequency: 'MONTHLY' | 'QUARTERLY' | 'YEARLY'; start_month: string; end_month: string | null }, m: string): boolean {
    const s = String(t.start_month).slice(0, 7); if (m < s || (t.end_month && m > String(t.end_month).slice(0, 7))) return false; return (idx(m) - idx(s)) % STEP[t.frequency] === 0;
  }
  private view(t: Record<string, any>, cur: string, extra: Record<string, unknown> = {}) {
    const lines = t.lines as Array<{ account: string; amount: string; description?: string }>; const total = lines.reduce((s, l) => s + Money.parse(l.amount, cur).minor, 0n);
    return { id: t.id, code: t.code, name: t.name, supplierId: t.supplier_id, supplier: t.supplier, branchId: t.property_id, branch: t.branch, frequency: t.frequency, dayOfMonth: t.day_of_month, startMonth: String(t.start_month).slice(0, 7), endMonth: t.end_month ? String(t.end_month).slice(0, 7) : null, narration: t.narration, lines, total: Money.ofMinor(total, cur).toDecimalString(), active: t.active, ...extra };
  }
  private async rows(trx: Parameters<Parameters<TenantDb['tx']>[0]>[0]) {
    return trx.selectFrom('recurring_expense as r').innerJoin('supplier as s', (j) => j.onRef('s.id', '=', 'r.supplier_id').onRef('s.tenant_id', '=', 'r.tenant_id')).innerJoin('property as p', (j) => j.onRef('p.id', '=', 'r.property_id').onRef('p.tenant_id', '=', 'r.tenant_id'))
      .select(['r.id', 'r.code', 'r.name', 'r.supplier_id', 's.name as supplier', 'r.property_id', 'p.name as branch', 'r.frequency', 'r.day_of_month', 'r.start_month', 'r.end_month', 'r.narration', 'r.lines', 'r.active']).orderBy('r.code').execute();
  }
  async list() {
    return this.tdb.tx(async (trx) => {
      const cur = (await this.fin.settings(trx)).base_currency; const sc = await this.scope.of('finance.view');
      const last = new Map((await sql<{ id: string; m: string }>`SELECT recurring_id AS id, max(month)::text AS m FROM recurring_expense_run GROUP BY 1`.execute(trx)).rows.map((x) => [x.id, x.m.slice(0, 7)]));
      return { items: (await this.rows(trx)).filter((t) => this.scope.allows(sc, t.property_id)).map((t) => this.view(t, cur, { lastPrepared: last.get(t.id) ?? null })) };
    });
  }
  async create(userId: string, i: z.infer<typeof TemplateIn>) {
    await this.scope.assert('finance.prepare', [i.branchId]);
    return this.tdb.tx(async (trx) => {
      if (!(await trx.selectFrom('supplier').select('id').where('id', '=', i.supplierId).where('status', '=', 'ACTIVE').executeTakeFirst())) throw err(404, 'NOT_FOUND', 'No such active supplier');
      if (!(await trx.selectFrom('property').select('id').where('id', '=', i.branchId).executeTakeFirst())) throw err(400, 'BRANCH_UNKNOWN', 'That branch does not exist');
      await this.checkLines(trx, i.lines);
      if (await trx.selectFrom('recurring_expense').select('id').where('code', '=', i.code).executeTakeFirst()) throw err(409, 'TEMPLATE_EXISTS', `A recurring expense with the code ${i.code} already exists`);
      const r = await trx.insertInto('recurring_expense').values({ tenant_id: currentTenant().tenantId, code: i.code, name: i.name, supplier_id: i.supplierId, property_id: i.branchId, frequency: i.frequency, day_of_month: i.dayOfMonth, start_month: `${i.startMonth}-01`, end_month: i.endMonth ? `${i.endMonth}-01` : null, narration: i.narration, lines: JSON.stringify(i.lines), created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'finance.recurring.add', resourceType: 'recurring_expense', resourceId: r.id, propertyId: i.branchId, after: { code: i.code, frequency: i.frequency } });
      return { id: r.id };
    });
  }
  private async checkLines(trx: Parameters<Parameters<TenantDb['tx']>[0]>[0], lines: z.infer<typeof Lines>) {
    for (const l of lines) { const a = await trx.selectFrom('gl_account').select(['account_type', 'is_group', 'active']).where('code', '=', l.account).executeTakeFirst(); if (!a || a.is_group || !a.active) throw err(400, 'ACCOUNT_UNKNOWN', `Account ${l.account} cannot be used`); if (a.account_type !== 'EXPENSE' && a.account_type !== 'ASSET') throw err(400, 'ACCOUNT_KIND', `Account ${l.account} is not an expense or asset account`); }
  }
  async edit(userId: string, id: string, i: z.infer<typeof TemplateEdit>) {
    return this.tdb.tx(async (trx) => {
      const t = await trx.selectFrom('recurring_expense').selectAll().where('id', '=', id).executeTakeFirst(); if (!t) throw err(404, 'NOT_FOUND', 'No such recurring expense');
      await this.scope.assert('finance.prepare', [t.property_id, ...(i.branchId ? [i.branchId] : [])]);
      const m: Record<string, unknown> = {}; const map: Record<string, string> = { name: 'name', supplierId: 'supplier_id', branchId: 'property_id', frequency: 'frequency', dayOfMonth: 'day_of_month', narration: 'narration', active: 'active' };
      for (const [k, c] of Object.entries(map)) if ((i as Record<string, unknown>)[k] !== undefined) m[c] = (i as Record<string, unknown>)[k];
      if (i.startMonth) m.start_month = `${i.startMonth}-01`; if (i.endMonth !== undefined) m.end_month = i.endMonth ? `${i.endMonth}-01` : null; if (i.lines) { await this.checkLines(trx, i.lines); m.lines = JSON.stringify(i.lines); }
      if (!Object.keys(m).length) return { saved: true };
      await trx.updateTable('recurring_expense').set(m as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'finance.recurring.edit', resourceType: 'recurring_expense', resourceId: id, after: Object.keys(m) });
      return { saved: true };
    });
  }
  /** The templates that fall due in a month and have no bill for it yet. */
  async due(m: string) {
    return this.tdb.tx(async (trx) => {
      const cur = (await this.fin.settings(trx)).base_currency; const sc = await this.scope.of('finance.prepare');
      const done = new Set((await trx.selectFrom('recurring_expense_run').select('recurring_id').where('month', '=', `${m}-01`).execute()).map((x) => x.recurring_id));
      return { month: m, items: (await this.rows(trx)).filter((t) => t.active && this.scope.allows(sc, t.property_id) && !done.has(t.id) && this.isDue(t as never, m)).map((t) => this.view(t, cur, { billDate: `${m}-${String(t.day_of_month).padStart(2, '0')}`, billNo: `${t.code}-${m}` })) };
    });
  }
  async prepare(userId: string, id: string, m: string, override?: z.infer<typeof Lines>) {
    const t = await this.tdb.tx(async (trx) => {
      const r = (await this.rows(trx)).find((x) => x.id === id); if (!r) throw err(404, 'NOT_FOUND', 'No such recurring expense');
      if (!r.active) throw err(409, 'TEMPLATE_OFF', 'This recurring expense is switched off'); if (!this.isDue(r as never, m)) throw err(409, 'NOT_DUE', `${r.code} does not fall due in ${m}`);
      if (await trx.selectFrom('recurring_expense_run').select('recurring_id').where('recurring_id', '=', id).where('month', '=', `${m}-01`).executeTakeFirst()) throw err(409, 'ALREADY_PREPARED', `The bill for ${m} is already prepared`);
      return r;
    });
    await this.scope.assert('finance.prepare', [t.property_id]);
    const lines = override ?? (t.lines as z.infer<typeof Lines>);
    const bill = await this.suppliers.addBill(userId, { supplierId: t.supplier_id, branchId: t.property_id, billNo: `${t.code}-${m}`, billDate: `${m}-${String(t.day_of_month).padStart(2, '0')}`, narration: t.narration, lines });
    await this.tdb.tx(async (trx) => {
      await trx.insertInto('recurring_expense_run').values({ tenant_id: currentTenant().tenantId, recurring_id: id, month: `${m}-01`, bill_id: bill.id, prepared_by: userId } as never).execute();
      await this.audit.record(trx, { action: 'finance.recurring.prepare', resourceType: 'recurring_expense', resourceId: id, propertyId: t.property_id, after: { month: m, billId: bill.id, overridden: !!override } });
    });
    return { billId: bill.id, voucherId: bill.voucherId, billNo: `${t.code}-${m}` };
  }
  async prepareAll(userId: string, m: string) {
    const due = (await this.due(m)).items; const prepared: string[] = []; const skipped: Array<{ code: string; reason: string }> = [];
    for (const t of due) { try { await this.prepare(userId, t.id, m); prepared.push(t.code); } catch (e) { skipped.push({ code: t.code, reason: e instanceof HttpException ? String((e.getResponse() as { message?: string }).message ?? e.message) : (e as Error).message }); } }
    return { month: m, prepared, skipped };
  }
}

@Controller('v1/finance/recurring')
export class RecurringController {
  constructor(@Inject(RecurringService) private readonly svc: RecurringService) {}
  private me() { return currentTenant().actorId!; }
  @Get() @RequirePermission('finance.view', ANY) list() { return this.svc.list(); }
  @Get('due') @RequirePermission('finance.prepare', ANY) due(@Query() q: unknown) { return this.svc.due(parse(DueQ, q).month); }
  @Post() @RequirePermission('finance.prepare', ANY) create(@Body() b: unknown) { return this.svc.create(this.me(), parse(TemplateIn, b)); }
  @Put(':id') @RequirePermission('finance.prepare', ANY) edit(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.edit(this.me(), id, parse(TemplateEdit, b)); }
  @Post('prepare-due') @RequirePermission('finance.prepare', ANY) all(@Body() b: unknown) { return this.svc.prepareAll(this.me(), parse(PrepareAll, b).month); }
  @Post(':id/prepare') @RequirePermission('finance.prepare', ANY) prepare(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { const x = parse(PrepareIn, b); return this.svc.prepare(this.me(), id, x.month, x.lines); }
}
