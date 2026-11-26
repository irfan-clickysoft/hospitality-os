import { Body, Controller, Get, HttpException, Inject, Injectable, Post, Query } from '@nestjs/common';
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
const End = z.object({ end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31') });
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** The financial year that contains a date, for a year that starts on the first of `startMonth`. */
export function fiscalYearOf(date: string, startMonth: number): { start: string; end: string } {
  const [y, m] = date.split('-').map(Number) as [number, number]; const sy = m >= startMonth ? y : y - 1;
  const start = iso(sy, startMonth, 1); const e = new Date(Date.UTC(sy + 1, startMonth - 1, 1) - 86_400_000).toISOString().slice(0, 10);
  return { start, end: e };
}
const monthsOf = (start: string, end: string) => { const out: string[] = []; let [y, m] = start.split('-').map(Number) as [number, number]; while (iso(y, m, 1) <= end) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } } return out; };

/** Closing a financial year: every month closed, then one voucher (approved by a second person) moves the year's result to retained earnings, branch by branch. */
@Injectable()
export class YearEndService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(FinanceService) private readonly fin: FinanceService) {}

  private async today(trx: Trx) { return (await trx.selectFrom('property').select('business_date').orderBy('business_date', 'desc').limit(1).executeTakeFirst())?.business_date ?? new Date().toISOString().slice(0, 10); }

  private async check(trx: Trx, end: string) {
    const s = await this.fin.settings(trx); const fy = fiscalYearOf(end, s.fiscal_year_start_month);
    if (fy.end !== end) throw err(400, 'NOT_YEAR_END', `A year starting in month ${s.fiscal_year_start_month} ends on ${fy.end}, not ${end}.`);
    const blockers: Array<{ code: string; message: string }> = [];
    if (end >= (await this.today(trx))) blockers.push({ code: 'FY_NOT_ENDED', message: 'The year has not finished yet.' });
    const closed = new Set((await trx.selectFrom('gl_period').select('month').where('status', '=', 'CLOSED').where('month', '>=', fy.start).where('month', '<=', end).execute()).map((p) => String(p.month).slice(0, 7)));
    const open = monthsOf(fy.start, end).filter((m) => !closed.has(m)); if (open.length) blockers.push({ code: 'MONTHS_OPEN', message: `These months are still open: ${open.join(', ')}. Close each month first.` });
    if (await trx.selectFrom('voucher').select('id').where('status', '=', 'SUBMITTED').where('posting_date', '>=', fy.start).where('posting_date', '<=', end).executeTakeFirst()) blockers.push({ code: 'PENDING_VOUCHERS', message: 'Some vouchers in this year are still waiting for approval.' });
    const ex = await trx.selectFrom('fiscal_year_close as f').innerJoin('voucher as v', (j) => j.onRef('v.id', '=', 'f.voucher_id').onRef('v.tenant_id', '=', 'f.tenant_id')).select(['f.status', 'v.status as vs']).where('f.fy_end', '=', end).executeTakeFirst();
    if (ex && (ex.status === 'CLOSED' || (ex.status === 'PENDING' && ['DRAFT', 'SUBMITTED', 'POSTED'].includes(ex.vs)))) blockers.push({ code: 'ALREADY_CLOSED', message: ex.status === 'CLOSED' ? 'This year is already closed.' : 'A closing voucher for this year is already waiting for approval.' });
    return { fy, blockers };
  }
  private async result(trx: Trx, start: string, end: string) {
    return (await sql<{ code: string; name: string; pid: string | null; bal: string }>`SELECT a.code, a.name, e.property_id AS pid, sum(e.debit_minor - e.credit_minor)::text AS bal FROM gl_entry e JOIN gl_account a ON a.tenant_id = e.tenant_id AND a.id = e.account_id
      WHERE a.account_type IN ('REVENUE','EXPENSE') AND e.posting_date BETWEEN ${start}::date AND ${end}::date AND e.voucher_id NOT IN (SELECT id FROM voucher WHERE voucher_type = 'YEC') GROUP BY 1, 2, 3 HAVING sum(e.debit_minor - e.credit_minor) <> 0 ORDER BY 1`.execute(trx)).rows;
  }

  async list() {
    return this.tdb.tx(async (trx) => {
      const s = await this.fin.settings(trx); const today = await this.today(trx); const cur = fiscalYearOf(today, s.fiscal_year_start_month); const years = [cur];
      for (let i = 0; i < 2; i++) { const prev = new Date(Date.parse(years[years.length - 1]!.start) - 86_400_000).toISOString().slice(0, 10); years.push(fiscalYearOf(prev, s.fiscal_year_start_month)); }
      const out = [];
      for (const y of years) {
        const closedMonths = Number((await trx.selectFrom('gl_period').select(sql<number>`count(*)::int`.as('n')).where('status', '=', 'CLOSED').where('month', '>=', y.start).where('month', '<=', y.end).executeTakeFirstOrThrow()).n);
        const c = await trx.selectFrom('fiscal_year_close').select(['status', 'voucher_id']).where('fy_end', '=', y.end).executeTakeFirst();
        out.push({ start: y.start, end: y.end, current: y === cur, monthsClosed: closedMonths, months: monthsOf(y.start, y.end).length, status: c?.status === 'CLOSED' ? 'CLOSED' : c?.status === 'PENDING' ? 'PENDING' : 'OPEN', voucherId: c?.voucher_id ?? null });
      }
      return { startMonth: s.fiscal_year_start_month, items: out };
    });
  }
  async preview(end: string) {
    return this.tdb.tx(async (trx) => {
      const { fy, blockers } = await this.check(trx, end); const cur = (await this.fin.settings(trx)).base_currency; const rows = await this.result(trx, fy.start, fy.end);
      const names = new Map((await trx.selectFrom('property').select(['id', 'name']).execute()).map((p) => [p.id, p.name])); const by = new Map<string, bigint>(); for (const r of rows) by.set(r.pid ?? 'HO', (by.get(r.pid ?? 'HO') ?? 0n) - BigInt(r.bal));
      const f = (v: bigint) => Money.ofMinor(v, cur).toDecimalString(); const total = [...by.values()].reduce((s, v) => s + v, 0n);
      return { start: fy.start, end: fy.end, blockers, canClose: blockers.length === 0 && rows.length > 0, accounts: rows.length, result: f(total), byBranch: [...by.entries()].map(([k, v]) => ({ branch: k === 'HO' ? 'Head office' : names.get(k) ?? k, result: f(v) })) };
    });
  }
  async close(userId: string, end: string) {
    const plan = await this.tdb.tx(async (trx) => {
      const { fy, blockers } = await this.check(trx, end); if (blockers.length) throw err(409, blockers[0]!.code, blockers[0]!.message);
      const re = await trx.selectFrom('gl_account').select(['id', 'is_group', 'active']).where('code', '=', '3040').executeTakeFirst(); if (!re || re.is_group || !re.active) throw err(409, 'NO_CHART', 'Account 3040 (retained earnings) does not exist or cannot be posted to.');
      const rows = await this.result(trx, fy.start, fy.end); if (!rows.length) throw err(409, 'NOTHING_TO_CLOSE', 'There is no revenue or expense in this year to close.');
      return { fy, rows, cur: (await this.fin.settings(trx)).base_currency };
    });
    const f = (v: bigint) => Money.ofMinor(v < 0n ? -v : v, plan.cur).toDecimalString(); const lines: Array<{ account: string; branchId: string | null; debit?: string; credit?: string; description?: string }> = []; const net = new Map<string | null, bigint>();
    for (const r of plan.rows) { const b = BigInt(r.bal); lines.push(b > 0n ? { account: r.code, branchId: r.pid, credit: f(b) } : { account: r.code, branchId: r.pid, debit: f(b) }); net.set(r.pid, (net.get(r.pid) ?? 0n) - b); }
    for (const [pid, n] of net) if (n !== 0n) lines.push(n > 0n ? { account: '3040', branchId: pid, credit: f(n), description: 'Result of the year' } : { account: '3040', branchId: pid, debit: f(n), description: 'Result of the year' });
    const v = await this.fin.create(userId, { type: 'YEC', date: plan.fy.end, narration: `Year-end closing: ${plan.fy.start} to ${plan.fy.end}`, lines });
    return this.tdb.tx(async (trx) => {
      await sql`INSERT INTO fiscal_year_close (tenant_id, fy_end, fy_start, voucher_id, status, closed_by) VALUES (${currentTenant().tenantId}, ${plan.fy.end}::date, ${plan.fy.start}::date, ${v.id}, 'PENDING', ${userId})
        ON CONFLICT (tenant_id, fy_end) DO UPDATE SET voucher_id = EXCLUDED.voucher_id, status = 'PENDING', closed_by = EXCLUDED.closed_by`.execute(trx);
      await this.audit.record(trx, { action: 'finance.year.prepare', resourceType: 'fiscal_year_close', resourceId: plan.fy.end, after: { voucherId: v.id, accounts: plan.rows.length } });
      return { voucherId: v.id, start: plan.fy.start, end: plan.fy.end };
    });
  }
}

@Controller('v1/finance/year-end')
export class YearEndController {
  constructor(@Inject(YearEndService) private readonly svc: YearEndService) {}
  @Get() @RequirePermission('finance.view', ANY) list() { return this.svc.list(); }
  @Get('preview') @RequirePermission('finance.view', ANY) preview(@Query() q: unknown) { return this.svc.preview(parse(End, q).end); }
  @Post('close') @RequirePermission('finance.period', ANY) close(@Body() b: unknown) { return this.svc.close(currentTenant().actorId!, parse(End, b).end); }
}
