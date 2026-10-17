import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { TenantDb } from '../db/tenant-db.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { FolioService, fmt, type Trx } from './folio.service.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);

@Injectable()
export class CashierService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(FolioService) private readonly folios: FolioService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  private async canReview(userId: string, propertyId: string) { return (await this.authz.check(userId, { permission: 'cashier.review', scope: { propertyId } })).effect === 'ALLOW'; }
  private async load(trx: Trx, propertyId: string, id: string, lock = false) {
    let q = trx.selectFrom('cashier_session').selectAll().where('id', '=', id).where('property_id', '=', propertyId);
    if (lock) q = q.forUpdate();
    const s = await q.executeTakeFirst();
    if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Cashier session not found' });
    return s;
  }
  /** Everything that moved in this session, by tender. */
  private async figures(trx: Trx, sessionId: string, openingFloat: string) {
    const rows = await sql<{ method: string; kind: string; n: number; total: string }>`SELECT method, kind, count(*)::int AS n, sum(amount_minor)::text AS total FROM payment
      WHERE tenant_id = ${currentTenant().tenantId} AND cashier_session_id = ${sessionId} AND status = 'CAPTURED' GROUP BY method, kind ORDER BY method, kind`.execute(trx);
    const drops = (await trx.selectFrom('cash_drop').select('amount_minor').where('cashier_session_id', '=', sessionId).execute()).reduce((a, x) => a + BigInt(x.amount_minor), 0n);
    let cashIn = 0n, cashOut = 0n;
    for (const r of rows.rows) if (r.method === 'CASH') { if (r.kind === 'REFUND') cashOut += BigInt(r.total); else cashIn += BigInt(r.total); }
    const expected = BigInt(openingFloat) + cashIn - cashOut - drops;
    return { tenders: rows.rows, cashIn, cashOut, drops, expected, dropCount: (await trx.selectFrom('cash_drop').select('id').where('cashier_session_id', '=', sessionId).execute()).length };
  }
  private view(s: Awaited<ReturnType<CashierService['load']>>, cur: string, reveal: boolean, f?: Awaited<ReturnType<CashierService['figures']>>) {
    const base = { id: s.id, registerName: s.register_name, userId: s.user_id, status: s.status, openedAt: s.opened_at, openedBusinessDate: s.opened_business_date, openingFloat: fmt(s.opening_float_minor, cur), closedAt: s.closed_at,
      reviewedBy: s.reviewed_by, reviewedAt: s.reviewed_at, reviewNote: s.review_note, closeNote: s.close_note };
    const closed = s.status !== 'OPEN';
    return {
      ...base,
      // blind close: until the count is submitted the cashier sees activity, never the drawer total they should be counting against
      ...(reveal || closed ? { counted: s.counted_minor === null ? null : fmt(s.counted_minor, cur), expected: s.expected_minor === null ? (f ? fmt(f.expected, cur) : null) : fmt(s.expected_minor, cur), variance: s.variance_minor === null ? null : fmt(s.variance_minor, cur) } : {}),
      ...(f ? { tenders: f.tenders.map((t) => ({ method: t.method, kind: t.kind, count: t.n, ...(reveal || closed || t.method !== 'CASH' ? { total: fmt(t.total, cur) } : {}) })),
        ...(reveal || closed ? { cash: { receipts: fmt(f.cashIn, cur), refunds: fmt(f.cashOut, cur), drops: fmt(f.drops, cur) } } : {}), dropCount: f.dropCount } : {}),
    };
  }

  async open(propertyId: string, userId: string, i: z.infer<typeof S.OpenSession>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const float = Money.parse(i.openingFloat, p.currency).minor;
      let s;
      try {
        s = await trx.insertInto('cashier_session').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, register_name: i.registerName, user_id: userId, opened_business_date: p.business_date,
          opening_float_minor: float.toString() } as never).returningAll().executeTakeFirstOrThrow();
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw fail(409, 'SESSION_ALREADY_OPEN', 'You already have an open cashier session at this property. Close it first.');
        throw e;
      }
      await this.audit.record(trx, { action: 'cashier.open', resourceType: 'cashier_session', resourceId: s.id, propertyId, after: { float: float.toString(), register: i.registerName } });
      return this.view(s, p.currency, false, await this.figures(trx, s.id, s.opening_float_minor));
    });
  }
  async current(propertyId: string, userId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const s = await trx.selectFrom('cashier_session').selectAll().where('property_id', '=', propertyId).where('user_id', '=', userId).where('status', '=', 'OPEN').executeTakeFirst();
      return { session: s ? this.view(s, p.currency, false, await this.figures(trx, s.id, s.opening_float_minor)) : null };
    });
  }
  async drop(propertyId: string, id: string, userId: string, i: z.infer<typeof S.CashDrop>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const s = await this.load(trx, propertyId, id, true);
      if (s.user_id !== userId) throw fail(403, 'NOT_YOUR_SESSION', 'Only the cashier who owns this session can record a drop');
      if (s.status !== 'OPEN') throw fail(409, 'SESSION_NOT_OPEN', 'This session is closed');
      const amount = Money.parse(i.amount, p.currency).minor;
      if (amount <= 0n) throw fail(422, 'AMOUNT_INVALID', 'The amount must be more than zero');
      const f = await this.figures(trx, id, s.opening_float_minor);
      if (amount > f.expected) throw fail(422, 'DROP_EXCEEDS_CASH', 'That is more cash than the drawer should hold');
      const d = await trx.insertInto('cash_drop').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, cashier_session_id: id, amount_minor: amount.toString(), note: i.note ?? null, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'cashier.drop', resourceType: 'cashier_session', resourceId: id, propertyId, after: { dropId: d.id, amount: amount.toString() } });
      return { dropId: d.id, amount: fmt(amount, p.currency) };
    });
  }
  async close(propertyId: string, id: string, userId: string, i: z.infer<typeof S.CloseSession>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const s = await this.load(trx, propertyId, id, true);
      if (s.user_id !== userId && !(await this.canReview(userId, propertyId))) throw fail(403, 'NOT_YOUR_SESSION', 'Only the cashier who owns this session (or a manager) can close it');
      if (s.status !== 'OPEN') throw fail(409, 'SESSION_NOT_OPEN', 'This session is already closed');
      const counted = Money.parse(i.counted, p.currency).minor;
      const f = await this.figures(trx, id, s.opening_float_minor);
      const variance = counted - f.expected;
      const upd = await trx.updateTable('cashier_session').set({ status: 'CLOSED', closed_at: new Date(this.clock.now()), counted_minor: counted.toString(), expected_minor: f.expected.toString(), variance_minor: variance.toString(), close_note: i.note ?? null })
        .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'cashier.close', resourceType: 'cashier_session', resourceId: id, propertyId, after: { counted: counted.toString(), expected: f.expected.toString(), variance: variance.toString(), closedBy: userId }, note: i.note ?? undefined });
      await this.outbox.publish(trx, { aggregateType: 'cashier_session', aggregateId: id, eventType: 'CashierSessionClosed', propertyId, payload: { sessionId: id, userId: s.user_id, varianceMinor: variance.toString(), currency: p.currency } });
      return this.view(upd, p.currency, true, f);
    });
  }
  async review(propertyId: string, id: string, userId: string, i: z.infer<typeof S.ReviewSession>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const s = await this.load(trx, propertyId, id, true);
      if (s.status !== 'CLOSED') throw fail(409, 'NOT_REVIEWABLE', 'Only a closed session can be reviewed');
      if (s.user_id === userId) throw fail(403, 'SELF_REVIEW', 'A manager other than the cashier must review the session');
      if (BigInt(s.variance_minor ?? '0') !== 0n && !i.note) throw fail(422, 'NOTE_REQUIRED', 'This session has a cash variance. Write what you found.');
      const upd = await trx.updateTable('cashier_session').set({ status: 'REVIEWED', reviewed_by: userId, reviewed_at: new Date(this.clock.now()), review_note: i.note ?? null }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'cashier.review', resourceType: 'cashier_session', resourceId: id, propertyId, after: { variance: s.variance_minor }, note: i.note ?? undefined });
      return this.view(upd, p.currency, true, await this.figures(trx, id, s.opening_float_minor));
    });
  }
  async get(propertyId: string, id: string, userId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const s = await this.load(trx, propertyId, id);
      const reviewer = await this.canReview(userId, propertyId);
      if (s.user_id !== userId && !reviewer) throw fail(403, 'PERMISSION_DENIED', 'You can only see your own cashier sessions');
      return this.view(s, p.currency, reviewer && s.user_id !== userId, await this.figures(trx, id, s.opening_float_minor));
    });
  }
  async list(propertyId: string, userId: string, q: z.infer<typeof S.SessionsQuery>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const reviewer = await this.canReview(userId, propertyId);
      let b = trx.selectFrom('cashier_session').selectAll().where('property_id', '=', propertyId).orderBy('opened_at', 'desc').limit(q.limit);
      if (!reviewer) b = b.where('user_id', '=', userId);
      if (q.status) b = b.where('status', '=', q.status);
      if (q.date) b = b.where('opened_business_date', '=', q.date);
      const rows = await b.execute();
      return { items: rows.map((s) => this.view(s, p.currency, false)) };
    });
  }
}
