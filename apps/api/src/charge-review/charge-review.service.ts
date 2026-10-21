import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { TenantDb } from '../db/tenant-db.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type { Trx } from '../companies/companies.service.js';

const fmt = (m: bigint | string | number, cur: string) => ({ amount: Money.ofMinor(BigInt(m), cur).toDecimalString(), currency: cur });

/** Some charges need a person to look at them (a withholding-tax review, a vendor check). Which ones is data per tax area, not code. */
@Injectable()
export class ChargeReviewService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  /** Called when a charge is posted: opens a review for every active rule of the property's tax area that names this charge code. Once per posting and rule. */
  async openFor(trx: Trx, p: { postingId: string; folioId: string; propertyId: string; txnCode: string; amount: bigint; currency: string; description?: string }) {
    const rules = await sql<{ kind: string; message: string }>`
      SELECT r.kind, r.message FROM charge_review_rule r JOIN property pr ON pr.tenant_id = r.tenant_id AND pr.tax_jurisdiction = r.jurisdiction
      WHERE r.tenant_id = ${currentTenant().tenantId} AND pr.id = ${p.propertyId} AND r.txn_code = ${p.txnCode} AND r.active`.execute(trx);
    for (const r of rules.rows) {
      await trx.insertInto('charge_review').values({ tenant_id: currentTenant().tenantId, property_id: p.propertyId, folio_id: p.folioId, posting_id: p.postingId, kind: r.kind, txn_code: p.txnCode, message: r.message, amount_minor: p.amount.toString(), currency: p.currency, description: p.description ?? null } as never)
        .onConflict((oc) => oc.columns(['tenant_id', 'posting_id', 'kind']).doNothing()).execute();
    }
  }

  async list(propertyId: string, status: 'OPEN' | 'DONE' | 'ALL') {
    return this.tdb.tx(async (trx) => {
      let q = trx.selectFrom('charge_review').selectAll().where('property_id', '=', propertyId).orderBy('opened_at', status === 'OPEN' ? 'asc' : 'desc').limit(200);
      if (status !== 'ALL') q = q.where('status', '=', status);
      const rows = await q.execute();
      const folios = rows.length ? await trx.selectFrom('folio').select(['id', 'folio_no']).where('id', 'in', [...new Set(rows.map((r) => r.folio_id))]).execute() : [];
      const no = new Map(folios.map((f) => [f.id, f.folio_no]));
      return { items: rows.map((r) => ({ id: r.id, kind: r.kind, txnCode: r.txn_code, message: r.message, amount: fmt(r.amount_minor, r.currency), description: r.description, folioNo: no.get(r.folio_id) ?? null, status: r.status, openedAt: r.opened_at, resolvedAt: r.resolved_at, note: r.note })) };
    });
  }

  async resolve(propertyId: string, id: string, userId: string, note: string) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.selectFrom('charge_review').selectAll().where('id', '=', id).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Review not found' });
      if (r.status === 'DONE') throw new HttpException({ code: 'ALREADY_DONE', message: 'This review is already closed' }, 409);
      await trx.updateTable('charge_review').set({ status: 'DONE', resolved_by: userId, resolved_at: new Date(this.clock.now()), note } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'charge_review.resolve', resourceType: 'charge_review', resourceId: id, propertyId, before: { status: 'OPEN' }, after: { status: 'DONE' }, note });
      await this.outbox.publish(trx, { aggregateType: 'charge_review', aggregateId: id, eventType: 'ChargeReviewClosed', propertyId, payload: { reviewId: id, kind: r.kind, postingId: r.posting_id } });
      return { id, status: 'DONE' as const, note };
    });
  }
}
