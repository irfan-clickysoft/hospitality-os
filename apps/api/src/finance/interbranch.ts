import { Body, Controller, Get, HttpException, Inject, Injectable, Post, Query } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { Money } from '@hos/domain-types';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { BankingService } from './banking.js';
import { FinanceService } from './finance.js';
import { FinanceScope } from './scope.js';

const ANY = { anyScope: true } as const;
const err = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-20');
const amount = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 15000 or 15000.50');
const uuid = z.string().uuid();
const MoneyRef = z.object({ kind: z.enum(['CASH', 'PETTY', 'BANK']), bankId: uuid.nullish() }).strict();
const Transfer = z.object({ date, narration: z.string().trim().min(3).max(500), amount, fromBranchId: uuid, from: MoneyRef, toBranchId: uuid, to: MoneyRef }).strict();
const Expense = z.object({ date, narration: z.string().trim().min(3).max(500), amount, paidByBranchId: uuid, paidWith: MoneyRef, expenseBranchId: uuid, expenseAccount: z.string().regex(/^[0-9]{4,8}$/), vendor: z.string().trim().min(2).max(120), invoiceNo: z.string().trim().max(60).optional() }).strict();
const MatrixQ = z.object({ to: date });
const ItemsQ = z.object({ branchId: uuid, counterpartyId: uuid, to: date.optional() });

/** One branch paying or sending money on another's behalf. The two branches each get their own balanced pair of entries, tied together by the voucher, so a branch's books always balance on their own. */
@Injectable()
export class InterBranchService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(FinanceService) private readonly fin: FinanceService, @Inject(BankingService) private readonly bank: BankingService, @Inject(FinanceScope) private readonly scope: FinanceScope) {}

  private async dueAccounts(): Promise<{ from: string; to: string }> {
    return this.tdb.tx(async (trx) => {
      const a = await trx.selectFrom('gl_account').select(['code', 'normal_balance']).where('control_type', '=', 'INTERBRANCH').where('is_group', '=', false).where('active', '=', true).execute();
      const from = a.find((x) => x.normal_balance === 'DEBIT')?.code, to = a.find((x) => x.normal_balance === 'CREDIT')?.code;
      if (!from || !to) throw err(409, 'NO_CHART', 'The Due From and Due To accounts do not exist. Load the chart of accounts first.');
      return { from, to };
    });
  }

  async transfer(userId: string, i: z.infer<typeof Transfer>) {
    if (i.fromBranchId === i.toBranchId) throw err(400, 'SAME_BRANCH', 'The two branches must be different. Use a cash or bank voucher inside one branch.');
    const due = await this.dueAccounts();
    const lines = await this.tdb.tx(async (trx) => {
      const f = await this.bank.moneyLine(trx, { ...i.from, branchId: i.fromBranchId }), t = await this.bank.moneyLine(trx, { ...i.to, branchId: i.toBranchId });
      return [
        { account: due.from, branchId: i.fromBranchId, counterpartyBranchId: i.toBranchId, debit: i.amount, description: 'Due from the receiving branch' }, { account: f.account, branchId: i.fromBranchId, credit: i.amount },
        { account: t.account, branchId: i.toBranchId, debit: i.amount }, { account: due.to, branchId: i.toBranchId, counterpartyBranchId: i.fromBranchId, credit: i.amount, description: 'Due to the sending branch' },
      ];
    });
    return this.fin.create(userId, { type: 'IBTV', date: i.date, narration: i.narration, lines });
  }

  async expense(userId: string, i: z.infer<typeof Expense>) {
    if (i.paidByBranchId === i.expenseBranchId) throw err(400, 'SAME_BRANCH', 'Both branches are the same. Use an ordinary payment voucher.');
    const due = await this.dueAccounts();
    const ref = [i.vendor, i.invoiceNo].filter(Boolean).join(' · ');
    const lines = await this.tdb.tx(async (trx) => {
      const p = await this.bank.moneyLine(trx, { ...i.paidWith, branchId: i.paidByBranchId });
      return [
        { account: due.from, branchId: i.paidByBranchId, counterpartyBranchId: i.expenseBranchId, debit: i.amount, description: 'Paid on behalf of the other branch', reference: ref },
        { account: p.account, branchId: i.paidByBranchId, credit: i.amount, reference: ref },
        { account: i.expenseAccount, branchId: i.expenseBranchId, debit: i.amount, description: i.narration, reference: ref },
        { account: due.to, branchId: i.expenseBranchId, counterpartyBranchId: i.paidByBranchId, credit: i.amount, description: 'Owed to the branch that paid', reference: ref },
      ];
    });
    return this.fin.create(userId, { type: 'IBEV', date: i.date, narration: i.narration, lines });
  }

  /** For every pair of branches: what each says it is owed or owes the other. They should be equal and opposite. */
  async matrix(to: string) {
    return this.tdb.tx(async (trx) => {
      const cur = (await this.fin.settings(trx)).base_currency; const f = (v: bigint) => Money.ofMinor(v, cur).toDecimalString(); const sc = await this.scope.of('finance.view');
      const r = await sql<{ a: string; b: string; net: string }>`SELECT e.property_id AS a, e.counterparty_property_id AS b, sum(e.debit_minor - e.credit_minor)::text AS net
        FROM gl_entry e JOIN gl_account g ON g.tenant_id = e.tenant_id AND g.id = e.account_id WHERE g.control_type = 'INTERBRANCH' AND e.counterparty_property_id IS NOT NULL AND e.posting_date <= ${to}::date GROUP BY 1, 2`.execute(trx);
      const names = new Map((await trx.selectFrom('property').select(['id', 'name']).execute()).map((p) => [p.id, p.name]));
      const net = new Map(r.rows.map((x) => [`${x.a}|${x.b}`, BigInt(x.net)]));
      const pairs = new Set<string>(); for (const x of r.rows) pairs.add([x.a, x.b].sort().join('|'));
      const rows = [...pairs].map((k) => {
        const [p, q] = k.split('|') as [string, string]; const a = net.get(`${p}|${q}`) ?? 0n, b = net.get(`${q}|${p}`) ?? 0n; const diff = a + b;
        const seeA = this.scope.allows(sc, p), seeB = this.scope.allows(sc, q);
        if (!seeA && !seeB) return null;                           // a branch role sees only the pairs it is part of, and only its own side's figure
        return { a: names.get(p) ?? p, aId: p, b: names.get(q) ?? q, bId: q, aBooks: seeA ? f(a) : '—', bBooks: seeB ? f(b) : '—', difference: f(diff < 0n ? -diff : diff), status: diff === 0n ? 'AGREE' : 'DIFFERENCE' };
      }).filter((x): x is NonNullable<typeof x> => x !== null).sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
      return { currency: cur, to, rows, agree: rows.every((x) => x.status === 'AGREE') };
    });
  }

  async items(branchId: string, counterpartyId: string, to?: string) {
    await this.scope.assert('finance.view', [branchId]);
    return this.tdb.tx(async (trx) => {
      const cur = (await this.fin.settings(trx)).base_currency; const f = (v: string) => Money.ofMinor(BigInt(v), cur).toDecimalString();
      const r = await sql<{ date: string; no: string; vid: string; narration: string; d: string; c: string; code: string }>`SELECT e.posting_date::text AS date, v.voucher_no AS no, v.id AS vid, v.narration, e.debit_minor::text AS d, e.credit_minor::text AS c, g.code
        FROM gl_entry e JOIN gl_account g ON g.tenant_id = e.tenant_id AND g.id = e.account_id JOIN voucher v ON v.tenant_id = e.tenant_id AND v.id = e.voucher_id
        WHERE g.control_type = 'INTERBRANCH' AND e.property_id = ${branchId} AND e.counterparty_property_id = ${counterpartyId} ${to ? sql`AND e.posting_date <= ${to}::date` : sql``} ORDER BY e.posting_date, v.voucher_no`.execute(trx);
      let run = 0n;
      return { currency: cur, items: r.rows.map((x) => { run += BigInt(x.d) - BigInt(x.c); return { date: x.date, voucherNo: x.no, voucherId: x.vid, narration: x.narration, account: x.code, debit: f(x.d), credit: f(x.c), balance: Money.ofMinor(run, cur).toDecimalString() }; }), balance: Money.ofMinor(run, cur).toDecimalString() };
    });
  }
}

@Controller('v1/finance/interbranch')
export class InterBranchController {
  constructor(@Inject(InterBranchService) private readonly svc: InterBranchService) {}
  private me() { return currentTenant().actorId!; }
  @Post('transfer') @RequirePermission('finance.prepare', ANY) transfer(@Body() b: unknown) { return this.svc.transfer(this.me(), parse(Transfer, b)); }
  @Post('expense') @RequirePermission('finance.prepare', ANY) expense(@Body() b: unknown) { return this.svc.expense(this.me(), parse(Expense, b)); }
  @Get('matrix') @RequirePermission('finance.view', ANY) matrix(@Query() q: unknown) { return this.svc.matrix(parse(MatrixQ, q).to); }
  @Get('items') @RequirePermission('finance.view', ANY) items(@Query() q: unknown) { const r = parse(ItemsQ, q); return this.svc.items(r.branchId, r.counterpartyId, r.to); }
}
