import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { fmt } from '../folio/folio.service.js';
import { RatesService } from '../rates/rates.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { canonical, type PricedRequest } from './approval-store.js';
import { LABELS, type DiscountCode } from './reasons.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
/** How long a request waits, and how long an approval can be used once given. */
const HOURS = 24;

@Injectable()
export class DiscountApprovalsService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuthorizationService) private readonly authz: AuthorizationService, @Inject(AuditService) private readonly audit: AuditService, @Inject(RatesService) private readonly rates: RatesService) {}

  private async can(userId: string, permission: string, propertyId: string, extra: { discountPct?: number } = {}) { return (await this.authz.check(userId, { permission, scope: { propertyId }, ...extra })).effect === 'ALLOW'; }

  private view(a: Record<string, any>, names: Map<string, string>, currency: string, viewer: string) {
    const req = a.request as PricedRequest; const expired = new Date(a.expires_at).getTime() < Date.now();
    return { id: a.id, status: expired && ['PENDING', 'APPROVED'].includes(a.status) ? 'EXPIRED' : a.status, requestedBy: names.get(a.requested_by) ?? '—', mine: a.requested_by === viewer, code: a.code, codeLabel: LABELS[a.code as DiscountCode] ?? a.code, note: a.note, pct: Number(a.pct), amount: fmt(a.amount_minor, currency), rooms: a.rooms, usedRooms: a.used_rooms,
      arrival: req.arrival, departure: req.departure, adults: req.adults, children: req.children, roomTypeId: req.roomTypeId, planId: req.planId, decidedBy: a.decided_by ? names.get(a.decided_by) ?? null : null, decidedAt: a.decided_at, decisionNote: a.decision_note, expiresAt: a.expires_at, createdAt: a.created_at, quote: req };
  }

  /** The requester asks a manager to approve a discount that is above their limit. Only offered when the discount really is above it. */
  async request(propertyId: string, userId: string, i: z.infer<typeof S.ApprovalRequest>) {
    await this.authz.check(userId, { permission: 'reservation.create', scope: { propertyId } });
    const quote = await this.rates.quote(propertyId, userId, { ...i.quote, roomTypeId: i.roomTypeId } as never);
    const opt = (quote.options as Array<Record<string, any>>).find((o) => o.roomType.id === i.roomTypeId && o.plan.id === i.planId);
    if (!opt) throw fail(404, 'NOT_FOUND', 'That room and rate are not available for these dates');
    if (opt.bookable) throw fail(409, 'APPROVAL_NOT_NEEDED', 'You may give this discount yourself.');
    const disc = opt.discount as { pct: number; amount: string } | null; if (!disc || !(Number(disc.amount) > 0)) throw fail(409, 'APPROVAL_NOT_NEEDED', 'There is no discount to approve.');
    const request = canonical({ ...i.quote, roomTypeId: i.roomTypeId, planId: i.planId, discountAmount: i.quote.discountAmount ?? null, agreedTotal: i.quote.agreedTotal ?? null, nightDiscounts: i.quote.nightDiscounts });
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select('currency').where('id', '=', propertyId).executeTakeFirstOrThrow();
      const same = await trx.selectFrom('discount_approval').selectAll().where('property_id', '=', propertyId).where('requested_by', '=', userId).where('status', 'in', ['PENDING', 'APPROVED']).where('expires_at', '>', new Date()).where(sql<boolean>`request = ${JSON.stringify(request)}::jsonb` as never).executeTakeFirst();
      if (same) return { id: same.id, status: same.status, reused: true };
      const row = await trx.insertInto('discount_approval').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, requested_by: userId, request: JSON.stringify(request), code: i.reason.code, note: i.reason.note ?? null, pct: String(disc.pct), amount_minor: BigInt(Math.round(Number(disc.amount) * 100)).toString(), rooms: i.rooms, expires_at: new Date(Date.now() + HOURS * 3_600_000) } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'discount.request', resourceType: 'discount_approval', resourceId: row.id, propertyId, after: { pct: disc.pct, code: i.reason.code, rooms: i.rooms }, note: i.reason.note });
      void p; return { id: row.id, status: 'PENDING', reused: false };
    });
  }

  async list(propertyId: string, userId: string, q: z.infer<typeof S.ApprovalList>) {
    const approver = await this.can(userId, 'reservation.approve_discount', propertyId);
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select('currency').where('id', '=', propertyId).executeTakeFirstOrThrow();
      const names = new Map((await trx.selectFrom('staff_user').select(['id', 'full_name']).execute()).map((u) => [u.id, u.full_name]));
      let qb = trx.selectFrom('discount_approval').selectAll().where('property_id', '=', propertyId).orderBy('created_at', 'desc').limit(100);
      if (!approver || q.mine === 'true') qb = qb.where('requested_by', '=', userId);
      if (q.status) qb = qb.where('status', 'in', q.status.split(',') as never);
      return { approver, items: (await qb.execute()).map((a) => this.view(a, names, p.currency, userId)) };
    });
  }
  async get(propertyId: string, userId: string, id: string) {
    const r = await this.list(propertyId, userId, { mine: 'false' }); const a = r.items.find((x) => x.id === id);
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Request not found' }); return a;
  }

  private async decide(propertyId: string, userId: string, id: string, approve: boolean, note?: string) {
    return this.tdb.tx(async (trx) => {
      const a = await trx.selectFrom('discount_approval').selectAll().where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst();
      if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Request not found' });
      if (a.status !== 'PENDING') throw fail(409, 'ALREADY_DECIDED', 'This request has already been decided or withdrawn.');
      if (new Date(a.expires_at).getTime() < Date.now()) throw fail(409, 'EXPIRED', 'This request has expired. Ask for a new one.');
      if (a.requested_by === userId) throw fail(403, 'SELF_APPROVAL', 'You cannot approve your own request.');
      if (approve && !(await this.can(userId, 'reservation.create', propertyId, { discountPct: Number(a.pct) }))) throw fail(403, 'ABOVE_YOUR_LIMIT', 'This discount is above what you may give yourself, so you cannot approve it.');
      await trx.updateTable('discount_approval').set({ status: approve ? 'APPROVED' : 'REJECTED', decided_by: userId, decided_at: sql`now()`, decision_note: note ?? null, ...(approve ? { expires_at: new Date(Date.now() + HOURS * 3_600_000) } : {}) } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: approve ? 'discount.approve' : 'discount.reject', resourceType: 'discount_approval', resourceId: id, propertyId, after: { pct: Number(a.pct), requestedBy: a.requested_by }, note });
      return { id, status: approve ? 'APPROVED' : 'REJECTED' };
    });
  }
  approve(pid: string, userId: string, id: string, note?: string) { return this.decide(pid, userId, id, true, note); }
  reject(pid: string, userId: string, id: string, note: string) { return this.decide(pid, userId, id, false, note); }
  async withdraw(propertyId: string, userId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.updateTable('discount_approval').set({ status: 'CANCELLED' } as never).where('id', '=', id).where('property_id', '=', propertyId).where('requested_by', '=', userId).where('status', 'in', ['PENDING', 'APPROVED']).returning('id').executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No open request of yours with that number' });
      await this.audit.record(trx, { action: 'discount.withdraw', resourceType: 'discount_approval', resourceId: id, propertyId }); return { id, status: 'CANCELLED' };
    });
  }
}
void ForbiddenException;
