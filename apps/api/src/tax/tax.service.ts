import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import type { DB } from '@hos/db';
import { Money, addDays } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { computeTax, type TaxLine, type TaxVersionRule } from './engine.js';
import type * as S from './schemas.js';

type Trx = Transaction<DB>;
const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const fmt = (m: bigint | string | number, cur = 'PKR') => ({ amount: Money.ofMinor(BigInt(m), cur).toDecimalString(), currency: cur });

@Injectable()
export class TaxService {
  private readonly rulesCache = new WeakMap<object, Map<string, TaxVersionRule[]>>();
  private readonly residencyCache = new WeakMap<object, Map<string, 'RESIDENT' | 'NON_RESIDENT'>>();
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  // ───────────── configuration (maker–checker) ─────────────
  private view(v: { id: string; tax_code_id: string; version_no: number; status: string; rate_bp: number; applies_to: string[]; residency: string | null; effective_from: string; effective_to: string | null; legal_basis: string | null; advisor_ref: string | null; created_by: string; approved_by: string | null; decision_note: string | null; input_tax_treatment: string }) {
    return { id: v.id, versionNo: v.version_no, status: v.status, rateBp: v.rate_bp, ratePercent: v.rate_bp / 100, appliesTo: v.applies_to, residency: v.residency, effectiveFrom: v.effective_from, effectiveTo: v.effective_to,
      legalBasis: v.legal_basis, advisorRef: v.advisor_ref, inputTaxTreatment: v.input_tax_treatment, createdBy: v.created_by, approvedBy: v.approved_by, note: v.decision_note };
  }
  async listCodes() {
    return this.tdb.tx(async (trx) => {
      const codes = await trx.selectFrom('tax_code').selectAll().orderBy('jurisdiction').orderBy('code').execute();
      const versions = await trx.selectFrom('tax_code_version').selectAll().orderBy('version_no', 'desc').execute();
      const props = await trx.selectFrom('property').select(['id', 'code', 'name', 'tax_jurisdiction']).where('status', '<>', 'ARCHIVED').orderBy('name').execute();
      return { items: codes.map((c) => ({ id: c.id, code: c.code, name: c.name, jurisdiction: c.jurisdiction, versions: versions.filter((v) => v.tax_code_id === c.id).map((v) => this.view(v as never)) })),
        properties: props.map((p) => ({ id: p.id, code: p.code, name: p.name, taxJurisdiction: p.tax_jurisdiction })) };
    });
  }
  async createCode(userId: string, i: z.infer<typeof S.CreateCode>) {
    return this.tdb.tx(async (trx) => {
      let c;
      try { c = await trx.insertInto('tax_code').values({ tenant_id: currentTenant().tenantId, code: i.code, name: i.name, jurisdiction: i.jurisdiction, created_by: userId } as never).returning('id').executeTakeFirstOrThrow(); }
      catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE', `A tax code "${i.code}" already exists`); throw e; }
      const v = await this.insertVersion(trx, c.id, 1, userId, i.version);
      await this.audit.record(trx, { action: 'tax.code_create', resourceType: 'tax_code', resourceId: c.id, after: { code: i.code, jurisdiction: i.jurisdiction, version: i.version } });
      return { id: c.id, code: i.code, version: v };
    });
  }
  private async insertVersion(trx: Trx, codeId: string, no: number, userId: string, v: z.infer<typeof S.VersionBody>) {
    const row = await trx.insertInto('tax_code_version').values({ tenant_id: currentTenant().tenantId, tax_code_id: codeId, version_no: no, status: 'DRAFT', rate_bp: v.rateBp, applies_to: v.appliesTo as never,
      residency: v.residency ?? null, input_tax_treatment: v.inputTaxTreatment, effective_from: v.effectiveFrom, effective_to: v.effectiveTo ?? null, legal_basis: v.legalBasis ?? null, advisor_ref: v.advisorRef ?? null, created_by: userId } as never).returningAll().executeTakeFirstOrThrow();
    return this.view(row as never);
  }
  async addVersion(userId: string, codeId: string, v: z.infer<typeof S.VersionBody>) {
    return this.tdb.tx(async (trx) => {
      const c = await trx.selectFrom('tax_code').select(['id', 'code']).where('id', '=', codeId).forUpdate().executeTakeFirst();
      if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Tax code not found' });
      const last = await trx.selectFrom('tax_code_version').select(({ fn }) => fn.max('version_no').as('n')).where('tax_code_id', '=', codeId).executeTakeFirst();
      const out = await this.insertVersion(trx, codeId, (last?.n ?? 0) + 1, userId, v);
      await this.audit.record(trx, { action: 'tax.version_create', resourceType: 'tax_code', resourceId: codeId, after: { code: c.code, ...v } });
      return out;
    });
  }
  async updateDraft(userId: string, versionId: string, v: z.infer<typeof S.VersionBody>) {
    return this.tdb.tx(async (trx) => {
      const cur = await trx.selectFrom('tax_code_version').selectAll().where('id', '=', versionId).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Version not found' });
      if (cur.status !== 'DRAFT') throw fail(409, 'NOT_DRAFT', 'Only a draft can be edited. Add a new version instead.');
      // whoever last edited a draft becomes its author, so they cannot approve it
      const row = await trx.updateTable('tax_code_version').set({ rate_bp: v.rateBp, applies_to: v.appliesTo as never, residency: v.residency ?? null, input_tax_treatment: v.inputTaxTreatment, effective_from: v.effectiveFrom, effective_to: v.effectiveTo ?? null,
        legal_basis: v.legalBasis ?? null, advisor_ref: v.advisorRef ?? null, created_by: userId } as never).where('id', '=', versionId).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'tax.version_edit', resourceType: 'tax_code_version', resourceId: versionId, before: this.view(cur as never), after: this.view(row as never) });
      return this.view(row as never);
    });
  }
  /** A second person confirms the advisor's figures. Only then does the rate start being charged (from its effective date). */
  async approve(userId: string, versionId: string, i: z.infer<typeof S.Approve>) {
    return this.tdb.tx(async (trx) => {
      const cur = await trx.selectFrom('tax_code_version').selectAll().where('id', '=', versionId).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Version not found' });
      if (cur.status !== 'DRAFT') throw fail(409, 'NOT_DRAFT', 'Only a draft can be approved');
      if (cur.created_by === userId) throw fail(403, 'SELF_APPROVAL', 'A different person must approve a tax rate than the one who entered it');
      // a newer version closes the one it replaces, the day before it starts
      const overlapping = await trx.selectFrom('tax_code_version').selectAll().where('tax_code_id', '=', cur.tax_code_id).where('status', '=', 'ACTIVE').forUpdate().execute();
      for (const o of overlapping) {
        const ends = o.effective_to ?? '9999-12-31';
        if (o.effective_from < cur.effective_from && ends >= cur.effective_from) await trx.updateTable('tax_code_version').set({ effective_to: addDays(cur.effective_from, -1) }).where('id', '=', o.id).execute();
        else if (o.effective_from >= cur.effective_from && o.effective_from <= (cur.effective_to ?? '9999-12-31')) throw fail(409, 'VERSION_OVERLAP', `An active version already covers dates from ${o.effective_from}`);
      }
      const row = await trx.updateTable('tax_code_version').set({ status: 'ACTIVE', approved_by: userId, approved_at: new Date(), advisor_ref: i.advisorRef, legal_basis: i.legalBasis, decision_note: i.note ?? null } as never)
        .where('id', '=', versionId).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'tax.version_approve', resourceType: 'tax_code_version', resourceId: versionId, before: this.view(cur as never), after: this.view(row as never), reasonCode: 'TAX_CHANGE', note: `advisor: ${i.advisorRef}` });
      await this.outbox.publish(trx, { aggregateType: 'tax_code', aggregateId: cur.tax_code_id, eventType: 'TaxRateActivated', payload: { versionId, rateBp: row.rate_bp, effectiveFrom: row.effective_from } });
      return this.view(row as never);
    });
  }
  async reject(userId: string, versionId: string, reason: string) { return this.decide(userId, versionId, 'REJECTED', 'DRAFT', reason); }
  /** Stops a rate from today onward (it is closed on the day before the property's earliest business date; history is untouched). */
  async retire(userId: string, versionId: string, reason: string) { return this.decide(userId, versionId, 'RETIRED', 'ACTIVE', reason); }
  private async decide(userId: string, versionId: string, to: 'REJECTED' | 'RETIRED', from: 'DRAFT' | 'ACTIVE', reason: string) {
    return this.tdb.tx(async (trx) => {
      const cur = await trx.selectFrom('tax_code_version').selectAll().where('id', '=', versionId).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Version not found' });
      if (cur.status !== from) throw fail(409, 'WRONG_STATE', `Only a ${from.toLowerCase()} version can be ${to.toLowerCase()}`);
      const row = await trx.updateTable('tax_code_version').set({ status: to, decision_note: reason } as never).where('id', '=', versionId).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: `tax.version_${to.toLowerCase()}`, resourceType: 'tax_code_version', resourceId: versionId, before: this.view(cur as never), after: this.view(row as never), reasonCode: 'TAX_CHANGE', note: reason });
      return this.view(row as never);
    });
  }
  async setPropertyJurisdiction(propertyId: string, jurisdiction: string | null) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['id', 'tax_jurisdiction']).where('id', '=', propertyId).forUpdate().executeTakeFirst();
      if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
      await trx.updateTable('property').set({ tax_jurisdiction: jurisdiction }).where('id', '=', propertyId).execute();
      await this.audit.record(trx, { action: 'tax.property_jurisdiction', resourceType: 'property', resourceId: propertyId, propertyId, before: { jurisdiction: p.tax_jurisdiction }, after: { jurisdiction }, reasonCode: 'TAX_CHANGE' });
      return { propertyId, taxJurisdiction: jurisdiction };
    });
  }

  // ───────────── use ─────────────
  /** Every active version of the property's jurisdiction; the engine filters by date, code and residency. */
  async rulesFor(trx: Trx, propertyId: string): Promise<TaxVersionRule[]> {
    let m = this.rulesCache.get(trx); if (!m) { m = new Map(); this.rulesCache.set(trx, m); }
    const hit = m.get(propertyId); if (hit) return hit;
    const p = await trx.selectFrom('property').select('tax_jurisdiction').where('id', '=', propertyId).executeTakeFirst();
    let rules: TaxVersionRule[] = [];
    if (p?.tax_jurisdiction) {
      const rows = await trx.selectFrom('tax_code_version as v').innerJoin('tax_code as c', 'c.id', 'v.tax_code_id').select(['v.id', 'c.code', 'v.rate_bp', 'v.applies_to', 'v.residency', 'v.effective_from', 'v.effective_to'])
        .where('c.jurisdiction', '=', p.tax_jurisdiction).where('v.status', '=', 'ACTIVE').orderBy('c.code').execute();
      rules = rows.map((r) => ({ id: r.id, code: r.code, rateBp: r.rate_bp, appliesTo: r.applies_to, residency: r.residency, effectiveFrom: r.effective_from, effectiveTo: r.effective_to }));
    }
    m.set(propertyId, rules);
    return rules;
  }
  private async residencyOf(trx: Trx, folioId: string): Promise<'RESIDENT' | 'NON_RESIDENT'> {
    let m = this.residencyCache.get(trx); if (!m) { m = new Map(); this.residencyCache.set(trx, m); }
    const hit = m.get(folioId); if (hit) return hit;
    const r = await trx.selectFrom('folio as f').leftJoin('reservation as r', 'r.id', 'f.reservation_id').select('r.residency').where('f.id', '=', folioId).executeTakeFirst();
    const v = r?.residency ?? 'RESIDENT'; m.set(folioId, v); return v;
  }
  /** Called for every charge or discount posted to a folio. Writes the tax lines beside it, using whatever approved rates are in force on that business date. */
  async applyToPosting(trx: Trx, p: { id: string; folioId: string; propertyId: string; txnCode: string; amount: bigint; date: string; lineId?: string | null; currency: string; userId?: string | null }): Promise<TaxLine[]> {
    const rules = await this.rulesFor(trx, p.propertyId);
    if (!rules.length) return [];
    const lines = computeTax(rules, { txnCode: p.txnCode, date: p.date, residency: await this.residencyOf(trx, p.folioId) }, p.amount);
    for (const l of lines) {
      await trx.insertInto('folio_posting').values({ tenant_id: currentTenant().tenantId, property_id: p.propertyId, folio_id: p.folioId, posting_type: 'TAX', txn_code: 'TAX', description: `${l.code} ${l.rateBp / 100}%`,
        amount_minor: l.taxMinor.toString(), currency: p.currency, business_date: p.date, source_type: 'TAX', parent_posting_id: p.id, reservation_room_id: p.lineId ?? null, tax_code: l.code, tax_version_id: l.versionId,
        tax_rate_bp: l.rateBp, taxable_minor: l.taxableMinor.toString(), created_by: p.userId ?? currentTenant().actorId ?? null } as never).execute();
    }
    return lines;
  }
  /** Postings of a day that were made before their tax rate existed get their tax now (the audit's tax step). Safe to repeat. */
  async catchUp(trx: Trx, propertyId: string, date: string, userId?: string): Promise<{ postings: number; taxMinor: bigint }> {
    const rules = await this.rulesFor(trx, propertyId);
    if (!rules.length) return { postings: 0, taxMinor: 0n };
    const rows = await sql<{ id: string; folio_id: string; txn_code: string; amount_minor: string; currency: string; reservation_room_id: string | null; parent_txn: string | null }>`
      SELECT p.id, p.folio_id, p.txn_code, p.amount_minor::text, p.currency, p.reservation_room_id, par.txn_code AS parent_txn FROM folio_posting p LEFT JOIN folio_posting par ON par.tenant_id = p.tenant_id AND par.id = p.parent_posting_id
      WHERE p.tenant_id = ${currentTenant().tenantId} AND p.property_id = ${propertyId} AND p.business_date = ${date}::date AND p.posting_type IN ('CHARGE','DISCOUNT')
        AND NOT EXISTS (SELECT 1 FROM folio_posting t WHERE t.tenant_id = p.tenant_id AND t.parent_posting_id = p.id AND t.posting_type = 'TAX')
        AND NOT EXISTS (SELECT 1 FROM folio_posting r WHERE r.tenant_id = p.tenant_id AND r.reverses_posting_id = p.id)`.execute(trx);
    let n = 0, total = 0n;
    for (const r of rows.rows) {
      const lines = await this.applyToPosting(trx, { id: r.id, folioId: r.folio_id, propertyId, txnCode: r.txn_code === 'DISCOUNT' && r.parent_txn ? r.parent_txn : (r.txn_code === 'ROOM_DISCOUNT' ? 'ROOM' : r.txn_code), amount: BigInt(r.amount_minor), date, lineId: r.reservation_room_id, currency: r.currency, userId });
      if (lines.length) { n++; total += lines.reduce((a, l) => a + l.taxMinor, 0n); }
    }
    return { postings: n, taxMinor: total };
  }

  /** What the tax would be on some amounts — a planning aid for staff and for quotes. Not advice. */
  async previewIn(trx: Trx, propertyId: string, i: { date: string; residency: 'RESIDENT' | 'NON_RESIDENT'; lines: Array<{ txnCode: string; netMinor: bigint }> }) {
    const rules = await this.rulesFor(trx, propertyId);
    const out = i.lines.map((l) => ({ txnCode: l.txnCode, netMinor: l.netMinor, taxes: computeTax(rules, { txnCode: l.txnCode, date: i.date, residency: i.residency }, l.netMinor) }));
    const byCode = new Map<string, { code: string; rateBp: number; taxableMinor: bigint; taxMinor: bigint }>();
    for (const l of out) for (const t of l.taxes) { const e = byCode.get(`${t.code}:${t.rateBp}`) ?? { code: t.code, rateBp: t.rateBp, taxableMinor: 0n, taxMinor: 0n }; e.taxableMinor += t.taxableMinor; e.taxMinor += t.taxMinor; byCode.set(`${t.code}:${t.rateBp}`, e); }
    return { lines: out, byCode: [...byCode.values()], taxMinor: [...byCode.values()].reduce((a, e) => a + e.taxMinor, 0n), configured: rules.length > 0 };
  }
  async preview(propertyId: string, i: z.infer<typeof S.Preview>) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['id', 'currency', 'business_date', 'tax_jurisdiction']).where('id', '=', propertyId).executeTakeFirst();
      if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
      const date = i.date ?? p.business_date;
      const r = await this.previewIn(trx, propertyId, { date, residency: i.residency, lines: i.lines.map((l) => ({ txnCode: l.txnCode, netMinor: Money.parse(l.amount, p.currency).minor })) });
      const net = r.lines.reduce((a, l) => a + l.netMinor, 0n);
      return { date, jurisdiction: p.tax_jurisdiction, configured: r.configured, note: 'Planning aid only — invoices use the approved rates on each posting’s business date.',
        lines: r.lines.map((l) => ({ txnCode: l.txnCode, net: fmt(l.netMinor, p.currency), taxes: l.taxes.map((t) => ({ code: t.code, ratePercent: t.rateBp / 100, tax: fmt(t.taxMinor, p.currency) })) })),
        byCode: r.byCode.map((e) => ({ code: e.code, ratePercent: e.rateBp / 100, taxable: fmt(e.taxableMinor, p.currency), tax: fmt(e.taxMinor, p.currency) })), net: fmt(net, p.currency), tax: fmt(r.taxMinor, p.currency), total: fmt(net + r.taxMinor, p.currency) };
    });
  }

  /** Tax charged in a period, by code, from the ledger itself (net of reversals). */
  async liability(propertyId: string, from: string, to: string) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['id', 'currency']).where('id', '=', propertyId).executeTakeFirst();
      if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
      if (to < from) throw fail(400, 'VALIDATION_FAILED', 'The end date is before the start date');
      const rows = await sql<{ tax_code: string; name: string | null; rate_bp: number; n: number; taxable: string; tax: string }>`
        SELECT p.tax_code, c.name, p.tax_rate_bp AS rate_bp, count(*)::int AS n, coalesce(sum(p.taxable_minor),0)::text AS taxable, coalesce(sum(p.amount_minor),0)::text AS tax
        FROM folio_posting p LEFT JOIN tax_code c ON c.tenant_id = p.tenant_id AND c.code = p.tax_code
        WHERE p.tenant_id = ${currentTenant().tenantId} AND p.property_id = ${propertyId} AND p.tax_code IS NOT NULL AND p.business_date BETWEEN ${from}::date AND ${to}::date
        GROUP BY p.tax_code, c.name, p.tax_rate_bp ORDER BY p.tax_code, p.tax_rate_bp`.execute(trx);
      const total = rows.rows.reduce((a, r) => a + BigInt(r.tax), 0n);
      return { from, to, items: rows.rows.map((r) => ({ code: r.tax_code, name: r.name, ratePercent: r.rate_bp / 100, postings: r.n, taxable: fmt(r.taxable, p.currency), tax: fmt(r.tax, p.currency) })), total: fmt(total, p.currency) };
    });
  }

  // ───────────── the legal entity the invoices are issued by ─────────────
  async legalEntities() {
    return this.tdb.tx(async (trx) => ({ items: (await trx.selectFrom('legal_entity').selectAll().orderBy('name').execute()).map((l) => ({ id: l.id, name: l.name, ntn: l.ntn, strn: l.strn, address: l.address, fiscalYearStartMonth: l.fiscal_year_start_month })) }));
  }
  async updateLegalEntity(id: string, i: z.infer<typeof S.UpdateLegalEntity>) {
    return this.tdb.tx(async (trx) => {
      const cur = await trx.selectFrom('legal_entity').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Legal entity not found' });
      const set: Record<string, unknown> = {};
      if (i.name !== undefined) set.name = i.name; if (i.ntn !== undefined) set.ntn = i.ntn; if (i.strn !== undefined) set.strn = i.strn; if (i.address !== undefined) set.address = i.address;
      if (i.fiscalYearStartMonth !== undefined) {
        if (i.fiscalYearStartMonth !== cur.fiscal_year_start_month) {
          const used = await trx.selectFrom('invoice').select('id').where('legal_entity_id', '=', id).limit(1).executeTakeFirst();
          if (used) throw new ConflictException({ code: 'FISCAL_YEAR_LOCKED', message: 'The fiscal year cannot change once invoices have been issued' });
        }
        set.fiscal_year_start_month = i.fiscalYearStartMonth;
      }
      if (!Object.keys(set).length) return { id, ...i };
      const row = await trx.updateTable('legal_entity').set(set as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'legal_entity.update', resourceType: 'legal_entity', resourceId: id, before: { name: cur.name, ntn: cur.ntn, strn: cur.strn, address: cur.address }, after: { name: row.name, ntn: row.ntn, strn: row.strn, address: row.address } });
      return { id: row.id, name: row.name, ntn: row.ntn, strn: row.strn, address: row.address, fiscalYearStartMonth: row.fiscal_year_start_month };
    });
  }
}
void ForbiddenException;
