import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { fmt, type Trx } from '../companies/companies.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
type Method = 'CASH' | 'BANK_TRANSFER' | 'CARD_SLIP' | 'WALLET' | 'CHEQUE';
/** The kind of account each way of paying lands in. Cash has none: it is the cashier's drawer. */
const KINDS: Record<Method, string[]> = { CASH: [], BANK_TRANSFER: ['BANK'], CHEQUE: ['BANK'], CARD_SLIP: ['CARD_CLEARING', 'GATEWAY'], WALLET: ['WALLET', 'GATEWAY'] };

@Injectable()
export class PaymentAccountsService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService) {}

  private view(a: { id: string; property_id: string | null; kind: string; name: string; bank_name: string | null; account_title: string | null; last4: string | null; owner_type: string; owner_name: string | null; currency: string; status: string; note: string | null; version: number }) {
    return { id: a.id, propertyId: a.property_id, kind: a.kind, name: a.name, bankName: a.bank_name, accountTitle: a.account_title, last4: a.last4, ownerType: a.owner_type, ownerName: a.owner_name, flagged: a.owner_type !== 'COMPANY', currency: a.currency, status: a.status, note: a.note, version: a.version };
  }
  async list(propertyId: string | null, includeClosed = false) {
    return this.tdb.tx(async (trx) => {
      let q = trx.selectFrom('payment_account').selectAll().orderBy('kind').orderBy('name');
      if (!includeClosed) q = q.where('status', '=', 'ACTIVE');
      if (propertyId) q = q.where((eb) => eb.or([eb('property_id', 'is', null), eb('property_id', '=', propertyId)]));
      return { items: (await q.execute()).map((a) => this.view(a as never)) };
    });
  }
  async create(userId: string, i: z.infer<typeof S.CreateAccount>) {
    return this.tdb.tx(async (trx) => {
      if (i.propertyId && !(await trx.selectFrom('property').select('id').where('id', '=', i.propertyId).executeTakeFirst())) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
      let a;
      try { a = await trx.insertInto('payment_account').values({ tenant_id: currentTenant().tenantId, property_id: i.propertyId ?? null, kind: i.kind, name: i.name, bank_name: i.bankName ?? null, account_title: i.accountTitle ?? null, last4: i.last4 ?? null, owner_type: i.ownerType, owner_name: i.ownerName ?? null, note: i.note ?? null, created_by: userId } as never).returningAll().executeTakeFirstOrThrow(); }
      catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE', `An account called "${i.name}" already exists`); throw e; }
      await this.audit.record(trx, { action: 'payment_account.create', resourceType: 'payment_account', resourceId: a.id, after: { name: i.name, kind: i.kind, ownerType: i.ownerType, ownerName: i.ownerName ?? null }, reasonCode: i.ownerType === 'COMPANY' ? undefined : 'NON_COMPANY_ACCOUNT' });
      return this.view(a as never);
    });
  }
  async update(userId: string, id: string, i: z.infer<typeof S.UpdateAccount>) {
    return this.tdb.tx(async (trx) => {
      const cur = await trx.selectFrom('payment_account').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment account not found' });
      if (cur.version !== i.version) throw fail(412, 'VERSION_CONFLICT', 'Someone else changed this account. Reload and try again.');
      const m: Record<string, unknown> = {};
      if (i.name !== undefined) m.name = i.name; if (i.kind !== undefined) m.kind = i.kind; if (i.propertyId !== undefined) m.property_id = i.propertyId; if (i.bankName !== undefined) m.bank_name = i.bankName; if (i.accountTitle !== undefined) m.account_title = i.accountTitle;
      if (i.last4 !== undefined) m.last4 = i.last4; if (i.ownerType !== undefined) m.owner_type = i.ownerType; if (i.ownerName !== undefined) m.owner_name = i.ownerName; if (i.note !== undefined) m.note = i.note;
      let a;
      try { a = await trx.updateTable('payment_account').set({ ...m, version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow(); }
      catch (e) { const c = (e as { code?: string }).code; if (c === '23505') throw fail(409, 'DUPLICATE', 'Another account already has that name'); if (c === '23514') throw fail(422, 'OWNER_REQUIRED', 'Say whose account this is'); throw e; }
      await this.audit.record(trx, { action: 'payment_account.update', resourceType: 'payment_account', resourceId: id, before: this.view(cur as never), after: this.view(a as never), reasonCode: a.owner_type !== 'COMPANY' || cur.owner_type !== a.owner_type ? 'NON_COMPANY_ACCOUNT' : undefined });
      return this.view(a as never);
    });
  }
  async close(userId: string, id: string, i: z.infer<typeof S.CloseAccount>) {
    return this.tdb.tx(async (trx) => {
      const cur = await trx.selectFrom('payment_account').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment account not found' });
      if (cur.version !== i.version) throw fail(412, 'VERSION_CONFLICT', 'Someone else changed this account. Reload and try again.');
      const a = await trx.updateTable('payment_account').set({ status: 'CLOSED', version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'payment_account.close', resourceType: 'payment_account', resourceId: id, before: { status: cur.status }, note: i.reason });
      return this.view(a as never);
    });
  }

  /** Picks the account a payment lands in. Cash needs none. For any other way of paying, once accounts of that kind are set up the clerk must say which — it is never guessed. */
  async resolve(trx: Trx, propertyId: string | null, method: Method, accountId: string | null | undefined, currency: string): Promise<string | null> {
    const kinds = KINDS[method];
    if (!kinds.length) { if (accountId) throw fail(422, 'PAYMENT_ACCOUNT_INVALID', 'Cash goes into the cashier’s drawer, not a bank account'); return null; }
    let cq = trx.selectFrom('payment_account').select(['id', 'name']).where('status', '=', 'ACTIVE').where('kind', 'in', kinds as never).where('currency', '=', currency);
    if (propertyId) cq = cq.where((eb) => eb.or([eb('property_id', 'is', null), eb('property_id', '=', propertyId)]));       // company payments are not tied to one property
    const cands = await cq.execute();
    if (accountId) {
      if (!cands.some((c) => c.id === accountId)) throw fail(422, 'PAYMENT_ACCOUNT_INVALID', 'That account cannot take this kind of payment at this property');
      return accountId;
    }
    if (cands.length) throw fail(422, 'PAYMENT_ACCOUNT_REQUIRED', 'Choose the account the money went into', { accounts: cands });
    return null;
  }

  /** Money received into each account over a period (and paid out of it by refunds); accounts owned by anyone but the company are flagged, and receipts with no account are listed so nothing is invisible. */
  async summary(from?: string, to?: string) {
    return this.tdb.tx(async (trx) => {
      const t = currentTenant().tenantId;
      const max = (await sql<{ d: string | null }>`SELECT max(business_date)::text AS d FROM property WHERE tenant_id = ${t}`.execute(trx)).rows[0]?.d ?? new Date().toISOString().slice(0, 10);
      const end = to ?? max; const start = from ?? `${end.slice(0, 8)}01`;
      if (end < start) throw fail(400, 'VALIDATION_FAILED', 'The end date is before the start date');
      const rows = await sql<{ account_id: string | null; source: string; method: string; n: number; money_in: string; money_out: string }>`
        SELECT account_id, source, method, count(*)::int AS n, coalesce(sum(inn),0)::text AS money_in, coalesce(sum(out),0)::text AS money_out FROM (
          SELECT p.payment_account_id AS account_id, 'GUEST' AS source, p.method, CASE WHEN p.kind <> 'REFUND' THEN p.amount_minor ELSE 0 END AS inn, CASE WHEN p.kind = 'REFUND' THEN p.amount_minor ELSE 0 END AS out
            FROM payment p WHERE p.tenant_id = ${t} AND p.status = 'CAPTURED' AND p.business_date BETWEEN ${start}::date AND ${end}::date AND p.method <> 'CASH'
          UNION ALL SELECT r.payment_account_id, 'COMPANY', r.method, r.amount_minor, 0 FROM ar_receipt r WHERE r.tenant_id = ${t} AND r.status = 'CAPTURED' AND r.received_on BETWEEN ${start}::date AND ${end}::date
          UNION ALL SELECT e.payment_account_id, 'OTA', 'BANK_TRANSFER', e.amount_minor, 0 FROM ota_receivable_event e WHERE e.tenant_id = ${t} AND e.action = 'RECEIVE' AND e.business_date BETWEEN ${start}::date AND ${end}::date
        ) x GROUP BY account_id, source, method`.execute(trx);
      const accounts = await trx.selectFrom('payment_account').selectAll().orderBy('kind').orderBy('name').execute();
      const byAcc = new Map<string | null, { in: bigint; out: bigint; n: number; sources: Record<string, bigint> }>();
      for (const r of rows.rows) {
        const e = byAcc.get(r.account_id) ?? { in: 0n, out: 0n, n: 0, sources: {} };
        e.in += BigInt(r.money_in); e.out += BigInt(r.money_out); e.n += r.n; e.sources[r.source] = (e.sources[r.source] ?? 0n) + BigInt(r.money_in); byAcc.set(r.account_id, e);
      }
      const items = accounts.filter((a) => a.status === 'ACTIVE' || byAcc.has(a.id)).map((a) => { const e = byAcc.get(a.id); return { ...this.view(a as never), count: e?.n ?? 0, in: fmt(e?.in ?? 0n), out: fmt(e?.out ?? 0n), net: fmt((e?.in ?? 0n) - (e?.out ?? 0n)), bySource: Object.fromEntries(Object.entries(e?.sources ?? {}).map(([k, v]) => [k, fmt(v)])) }; });
      const flagged = items.filter((i) => i.flagged);
      const un = byAcc.get(null);
      return { from: start, to: end, items, totalIn: fmt(items.reduce((s, i) => s + BigInt(i.in.amount.replace('.', '')), 0n)),
        nonCompany: { accounts: flagged.length, in: fmt(flagged.reduce((s, i) => s + BigInt(i.in.amount.replace('.', '')), 0n)), net: fmt(flagged.reduce((s, i) => s + BigInt(i.net.amount.replace('.', '')), 0n)) },
        unassigned: { count: un?.n ?? 0, in: fmt(un?.in ?? 0n), out: fmt(un?.out ?? 0n) } };
    });
  }
}
