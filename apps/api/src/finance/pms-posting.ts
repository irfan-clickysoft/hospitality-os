import { Body, Controller, Get, HttpCode, HttpException, Inject, Injectable, Param, Post, Put, Query } from '@nestjs/common';
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

/** Where each kind of PMS money lands by default, as account codes of the standard hotel chart. */
export const DEFAULT_MAP: Record<string, { code: string; label: string }> = {
  GUEST_LEDGER: { code: '1250', label: 'What in-house guests owe (guest ledger)' }, ADVANCE: { code: '2100', label: 'Money guests paid before it was earned (advances)' },
  CASH: { code: '1010', label: 'Cash received' }, CARD: { code: '2130', label: 'Card payments (until the bank settles)' }, WALLET: { code: '2130', label: 'Wallet payments (until settled)' }, BANK_TRANSFER: { code: '1800', label: 'Bank transfers to an account not yet mapped' },
  AR: { code: '1200', label: 'Billed to a company (receivable)' }, OTA: { code: '1210', label: 'Billed to an online travel agent (receivable)' }, TAX: { code: '2140', label: 'Tax charged to guests' }, WHT: { code: '1310', label: 'Tax withheld by a company paying us' },
  'REV:ROOM': { code: '4010', label: 'Room charges' }, 'REV:ROOM_EXTRAS': { code: '4030', label: 'Extra person, bed, meals' }, 'REV:FNB': { code: '4060', label: 'Food and beverage' }, 'REV:FNB_DIGITAL': { code: '4060', label: 'Food and beverage (paid digitally)' },
  'REV:LAUNDRY': { code: '4040', label: 'Laundry' }, 'REV:TRANSPORT_OWNED': { code: '4070', label: 'Transport (our vehicle)' }, 'REV:TRANSPORT_THIRDPARTY': { code: '4070', label: 'Transport (hired)' }, 'REV:MINIBAR': { code: '4080', label: 'Minibar' },
  'REV:MISC': { code: '4080', label: 'Miscellaneous' }, 'REV:HALL': { code: '4080', label: 'Conference room hire' }, 'REV:CANCEL_FEE': { code: '4090', label: 'Late cancellation fees' }, 'REV:NOSHOW_FEE': { code: '4090', label: 'No-show fees' }, 'REV:DEFAULT': { code: '4080', label: 'Any other charge' },
};
const KEY = /^(GUEST_LEDGER|ADVANCE|CASH|CARD|WALLET|BANK_TRANSFER|AR|OTA|TAX|WHT|REV:[A-Z_]+|PAYACC:[0-9a-f-]{36})$/;
const Enable = z.object({ from: date }).strict();
const MapIn = z.object({ account: z.string().regex(/^[0-9]{4,8}$/).nullable() }).strict();
const RangeQ = z.object({ from: date, to: date });

interface PRow { id: string; property_id: string; folio_id: string; posting_type: string; txn_code: string; description: string | null; amount_minor: string; business_date: string; reverses_posting_id: string | null; parent_posting_id: string | null; payment_id: string | null }

/** Turns what the PMS already records into balanced ledger entries, in the same transaction, once per source event. A failure never blocks the hotel: it goes to the exceptions list. */
@Injectable()
export class PmsPostingService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(FinanceService) private readonly fin: FinanceService) {}

  private async from(trx: Trx): Promise<string | null> { return (await trx.selectFrom('gl_settings').select('pms_posting_from').executeTakeFirst())?.pms_posting_from ?? null; }
  private async exception(trx: Trx, module: string, eventId: string, propertyId: string | null, reason: string) {
    await sql`INSERT INTO finance_exception (tenant_id, property_id, source_module, source_event_id, reason) VALUES (${currentTenant().tenantId}, ${propertyId}, ${module}, ${eventId}, ${reason.slice(0, 400)})
      ON CONFLICT (tenant_id, source_module, source_event_id) DO UPDATE SET reason = EXCLUDED.reason, attempts = finance_exception.attempts + 1, status = 'OPEN', resolved_at = NULL`.execute(trx);
  }
  private async guarded(trx: Trx, module: string, eventId: string, propertyId: string | null, fn: () => Promise<void>) {
    await sql`SAVEPOINT pms_post`.execute(trx);
    try { await fn(); await sql`RELEASE SAVEPOINT pms_post`.execute(trx); }
    catch (e) {
      await sql`ROLLBACK TO SAVEPOINT pms_post`.execute(trx);
      await this.exception(trx, module, eventId, propertyId, e instanceof HttpException ? String((e.getResponse() as { message?: string }).message ?? e.message) : (e as Error).message);
    }
  }
  private async account(trx: Trx, key: string): Promise<string> {
    const r = await trx.selectFrom('gl_posting_map').select('account_id').where('key', '=', key).executeTakeFirst();
    if (!r) throw err(409, 'NOT_MAPPED', `No ledger account is set for “${DEFAULT_MAP[key]?.label ?? key}”. Set it under Finance → PMS posting.`);
    return r.account_id;
  }

  /** Called right after any guest-folio entry is written. */
  async onFolioPosting(trx: Trx, postingId: string): Promise<void> {
    const from = await this.from(trx); if (!from) return;
    const p = await trx.selectFrom('folio_posting').select(['id', 'property_id', 'folio_id', 'posting_type', 'txn_code', 'description', 'amount_minor', 'business_date', 'reverses_posting_id', 'parent_posting_id', 'payment_id']).where('id', '=', postingId).executeTakeFirst() as PRow | undefined;
    if (!p || p.business_date < from) return;
    await this.guarded(trx, 'PMS_FOLIO', p.id, p.property_id, () => this.postFolio(trx, p));
  }

  private async revenueKey(trx: Trx, txn: string, parentId: string | null): Promise<string> {
    let t = txn;
    if (t === 'ROOM_DISCOUNT') t = 'ROOM';
    else if (t === 'DISCOUNT' && parentId) t = (await trx.selectFrom('folio_posting').select('txn_code').where('id', '=', parentId).executeTakeFirst())?.txn_code ?? 'DEFAULT';
    const k = `REV:${t}`;
    return (await trx.selectFrom('gl_posting_map').select('key').where('key', '=', k).executeTakeFirst()) ? k : 'REV:DEFAULT';
  }
  private async moneyKey(trx: Trx, paymentId: string | null): Promise<string> {
    const pay = paymentId ? await trx.selectFrom('payment').select(['method', 'payment_account_id']).where('id', '=', paymentId).executeTakeFirst() : null;
    if (!pay) return 'CASH';
    if (pay.payment_account_id && (await trx.selectFrom('gl_posting_map').select('key').where('key', '=', `PAYACC:${pay.payment_account_id}`).executeTakeFirst())) return `PAYACC:${pay.payment_account_id}`;
    return pay.method === 'CASH' ? 'CASH' : pay.method === 'CARD_SLIP' ? 'CARD' : pay.method === 'WALLET' ? 'WALLET' : 'BANK_TRANSFER';
  }

  private async postFolio(trx: Trx, p: PRow) {
    let type = p.posting_type, txn = p.txn_code, paymentId = p.payment_id, parentId = p.parent_posting_id;
    if (type === 'REVERSAL' && p.reverses_posting_id) {                     // a reversal lands where the original did, the other way round
      const o = await trx.selectFrom('folio_posting').select(['posting_type', 'txn_code', 'payment_id', 'parent_posting_id']).where('id', '=', p.reverses_posting_id).executeTakeFirst();
      if (o) { type = o.posting_type; txn = o.txn_code; paymentId = o.payment_id ?? paymentId; parentId = o.parent_posting_id; }
    }
    const a = BigInt(p.amount_minor); if (a === 0n) return;
    const f = await trx.selectFrom('folio').select(['folio_no']).where('id', '=', p.folio_id).executeTakeFirstOrThrow();
    const total = BigInt((await sql<{ s: string }>`SELECT coalesce(sum(amount_minor),0)::text AS s FROM folio_posting WHERE folio_id = ${p.folio_id}`.execute(trx)).rows[0]!.s);
    const before = total - a;                                                    // the folio balance just before this entry (it is the newest)
    const pos = (x: bigint) => (x > 0n ? x : 0n);
    const d1250 = pos(before + a) - pos(before);                                // growth in what guests owe
    const d2100 = pos(-(before + a)) - pos(-before);                            // growth in what we hold for guests in advance
    let counter: string;
    if (type === 'TAX') counter = 'TAX';
    else if (type === 'PAYMENT' || type === 'DEPOSIT_RECEIVED' || type === 'REFUND') counter = txn === 'AR_TRANSFER' ? 'AR' : txn === 'OTA_TRANSFER' ? 'OTA' : await this.moneyKey(trx, paymentId);
    else counter = await this.revenueKey(trx, txn, parentId);
    const want: Array<[string, bigint]> = [['GUEST_LEDGER', d1250], ['ADVANCE', -d2100], [counter, -a]];   // debit-positive
    const lines: Array<{ accountId: string; propertyId: string | null; debit: bigint; credit: bigint; description: string | null; reference: string | null }> = [];
    for (const [key, v] of want) { if (v === 0n) continue; lines.push({ accountId: await this.account(trx, key), propertyId: p.property_id, debit: v > 0n ? v : 0n, credit: v < 0n ? -v : 0n, description: p.description, reference: f.folio_no }); }
    await this.fin.postSystem(trx, { type: 'PMS', date: p.business_date, narration: `${f.folio_no}: ${p.description ?? txn}`, module: 'PMS_FOLIO', eventId: p.id, lines });
  }

  /** A company's payment of what it was billed (verified): money in, receivable cleared, any tax it withheld shown separately. */
  async onCompanyReceipt(trx: Trx, receiptId: string): Promise<void> {
    const from = await this.from(trx); if (!from) return;
    const r = await trx.selectFrom('ar_receipt').select(['id', 'method', 'amount_minor', 'withheld_minor', 'reference', 'payment_account_id', 'received_on']).where('id', '=', receiptId).executeTakeFirst();
    if (!r || String(r.received_on).slice(0, 10) < from) return;
    await this.guarded(trx, 'PMS_AR_RECEIPT', r.id, null, async () => {
      const amt = BigInt(r.amount_minor), wht = BigInt(r.withheld_minor);
      const key = r.payment_account_id && (await trx.selectFrom('gl_posting_map').select('key').where('key', '=', `PAYACC:${r.payment_account_id}`).executeTakeFirst()) ? `PAYACC:${r.payment_account_id}` : r.method === 'WALLET' ? 'WALLET' : 'BANK_TRANSFER';
      const lines = [{ accountId: await this.account(trx, key), propertyId: null, debit: amt, credit: 0n, description: `Company payment ${r.reference}`, reference: r.reference }] as Array<{ accountId: string; propertyId: string | null; debit: bigint; credit: bigint; description: string | null; reference: string | null }>;
      if (wht > 0n) lines.push({ accountId: await this.account(trx, 'WHT'), propertyId: null, debit: wht, credit: 0n, description: 'Tax withheld by the company', reference: r.reference });
      lines.push({ accountId: await this.account(trx, 'AR'), propertyId: null, debit: 0n, credit: amt + wht, description: `Company payment ${r.reference}`, reference: r.reference });
      await this.fin.postSystem(trx, { type: 'PMS', date: String(r.received_on).slice(0, 10), narration: `Company receipt ${r.reference}`, module: 'PMS_AR_RECEIPT', eventId: r.id, lines });
    });
  }

  /** Money received from an online travel agent against a claim: money in, receivable cleared. */
  async onOtaReceipt(trx: Trx, e: { propertyId: string; eventId: string; amount: bigint; date: string; paymentAccountId: string | null; reference: string | null }): Promise<void> {
    const from = await this.from(trx); if (!from || e.date < from) return;
    await this.guarded(trx, 'PMS_OTA_RECEIPT', e.eventId, e.propertyId, async () => {
      const key = e.paymentAccountId && (await trx.selectFrom('gl_posting_map').select('key').where('key', '=', `PAYACC:${e.paymentAccountId}`).executeTakeFirst()) ? `PAYACC:${e.paymentAccountId}` : 'BANK_TRANSFER';
      await this.fin.postSystem(trx, { type: 'PMS', date: e.date, narration: `OTA receipt ${e.reference ?? ''}`.trim(), module: 'PMS_OTA_RECEIPT', eventId: e.eventId, lines: [
        { accountId: await this.account(trx, key), propertyId: e.propertyId, debit: e.amount, credit: 0n, reference: e.reference ?? null }, { accountId: await this.account(trx, 'OTA'), propertyId: e.propertyId, debit: 0n, credit: e.amount, reference: e.reference ?? null }] });
    });
  }

  // ---- setup and status
  async status() {
    return this.tdb.tx(async (trx) => {
      const s = await this.fin.settings(trx);
      const maps = await trx.selectFrom('gl_posting_map as m').innerJoin('gl_account as a', (j) => j.onRef('a.id', '=', 'm.account_id').onRef('a.tenant_id', '=', 'm.tenant_id')).select(['m.key', 'a.code', 'a.name']).execute();
      const by = new Map(maps.map((m) => [m.key, m]));
      const pa = await trx.selectFrom('payment_account').select(['id', 'name', 'bank_name', 'status']).where('status', '=', 'ACTIVE').orderBy('name').execute();
      const open = await trx.selectFrom('finance_exception').select(sql<number>`count(*)::int`.as('n')).where('status', '=', 'OPEN').executeTakeFirstOrThrow();
      return {
        enabledFrom: s.pms_posting_from ?? null, openExceptions: open.n,
        mappings: Object.entries(DEFAULT_MAP).map(([key, d]) => ({ key, label: d.label, account: by.get(key)?.code ?? null, accountName: by.get(key)?.name ?? null })),
        paymentAccounts: pa.map((x) => ({ key: `PAYACC:${x.id}`, label: `${x.name}${x.bank_name ? ` (${x.bank_name})` : ''}`, account: by.get(`PAYACC:${x.id}`)?.code ?? null, accountName: by.get(`PAYACC:${x.id}`)?.name ?? null })),
      };
    });
  }
  async enable(userId: string, from: string) {
    return this.tdb.tx(async (trx) => {
      const s = await this.fin.settings(trx);
      if (!(await trx.selectFrom('gl_account').select('id').limit(1).executeTakeFirst())) throw err(409, 'NO_CHART', 'Load the chart of accounts first.');
      const base = await trx.selectFrom('gl_account').select('id').where('code', '=', '1000').executeTakeFirst();
      if (!(await trx.selectFrom('gl_account').select('id').where('code', '=', '1250').executeTakeFirst())) {
        await trx.insertInto('gl_account').values({ tenant_id: currentTenant().tenantId, code: '1250', name: 'Guest Ledger (in-house guests)', parent_id: base?.id ?? null, account_type: 'ASSET', normal_balance: 'DEBIT', is_group: false, control_type: 'RECEIVABLE', created_by: userId } as never).execute();
      }
      let filled = 0;
      for (const [key, d] of Object.entries(DEFAULT_MAP)) {
        if (await trx.selectFrom('gl_posting_map').select('key').where('key', '=', key).executeTakeFirst()) continue;
        const a = await trx.selectFrom('gl_account').select('id').where('code', '=', d.code).where('active', '=', true).where('is_group', '=', false).executeTakeFirst();
        if (a) { await trx.insertInto('gl_posting_map').values({ tenant_id: currentTenant().tenantId, key, account_id: a.id, updated_by: userId } as never).execute(); filled++; }
      }
      await trx.updateTable('gl_settings').set({ pms_posting_from: from, updated_by: userId, updated_at: new Date() } as never).where('tenant_id', '=', s.tenant_id).execute();
      await this.audit.record(trx, { action: 'finance.pms.enable', resourceType: 'gl_settings', resourceId: currentTenant().tenantId, after: { from, mappingsFilled: filled } });
      return { enabledFrom: from, mappingsFilled: filled };
    });
  }
  async disable(userId: string) {
    return this.tdb.tx(async (trx) => {
      await this.fin.settings(trx);
      await trx.updateTable('gl_settings').set({ pms_posting_from: null, updated_by: userId, updated_at: new Date() } as never).execute();
      await this.audit.record(trx, { action: 'finance.pms.disable', resourceType: 'gl_settings', resourceId: currentTenant().tenantId, after: {} });
      return { enabledFrom: null };
    });
  }
  async setMap(userId: string, key: string, code: string | null) {
    if (!KEY.test(key)) throw err(400, 'VALIDATION_FAILED', 'That is not a kind of PMS money');
    return this.tdb.tx(async (trx) => {
      if (code === null) { await trx.deleteFrom('gl_posting_map').where('key', '=', key).execute(); }
      else {
        const a = await trx.selectFrom('gl_account').select(['id', 'is_group', 'active']).where('code', '=', code).executeTakeFirst();
        if (!a) throw err(400, 'ACCOUNT_UNKNOWN', `Account ${code} does not exist`); if (a.is_group) throw err(400, 'ACCOUNT_IS_HEADING', `Account ${code} is a heading`); if (!a.active) throw err(400, 'ACCOUNT_INACTIVE', `Account ${code} is switched off`);
        await trx.insertInto('gl_posting_map').values({ tenant_id: currentTenant().tenantId, key, account_id: a.id, updated_by: userId } as never).onConflict((oc) => oc.columns(['tenant_id', 'key']).doUpdateSet({ account_id: a.id, updated_by: userId, updated_at: new Date() } as never)).execute();
      }
      await this.audit.record(trx, { action: 'finance.pms.map', resourceType: 'gl_posting_map', resourceId: key, after: { account: code } });
      return { key, account: code };
    });
  }
  async exceptions() {
    return this.tdb.tx(async (trx) => ({ items: (await trx.selectFrom('finance_exception').selectAll().where('status', '=', 'OPEN').orderBy('created_at').limit(200).execute()).map((x) => ({ id: x.id, module: x.source_module, eventId: x.source_event_id, reason: x.reason, attempts: x.attempts, at: x.created_at })) }));
  }
  /** Tries every open exception again (after the missing account was set up). */
  async retry(userId: string) {
    return this.tdb.tx(async (trx) => {
      const open = await trx.selectFrom('finance_exception').selectAll().where('status', '=', 'OPEN').orderBy('created_at').limit(500).execute();
      let fixed = 0;
      for (const x of open) {
        await sql`SAVEPOINT pms_retry`.execute(trx);
        try {
          if (x.source_module === 'PMS_FOLIO') { const p = await trx.selectFrom('folio_posting').select(['id', 'property_id', 'folio_id', 'posting_type', 'txn_code', 'description', 'amount_minor', 'business_date', 'reverses_posting_id', 'parent_posting_id', 'payment_id']).where('id', '=', x.source_event_id).executeTakeFirst() as PRow | undefined; if (p) await this.postFolio(trx, p); }
          else if (x.source_module === 'PMS_AR_RECEIPT') { await trx.updateTable('finance_exception').set({ status: 'RESOLVED', resolved_at: new Date() } as never).where('id', '=', x.id).execute(); await this.onCompanyReceipt(trx, x.source_event_id); continue; }
          await trx.updateTable('finance_exception').set({ status: 'RESOLVED', resolved_at: new Date() } as never).where('id', '=', x.id).execute();
          await sql`RELEASE SAVEPOINT pms_retry`.execute(trx); fixed++;
        } catch (e) {
          await sql`ROLLBACK TO SAVEPOINT pms_retry`.execute(trx);
          await trx.updateTable('finance_exception').set({ reason: ((e instanceof HttpException ? String((e.getResponse() as { message?: string }).message) : (e as Error).message)).slice(0, 400), attempts: x.attempts + 1 } as never).where('id', '=', x.id).execute();
        }
      }
      await this.audit.record(trx, { action: 'finance.pms.retry', resourceType: 'finance_exception', resourceId: 'batch', after: { tried: open.length, fixed } });
      return { tried: open.length, fixed };
    });
  }
  /** Guest-folio money in the PMS against the same money in the ledger, for a period. They should agree. */
  async reconciliation(from: string, to: string) {
    return this.tdb.tx(async (trx) => {
      const s = await this.fin.settings(trx); const cur = s.base_currency; const start = s.pms_posting_from && s.pms_posting_from > from ? s.pms_posting_from : from;
      const pms = await sql<{ n: number; s: string }>`SELECT count(*)::int AS n, coalesce(sum(amount_minor),0)::text AS s FROM folio_posting WHERE business_date BETWEEN ${start}::date AND ${to}::date`.execute(trx);
      const posted = await sql<{ n: number; s: string }>`SELECT count(DISTINCT v.source_event_id)::int AS n, coalesce(sum(e.debit_minor - e.credit_minor) FILTER (WHERE a.code IN ('1250')) - sum(e.credit_minor - e.debit_minor) FILTER (WHERE a.code IN ('2100')), 0)::text AS s
        FROM voucher v JOIN gl_entry e ON e.tenant_id = v.tenant_id AND e.voucher_id = v.id JOIN gl_account a ON a.tenant_id = e.tenant_id AND a.id = e.account_id
        WHERE v.source_module = 'PMS_FOLIO' AND v.voucher_date BETWEEN ${start}::date AND ${to}::date`.execute(trx);
      const open = await trx.selectFrom('finance_exception').select(sql<number>`count(*)::int`.as('n')).where('status', '=', 'OPEN').executeTakeFirstOrThrow();
      const a = BigInt(pms.rows[0]!.s), b = BigInt(posted.rows[0]!.s);
      return { currency: cur, from: start, to, enabledFrom: s.pms_posting_from, pmsEntries: pms.rows[0]!.n, postedEntries: posted.rows[0]!.n, pmsNet: Money.ofMinor(a, cur).toDecimalString(), ledgerNet: Money.ofMinor(b, cur).toDecimalString(), difference: Money.ofMinor(a - b, cur).toDecimalString(), openExceptions: open.n, agrees: a === b && pms.rows[0]!.n === posted.rows[0]!.n };
    });
  }
}

@Controller('v1/finance/pms')
export class PmsFinanceController {
  constructor(@Inject(PmsPostingService) private readonly svc: PmsPostingService) {}
  private me() { return currentTenant().actorId!; }
  @Get() @RequirePermission('finance.view', ANY) status() { return this.svc.status(); }
  @Post('enable') @HttpCode(200) @RequirePermission('finance.setup', ANY) enable(@Body() b: unknown) { return this.svc.enable(this.me(), parse(Enable, b).from); }
  @Post('disable') @HttpCode(200) @RequirePermission('finance.setup', ANY) disable() { return this.svc.disable(this.me()); }
  @Put('map/:key') @RequirePermission('finance.setup', ANY) map(@Param('key') key: string, @Body() b: unknown) { return this.svc.setMap(this.me(), key, parse(MapIn, b).account); }
  @Get('exceptions') @RequirePermission('finance.view', ANY) exceptions() { return this.svc.exceptions(); }
  @Post('retry') @HttpCode(200) @RequirePermission('finance.setup', ANY) retry() { return this.svc.retry(this.me()); }
  @Get('reconciliation') @RequirePermission('finance.view', ANY) rec(@Query() q: unknown) { const r = parse(RangeQ, q); return this.svc.reconciliation(r.from, r.to); }
}
