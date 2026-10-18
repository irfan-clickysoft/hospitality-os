import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import type { DB } from '@hos/db';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { TenantDb } from '../db/tenant-db.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

export type Trx = Transaction<DB>;
export const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
export const fmt = (m: bigint | string | number, cur = 'PKR') => ({ amount: Money.ofMinor(BigInt(m), cur).toDecimalString(), currency: cur });
const FRESH_MFA_MS = 10 * 60 * 1000;

@Injectable()
export class CompaniesService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  requireFreshMfa() {
    const m = currentTenant().mfaVerifiedAt;
    if (!m || this.clock.now() - m.getTime() > FRESH_MFA_MS) throw new ForbiddenException({ code: 'MFA_REQUIRED', message: 'Verify your second factor (step-up) to perform this action' });
  }

  /** What each company owes: billed less money received (including tax it withheld), and how much of that is past its due date. */
  async standing(trx: Trx, ids: string[]) {
    const out = new Map<string, { billed: bigint; credited: bigint; owed: bigint; overdue: bigint }>();
    if (!ids.length) return out;
    const t = currentTenant().tenantId;
    const rows = await sql<{ company_id: string; billed: string; credited: string; overdue: string }>`
      SELECT c.id AS company_id,
        coalesce((SELECT sum(i.amount_minor) FROM ar_item i WHERE i.tenant_id = c.tenant_id AND i.company_id = c.id AND NOT EXISTS (SELECT 1 FROM ar_item_void v WHERE v.tenant_id = i.tenant_id AND v.item_id = i.id)),0)::text AS billed,
        coalesce((SELECT sum(r.amount_minor + r.withheld_minor) FROM ar_receipt r WHERE r.tenant_id = c.tenant_id AND r.company_id = c.id AND r.status = 'CAPTURED'),0)::text AS credited,
        coalesce((SELECT sum(i.amount_minor - coalesce((SELECT sum(a.applied_minor) FROM ar_allocation a WHERE a.tenant_id = i.tenant_id AND a.item_id = i.id),0))
                  FROM ar_item i JOIN property p ON p.tenant_id = i.tenant_id AND p.id = i.property_id
                  WHERE i.tenant_id = c.tenant_id AND i.company_id = c.id AND i.due_date < p.business_date AND NOT EXISTS (SELECT 1 FROM ar_item_void v WHERE v.tenant_id = i.tenant_id AND v.item_id = i.id)),0)::text AS overdue
      FROM company c WHERE c.tenant_id = ${t} AND c.id = ANY(${ids}::uuid[])`.execute(trx);
    for (const r of rows.rows) out.set(r.company_id, { billed: BigInt(r.billed), credited: BigInt(r.credited), owed: BigInt(r.billed) - BigInt(r.credited), overdue: BigInt(r.overdue) });
    return out;
  }

  view(c: Awaited<ReturnType<CompaniesService['row']>>, s?: { owed: bigint; overdue: bigint }) {
    const cur = c.currency;
    const limit = BigInt(c.credit_limit_minor);
    return { id: c.id, name: c.name, ntn: c.ntn, strn: c.strn, address: c.address, contactName: c.contact_name, contactPhone: c.contact_phone, contactEmail: c.contact_email,
      creditLimit: fmt(limit, cur), termsDays: c.terms_days, status: c.status, holdReason: c.hold_reason, notes: c.notes, version: c.version,
      ...(s ? { owed: fmt(s.owed, cur), overdue: fmt(s.overdue, cur), available: fmt(limit > s.owed ? limit - s.owed : 0n, cur) } : {}) };
  }
  async row(trx: Trx, id: string, lock = false) {
    let q = trx.selectFrom('company').selectAll().where('id', '=', id);
    if (lock) q = q.forUpdate();
    const c = await q.executeTakeFirst();
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found' });
    return c;
  }

  async list(i: z.infer<typeof S.ListCompanies>) {
    return this.tdb.tx(async (trx) => {
      let q = trx.selectFrom('company').selectAll().orderBy('name').limit(i.limit);
      q = i.status ? q.where('status', '=', i.status) : q.where('status', '<>', 'ARCHIVED');
      if (i.q) q = q.where((eb) => eb.or([eb('name', 'ilike', `%${i.q!.replace(/[%_\\]/g, '\\$&')}%`), eb('ntn', 'ilike', `${i.q!.replace(/[%_\\]/g, '\\$&')}%`)]));
      const rows = await q.execute();
      const st = await this.standing(trx, rows.map((r) => r.id));
      return { items: rows.map((r) => this.view(r, st.get(r.id))) };
    });
  }
  async get(id: string) {
    return this.tdb.tx(async (trx) => { const c = await this.row(trx, id); return this.view(c, (await this.standing(trx, [id])).get(id)); });
  }

  async create(userId: string, i: z.infer<typeof S.CreateCompany>) {
    if (i.creditLimit !== '0') this.requireFreshMfa();
    return this.tdb.tx((trx) => this.createIn(trx, userId, i));
  }
  /** Inside the caller's transaction (the bulk import creates many at once). The caller has already checked the second factor for a non-zero limit. */
  async createIn(trx: Trx, userId: string, i: z.infer<typeof S.CreateCompany>) {
    let c;
    try {
      c = await trx.insertInto('company').values({ tenant_id: currentTenant().tenantId, name: i.name, ntn: i.ntn || null, strn: i.strn || null, address: i.address || null, contact_name: i.contactName || null,
        contact_phone: i.contactPhone || null, contact_email: i.contactEmail || null, credit_limit_minor: Money.parse(i.creditLimit, 'PKR').minor.toString(), terms_days: i.termsDays, notes: i.notes || null, created_by: userId } as never).returningAll().executeTakeFirstOrThrow();
    } catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE', `A company called "${i.name}" already exists`); throw e; }
    await this.audit.record(trx, { action: 'company.create', resourceType: 'company', resourceId: c.id, after: { name: i.name, creditLimit: i.creditLimit, termsDays: i.termsDays } });
    return this.view(c, { owed: 0n, overdue: 0n });
  }

  async update(userId: string, id: string, i: z.infer<typeof S.UpdateCompany>) {
    if (i.creditLimit !== undefined || i.termsDays !== undefined) this.requireFreshMfa();
    return this.tdb.tx(async (trx) => {
      const cur = await this.row(trx, id, true);
      const set: Record<string, unknown> = {};
      if (i.name !== undefined) set.name = i.name; if (i.ntn !== undefined) set.ntn = i.ntn || null; if (i.strn !== undefined) set.strn = i.strn || null; if (i.address !== undefined) set.address = i.address || null;
      if (i.contactName !== undefined) set.contact_name = i.contactName || null; if (i.contactPhone !== undefined) set.contact_phone = i.contactPhone || null; if (i.contactEmail !== undefined) set.contact_email = i.contactEmail || null;
      if (i.notes !== undefined) set.notes = i.notes || null; if (i.termsDays !== undefined) set.terms_days = i.termsDays;
      if (i.creditLimit !== undefined) set.credit_limit_minor = Money.parse(i.creditLimit, cur.currency).minor.toString();
      if (!Object.keys(set).length) return this.view(cur, (await this.standing(trx, [id])).get(id));
      let c;
      try { c = await trx.updateTable('company').set({ ...set, version: sql`version + 1` as never } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow(); }
      catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE', 'Another company already has that name'); throw e; }
      await this.audit.record(trx, { action: 'company.update', resourceType: 'company', resourceId: id, before: { name: cur.name, creditLimit: cur.credit_limit_minor, termsDays: cur.terms_days }, after: { ...i } });
      return this.view(c, (await this.standing(trx, [id])).get(id));
    });
  }

  async setStatus(userId: string, id: string, i: z.infer<typeof S.SetStatus>) {
    return this.tdb.tx(async (trx) => {
      const cur = await this.row(trx, id, true);
      if (cur.status === i.status) return this.view(cur, (await this.standing(trx, [id])).get(id));
      const st = (await this.standing(trx, [id])).get(id)!;
      if (i.status === 'ARCHIVED' && st.owed !== 0n) throw fail(409, 'BALANCE_DUE', 'A company that still owes money (or holds an unused credit) cannot be archived', { owed: fmt(st.owed, cur.currency) });
      const c = await trx.updateTable('company').set({ status: i.status, hold_reason: i.status === 'ON_HOLD' ? i.reason! : null, version: sql`version + 1` as never } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: `company.${i.status.toLowerCase()}`, resourceType: 'company', resourceId: id, before: { status: cur.status }, after: { status: i.status }, note: i.reason });
      await this.outbox.publish(trx, { aggregateType: 'company', aggregateId: id, eventType: 'CompanyStatusChanged', payload: { companyId: id, from: cur.status, to: i.status, reason: i.reason ?? null } });
      return this.view(c, st);
    });
  }

  /** Booking for a company: it must exist and not be archived. (A company on hold can still be booked; billing it is what needs a manager.) */
  async assertBookable(trx: Trx, id: string) {
    const c = await trx.selectFrom('company').select(['id', 'status']).where('id', '=', id).executeTakeFirst();
    if (!c) throw fail(422, 'COMPANY_NOT_FOUND', 'That company does not exist');
    if (c.status === 'ARCHIVED') throw fail(422, 'COMPANY_ARCHIVED', 'That company is archived');
  }
}
