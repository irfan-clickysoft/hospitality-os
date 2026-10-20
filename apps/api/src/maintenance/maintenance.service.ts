import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { fmt, type Trx } from '../companies/companies.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { HousekeepingService } from '../housekeeping/housekeeping.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PropertySetupService } from '../property-setup/property-setup.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
type Row = Awaited<ReturnType<MaintenanceService['row']>>;
const ACTIVE = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING'];

/** A fault becomes a job: owner, status, cost and — if the room cannot be sold — an out-of-order block, released when someone other than the repairer has checked the work. */
@Injectable()
export class MaintenanceService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(PropertySetupService) private readonly setup: PropertySetupService,
    @Inject(HousekeepingService) private readonly hk: HousekeepingService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  private async can(userId: string, permission: string, propertyId: string) { return (await this.authz.check(userId, { permission, scope: { propertyId } })).effect === 'ALLOW'; }
  private async need(userId: string, permission: string, propertyId: string) { if (!(await this.can(userId, permission, propertyId))) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: `This action needs the "${permission}" permission` }); }
  private async prop(trx: Trx, id: string) {
    const p = await trx.selectFrom('property').select(['id', 'code', 'currency', 'business_date']).where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return p;
  }
  async row(trx: Trx, propertyId: string, id: string, lock = false) {
    let q = trx.selectFrom('work_order').selectAll().where('id', '=', id).where('property_id', '=', propertyId);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Work order not found' });
    return r;
  }
  private async event(trx: Trx, id: string, action: string, userId: string, e: { from?: string | null; to?: string | null; note?: string | null; amount?: bigint } = {}) {
    await trx.insertInto('work_order_event').values({ tenant_id: currentTenant().tenantId, work_order_id: id, action, from_status: e.from ?? null, to_status: e.to ?? null, note: e.note ?? null, amount_minor: e.amount?.toString() ?? null, actor_id: userId } as never).execute();
  }
  private async view(trx: Trx, r: Row, bd?: string) {
    const names = new Map<string, string>();
    const ids = [r.assigned_to, r.reported_by, r.done_by, r.verified_by, r.approved_by].filter((x): x is string => !!x);
    if (ids.length) for (const u of await trx.selectFrom('staff_user').select(['id', 'full_name']).where('id', 'in', ids).execute()) names.set(u.id, u.full_name);
    const room = r.room_id ? await trx.selectFrom('room').select(['number']).where('id', '=', r.room_id).executeTakeFirst() : undefined;
    const vendor = r.vendor_id ? await trx.selectFrom('maintenance_vendor').select(['name', 'phone', 'sla_response_hours', 'sla_fix_hours']).where('id', '=', r.vendor_id).executeTakeFirst() : undefined;
    const sla = vendor && r.assigned_at ? this.slaOf(vendor, r) : null;
    const overdue = !!bd && !!r.due_date && ACTIVE.includes(r.status) && r.due_date < bd;
    return { id: r.id, number: r.number, propertyId: r.property_id, title: r.title, description: r.description, category: r.category, priority: r.priority, status: r.status, roomId: r.room_id, room: room?.number ?? null, area: r.area,
      assignedTo: r.assigned_to, assignee: r.assigned_to ? names.get(r.assigned_to) ?? null : null, reporter: names.get(r.reported_by) ?? null, issueId: r.issue_id, blockId: r.block_id, dueDate: r.due_date, overdue,
      cost: fmt(r.cost_minor), vendor: r.vendor, createdAt: r.created_at, startedAt: r.started_at, doneAt: r.done_at, doneNote: r.done_note, doneBy: r.done_by ? names.get(r.done_by) ?? null : null, verifiedBy: r.verified_by ? names.get(r.verified_by) ?? null : null, version: r.version,
      kind: r.kind, estimatedCost: r.estimated_cost_minor === null ? null : fmt(r.estimated_cost_minor), vendorId: r.vendor_id, contractor: vendor?.name ?? null, contractorPhone: vendor?.phone ?? null,
      approvedBy: r.approved_by ? names.get(r.approved_by) ?? null : null, approvedAt: r.approved_at, rejectedReason: r.rejected_reason, assignedAt: r.assigned_at, sla };
  }
  private async set(trx: Trx, r: Row, to: string, patch: Record<string, unknown> = {}) {
    return trx.updateTable('work_order').set({ status: to, ...patch, version: sql`version + 1` } as never).where('id', '=', r.id).returningAll().executeTakeFirstOrThrow();
  }

  /** How a contractor is doing against their contract: hours taken so far (or in total) against the hours promised, for responding and for fixing. */
  private slaOf(v: { sla_response_hours: number | null; sla_fix_hours: number | null }, r: Row) {
    const from = new Date(r.assigned_at as never).getTime(), now = this.clock.now();
    const hrs = (to: number) => Math.round(((to - from) / 3_600_000) * 10) / 10;
    const responded = r.started_at ? hrs(new Date(r.started_at as never).getTime()) : null, fixed = r.done_at ? hrs(new Date(r.done_at as never).getTime()) : null;
    const closed = ['DONE', 'VERIFIED', 'CANCELLED'].includes(r.status);
    return {
      responseHours: v.sla_response_hours, fixHours: v.sla_fix_hours, respondedAfter: responded, fixedAfter: fixed,
      responseBreached: v.sla_response_hours !== null && (responded !== null ? responded > v.sla_response_hours : !closed && hrs(now) > v.sla_response_hours),
      fixBreached: v.sla_fix_hours !== null && (fixed !== null ? fixed > v.sla_fix_hours : !closed && hrs(now) > v.sla_fix_hours),
    };
  }
  private async assertVendor(trx: Trx, vendorId: string) {
    const v = await trx.selectFrom('maintenance_vendor').select(['id', 'status']).where('id', '=', vendorId).executeTakeFirst();
    if (!v) throw fail(404, 'NOT_FOUND', 'Contractor not found');
    if (v.status !== 'ACTIVE') throw fail(422, 'VENDOR_INACTIVE', 'That contractor is no longer active');
  }
  /** Takes the room out of order for a job (needs the right to block rooms). */
  private async takeOut(trx: Trx, propertyId: string, userId: string, roomId: string | null, o: NonNullable<z.infer<typeof S.CreateOrder>['outOfOrder']>, title: string, ticket: string) {
    if (!roomId) throw fail(422, 'VALIDATION_FAILED', 'Choose the room to take out of order');
    if (o.acknowledgeOversell) await this.need(userId, 'inventory.overbook', propertyId);
    await this.need(userId, 'inventory.block', propertyId);
    return (await this.setup.createBlockIn(trx, propertyId, userId, { roomId, type: o.type, startDate: o.startDate, endDate: o.endDate, reason: title, ticketRef: ticket, acknowledgeOversell: o.acknowledgeOversell })).id;
  }

  // ───────────── create ─────────────
  async create(propertyId: string, userId: string, i: z.infer<typeof S.CreateOrder>) {
    // Anyone who may ask can ask; whoever may approve starts the job already approved. A request cannot pick the assignee or take a room out of order — that is the approver's call.
    const approver = await this.can(userId, 'maintenance.approve', propertyId) || await this.can(userId, 'maintenance.manage', propertyId);
    if (!approver) await this.need(userId, 'maintenance.request', propertyId);
    if ((i.assignedTo || i.vendorId || i.outOfOrder) && !approver) throw fail(403, 'PERMISSION_DENIED', 'Only an approver can assign the job or take a room out of order. Send the request and they will do it.');
    if (i.assignedTo && i.vendorId) throw fail(422, 'VALIDATION_FAILED', 'Choose a technician or a contractor, not both');
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      if (i.roomId && !(await trx.selectFrom('room').select('id').where('id', '=', i.roomId).where('property_id', '=', propertyId).executeTakeFirst())) throw fail(404, 'NOT_FOUND', 'Room not found');
      if (i.issueId) {
        const iss = await trx.selectFrom('room_issue').select(['id', 'status']).where('id', '=', i.issueId).where('property_id', '=', propertyId).executeTakeFirst();
        if (!iss) throw fail(404, 'NOT_FOUND', 'Issue not found');
        if (iss.status !== 'OPEN') throw fail(409, 'ISSUE_CLOSED', 'That issue is already resolved');
      }
      if (i.assignedTo) await this.assertTechnician(i.assignedTo, propertyId);
      if (i.vendorId) await this.assertVendor(trx, i.vendorId);
      const seq = (await sql<{ v: string }>`INSERT INTO property_counter (tenant_id, property_id, name, value) VALUES (${currentTenant().tenantId}, ${propertyId}, 'workorder', 1)
        ON CONFLICT (tenant_id, property_id, name) DO UPDATE SET value = property_counter.value + 1 RETURNING value::text AS v`.execute(trx)).rows[0]!.v;
      let blockId: string | null = null;
      const assigned = !!(i.assignedTo || i.vendorId);
      const startStatus = !approver ? 'REQUESTED' : assigned ? 'ASSIGNED' : 'OPEN';
      if (i.outOfOrder) blockId = await this.takeOut(trx, propertyId, userId, i.roomId ?? null, i.outOfOrder, i.title, `${p.code}-WO${seq.padStart(5, '0')}`);
      let r: Row;
      try {
        r = await trx.insertInto('work_order').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, number: `${p.code}-WO${seq.padStart(5, '0')}`, room_id: i.roomId ?? null, area: i.area ?? null, category: i.category, title: i.title,
          description: i.description ?? null, priority: i.priority, kind: i.kind, estimated_cost_minor: i.estimatedCost ? Money.parse(i.estimatedCost, 'PKR').minor.toString() : null, status: startStatus, assigned_to: i.assignedTo ?? null, vendor_id: i.vendorId ?? null, assigned_at: assigned ? new Date(this.clock.now()) : null, approved_by: approver ? userId : null, approved_at: approver ? new Date(this.clock.now()) : null, issue_id: i.issueId ?? null, block_id: blockId, due_date: i.dueDate ?? null, reported_by: userId } as never).returningAll().executeTakeFirstOrThrow();
      } catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'ISSUE_HAS_ORDER', 'A work order already exists for that issue'); throw e; }
      await this.event(trx, r.id, 'CREATE', userId, { to: r.status, note: i.description ?? i.title });
      if (!approver) await this.outbox.publish(trx, { aggregateType: 'work_order', aggregateId: r.id, eventType: 'WorkOrderRequested', propertyId, businessDate: p.business_date, payload: { workOrderId: r.id, number: r.number, kind: i.kind, priority: i.priority } });
      await this.audit.record(trx, { action: 'maintenance.create', resourceType: 'work_order', resourceId: r.id, propertyId, after: { number: r.number, category: i.category, priority: i.priority, roomId: i.roomId ?? null, blockId } });
      await this.outbox.publish(trx, { aggregateType: 'work_order', aggregateId: r.id, eventType: 'WorkOrderCreated', propertyId, businessDate: p.business_date, payload: { workOrderId: r.id, number: r.number, roomId: i.roomId ?? null, priority: i.priority, outOfOrder: !!blockId } });
      return this.view(trx, r, p.business_date);
    });
  }
  private async assertTechnician(assigneeId: string, propertyId: string) {
    if (!(await this.can(assigneeId, 'maintenance.work', propertyId))) throw fail(422, 'NOT_A_TECHNICIAN', 'That person cannot be given maintenance work');
  }

  // ───────────── the job ─────────────
  private async step(propertyId: string, id: string, userId: string, action: string, fn: (trx: Trx, r: Row, bd: string, isManager: boolean) => Promise<{ to: string; patch?: Record<string, unknown>; note?: string | null; amount?: bigint }>, who: 'manager' | 'assignee' | 'approver' | 'manager-or-requester') {
    const manager = await this.can(userId, 'maintenance.manage', propertyId);
    return this.tdb.tx(async (trx) => {
      const r = await this.row(trx, propertyId, id, true);
      const p = await this.prop(trx, propertyId);
      if (who === 'approver' && !(await this.can(userId, 'maintenance.approve', propertyId))) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'This action needs the "maintenance.approve" permission' });
      if (who === 'manager-or-requester' && !manager && !(r.status === 'REQUESTED' && r.reported_by === userId)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Only a manager, or the person who asked while it is still waiting, can cancel this' });
      if (who === 'manager' && !manager) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'This action needs the "maintenance.manage" permission' });
      if (who === 'assignee' && !manager && (r.assigned_to !== userId || !(await this.can(userId, 'maintenance.work', propertyId)))) throw fail(403, 'NOT_YOUR_JOB', 'This work order is assigned to someone else');
      const out = await fn(trx, r, p.business_date, manager);
      const u = await this.set(trx, r, out.to, out.patch);
      await this.event(trx, id, action, userId, { from: r.status, to: out.to, note: out.note, amount: out.amount });
      await this.audit.record(trx, { action: `maintenance.${action.toLowerCase()}`, resourceType: 'work_order', resourceId: id, propertyId, before: { status: r.status }, after: { status: out.to }, note: out.note ?? undefined });
      await this.outbox.publish(trx, { aggregateType: 'work_order', aggregateId: id, eventType: 'WorkOrderChanged', propertyId, businessDate: p.business_date, payload: { workOrderId: id, number: r.number, from: r.status, to: out.to, action } });
      return this.view(trx, u, p.business_date);
    });
  }
  private bad(r: Row, allowed: string[]) { if (!allowed.includes(r.status)) throw fail(409, 'WRONG_STATE', `A work order that is ${r.status.toLowerCase().replace('_', ' ')} cannot be changed this way`); }

  assign(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Assign>) {
    return this.step(propertyId, id, userId, 'ASSIGN', async (trx, r) => {
      this.bad(r, ['OPEN', 'ASSIGNED', 'WAITING']);
      if (i.assignedTo) await this.assertTechnician(i.assignedTo, propertyId); else await this.assertVendor(trx, i.vendorId!);
      const who = i.vendorId ? (await trx.selectFrom('maintenance_vendor').select('name').where('id', '=', i.vendorId).executeTakeFirstOrThrow()).name : undefined;
      return { to: r.status === 'WAITING' ? 'WAITING' : 'ASSIGNED', patch: { assigned_to: i.assignedTo ?? null, vendor_id: i.vendorId ?? null, assigned_at: new Date(this.clock.now()), ...(i.dueDate ? { due_date: i.dueDate } : {}),
        ...(i.estimatedCost ? { estimated_cost_minor: Money.parse(i.estimatedCost, 'PKR').minor.toString() } : {}) }, note: [who ? `contractor ${who}` : null, i.dueDate ? `due ${i.dueDate}` : null].filter(Boolean).join(', ') || null };
    }, 'manager');
  }
  /** A manager, admin or owner says yes (optionally giving the job to someone and setting the estimate in the same step). */
  approve(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Approve>) {
    return this.step(propertyId, id, userId, 'APPROVE', async (trx, r) => {
      this.bad(r, ['REQUESTED']);
      if (i.assignedTo) await this.assertTechnician(i.assignedTo, propertyId);
      if (i.vendorId) await this.assertVendor(trx, i.vendorId);
      const blockId = i.outOfOrder ? await this.takeOut(trx, propertyId, userId, r.room_id, i.outOfOrder, r.title, r.number) : null;
      const assigned = !!(i.assignedTo || i.vendorId);
      return { to: assigned ? 'ASSIGNED' : 'OPEN', note: i.note ?? null, patch: { approved_by: userId, approved_at: new Date(this.clock.now()), ...(blockId ? { block_id: blockId } : {}), ...(i.priority ? { priority: i.priority } : {}), ...(i.dueDate ? { due_date: i.dueDate } : {}),
        ...(i.estimatedCost ? { estimated_cost_minor: Money.parse(i.estimatedCost, 'PKR').minor.toString() } : {}), ...(assigned ? { assigned_to: i.assignedTo ?? null, vendor_id: i.vendorId ?? null, assigned_at: new Date(this.clock.now()) } : {}) } };
    }, 'approver');
  }
  reject(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Reject>) {
    return this.step(propertyId, id, userId, 'REJECT', async (_t, r) => { this.bad(r, ['REQUESTED']); return { to: 'REJECTED', patch: { rejected_reason: i.reason }, note: i.reason }; }, 'approver');
  }
  start(propertyId: string, id: string, userId: string) {
    return this.step(propertyId, id, userId, 'START', async (_t, r, _bd, mgr) => { this.bad(r, ['OPEN', 'ASSIGNED', 'WAITING']);
      if (r.status === 'OPEN' && !mgr) throw fail(409, 'NOT_ASSIGNED', 'Ask a manager to assign this work order first');
      return { to: 'IN_PROGRESS', patch: { started_at: r.started_at ?? new Date(this.clock.now()), ...(r.vendor_id ? {} : { assigned_to: r.assigned_to ?? userId }) } }; }, 'assignee');
  }
  wait(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Wait>) {
    return this.step(propertyId, id, userId, 'WAIT', async (_t, r) => { this.bad(r, ['IN_PROGRESS', 'ASSIGNED']); return { to: 'WAITING', note: i.reason }; }, 'assignee');
  }
  done(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Done>) {
    return this.step(propertyId, id, userId, 'DONE', async (_t, r) => { this.bad(r, ['IN_PROGRESS', 'ASSIGNED']);
      const cost = i.cost ? Money.parse(i.cost, 'PKR').minor : 0n;
      return { to: 'DONE', patch: { done_at: new Date(this.clock.now()), done_by: userId, done_note: i.note, cost_minor: cost.toString(), vendor: i.vendor ?? null }, note: i.note, amount: cost }; }, 'assignee');
  }
  /** Someone other than the person who did the work checks it. The room comes back, and the housekeeping report it came from is closed. */
  verify(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Verify>) {
    return this.step(propertyId, id, userId, 'VERIFY', async (trx, r, bd) => {
      this.bad(r, ['DONE']);
      if (r.done_by === userId) throw fail(403, 'SELF_VERIFICATION', 'A different person must check the work');
      await this.release(trx, propertyId, r, bd, userId, 'repaired');
      if (r.issue_id) await trx.updateTable('room_issue').set({ status: 'RESOLVED', resolved_by: userId, resolved_at: new Date(this.clock.now()), resolution_note: `Work order ${r.number}` } as never).where('id', '=', r.issue_id).where('status', '=', 'OPEN').execute();
      return { to: 'VERIFIED', patch: { verified_by: userId, verified_at: new Date(this.clock.now()) }, note: i.note };
    }, 'manager');
  }
  reopen(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Reopen>) {
    return this.step(propertyId, id, userId, 'REOPEN', async (_t, r) => { this.bad(r, ['DONE']); return { to: 'IN_PROGRESS', patch: { done_at: null, done_by: null }, note: i.reason }; }, 'manager');
  }
  cancel(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Cancel>) {
    return this.step(propertyId, id, userId, 'CANCEL', async (trx, r, bd) => { this.bad(r, ['REQUESTED', ...ACTIVE, 'DONE']); await this.release(trx, propertyId, r, bd, userId, 'cancelled'); return { to: 'CANCELLED', note: i.reason }; }, 'manager-or-requester');
  }
  addNote(propertyId: string, id: string, userId: string, i: z.infer<typeof S.AddNote>) {
    return this.tdb.tx(async (trx) => {
      const r = await this.row(trx, propertyId, id, true); const p = await this.prop(trx, propertyId);
      if (!(await this.can(userId, 'maintenance.manage', propertyId)) && r.assigned_to !== userId) throw fail(403, 'NOT_YOUR_JOB', 'This work order is assigned to someone else');
      await this.event(trx, id, 'NOTE', userId, { note: i.note });
      return this.view(trx, r, p.business_date);
    });
  }
  /** Gives the room back: the out-of-order block ends (today on, if it had begun) and the room is marked dirty so housekeeping makes it ready. */
  private async release(trx: Trx, propertyId: string, r: Row, bd: string, userId: string, why: string) {
    if (!r.block_id) return;
    const b = await trx.selectFrom('room_block').select(['id', 'start_date', 'end_date', 'cancelled_at']).where('id', '=', r.block_id).executeTakeFirst();
    if (!b || b.cancelled_at) return;
    if (b.end_date > bd) await this.setup.endBlockIn(trx, propertyId, b.id, b.start_date >= bd ? null : bd);
    if (r.room_id) await this.hk.setRoomHk(trx, propertyId, r.room_id, 'DIRTY', `Maintenance ${r.number} ${why}`);
    void userId;
  }

  // ───────────── reading ─────────────
  async list(propertyId: string, userId: string, q: z.infer<typeof S.ListQuery>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      let qb = trx.selectFrom('work_order').selectAll().where('property_id', '=', propertyId).orderBy('priority').orderBy(sql`due_date NULLS LAST`).orderBy('created_at').limit(q.limit);
      if (q.status === 'REQUESTED') qb = qb.where('status', '=', 'REQUESTED'); else if (q.status === 'OPEN') qb = qb.where('status', '=', 'OPEN'); else if (q.status === 'ACTIVE') qb = qb.where('status', 'in', ['REQUESTED', ...ACTIVE] as never); else if (q.status === 'DONE') qb = qb.where('status', 'in', ['DONE', 'VERIFIED'] as never);
      if (q.mine) qb = qb.where((eb) => eb.or([eb('assigned_to', '=', userId), eb('reported_by', '=', userId)]));          // mine = given to me, or asked for by me
      if (q.roomId) qb = qb.where('room_id', '=', q.roomId);
      if (q.kind) qb = qb.where('kind', '=', q.kind);
      if (q.vendorId) qb = qb.where('vendor_id', '=', q.vendorId);
      if (q.assignedTo) qb = qb.where('assigned_to', '=', q.assignedTo);
      if (q.category) qb = qb.where('category', '=', q.category);
      const rows = await qb.execute();
      const items = []; for (const r of rows) items.push(await this.view(trx, r, p.business_date));
      const counts = await sql<{ status: string; n: number }>`SELECT status, count(*)::int AS n FROM work_order WHERE tenant_id = ${currentTenant().tenantId} AND property_id = ${propertyId} GROUP BY status`.execute(trx);
      return { items, counts: Object.fromEntries(counts.rows.map((c) => [c.status, c.n])) };
    });
  }
  async get(propertyId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const r = await this.row(trx, propertyId, id);
      const ev = await trx.selectFrom('work_order_event as e').leftJoin('staff_user as u', 'u.id', 'e.actor_id').select(['e.action', 'e.from_status', 'e.to_status', 'e.note', 'e.amount_minor', 'e.at', 'u.full_name']).where('e.work_order_id', '=', id).orderBy('e.at').execute();
      return { ...(await this.view(trx, r, p.business_date)), events: ev.map((e) => ({ action: e.action, from: e.from_status, to: e.to_status, note: e.note, amount: e.amount_minor ? fmt(e.amount_minor) : null, at: e.at, by: e.full_name })) };
    });
  }
  async technicians(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      const rows = await sql<{ id: string; full_name: string }>`SELECT DISTINCT u.id, u.full_name FROM staff_user u
        JOIN role_assignment ra ON ra.tenant_id = u.tenant_id AND ra.user_id = u.id JOIN role_permission rp ON rp.tenant_id = ra.tenant_id AND rp.role_id = ra.role_id AND rp.permission_key = 'maintenance.work'
        WHERE u.tenant_id = ${currentTenant().tenantId} AND u.status <> 'DISABLED' AND (ra.valid_to IS NULL OR ra.valid_to > now()) AND ra.valid_from <= now()
          AND (ra.scope_type = 'TENANT' OR (ra.scope_type = 'PROPERTY' AND ra.scope_id = ${propertyId}))
          AND NOT EXISTS (SELECT 1 FROM role_permission x WHERE x.tenant_id = ra.tenant_id AND x.role_id = ra.role_id AND x.permission_key = 'tenant.manage')
        ORDER BY u.full_name`.execute(trx);
      return { items: rows.rows.map((r) => ({ id: r.id, name: r.full_name })) };
    });
  }

  /** Counts and money, grouped the way a manager asks: by kind of work, by contractor (contract), by in-house technician, or by trade. */
  async summary(propertyId: string, q: z.infer<typeof S.SummaryQuery>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const rows = await trx.selectFrom('work_order').selectAll().where('property_id', '=', propertyId).where('status', '<>', 'CANCELLED').execute();
      const names = new Map<string, string>();
      for (const u of await trx.selectFrom('staff_user').select(['id', 'full_name']).execute()) names.set(u.id, u.full_name);
      for (const v of await trx.selectFrom('maintenance_vendor').select(['id', 'name']).execute()) names.set(v.id, v.name);
      const keyOf = (r: Row) => q.by === 'kind' ? r.kind : q.by === 'category' ? r.category : q.by === 'vendor' ? r.vendor_id : r.assigned_to;
      const groups = new Map<string, { key: string | null; label: string | null; requested: number; open: number; active: number; done: number; overdue: number; estimated: bigint; actual: bigint }>();
      for (const r of rows) {
        const k = keyOf(r); if (q.by === 'vendor' && !k) continue; if (q.by === 'technician' && !k) continue;
        const g = groups.get(k ?? '') ?? { key: k, label: k ? names.get(k) ?? k : null, requested: 0, open: 0, active: 0, done: 0, overdue: 0, estimated: 0n, actual: 0n };
        if (r.status === 'REQUESTED') g.requested++; else if (r.status === 'OPEN') g.open++; else if (ACTIVE.includes(r.status)) g.active++; else if (['DONE', 'VERIFIED'].includes(r.status)) g.done++;
        if (r.due_date && ACTIVE.includes(r.status) && r.due_date < p.business_date) g.overdue++;
        g.estimated += BigInt(r.estimated_cost_minor ?? '0'); g.actual += BigInt(r.cost_minor);
        groups.set(k ?? '', g);
      }
      return { by: q.by, items: [...groups.values()].map((g) => ({ ...g, estimated: fmt(g.estimated), actual: fmt(g.actual) })).sort((a, b) => (b.open + b.active + b.requested) - (a.open + a.active + a.requested)) };
    });
  }

  // ───────────── third-party contractors ─────────────
  private vendorView(v: { id: string; name: string; trade: string; contact_name: string | null; phone: string | null; email: string | null; contract_ref: string | null; contract_start: string | null; contract_end: string | null; sla_response_hours: number | null; sla_fix_hours: number | null; notes: string | null; status: string }, today?: string) {
    return { id: v.id, name: v.name, trade: v.trade, contactName: v.contact_name, phone: v.phone, email: v.email, contractRef: v.contract_ref, contractStart: v.contract_start, contractEnd: v.contract_end,
      slaResponseHours: v.sla_response_hours, slaFixHours: v.sla_fix_hours, notes: v.notes, status: v.status, contractExpired: !!today && !!v.contract_end && v.contract_end < today };
  }
  async vendors(all: boolean) {
    return this.tdb.tx(async (trx) => {
      let q = trx.selectFrom('maintenance_vendor').selectAll().orderBy('name');
      if (!all) q = q.where('status', '=', 'ACTIVE');
      const today = new Date(this.clock.now()).toISOString().slice(0, 10);
      return { items: (await q.execute()).map((v) => this.vendorView(v, today)) };
    });
  }
  async createVendor(i: z.infer<typeof S.CreateVendor>) {
    return this.tdb.tx(async (trx) => {
      try {
        const v = await trx.insertInto('maintenance_vendor').values({ tenant_id: currentTenant().tenantId, name: i.name, trade: i.trade, contact_name: i.contactName ?? null, phone: i.phone ?? null, email: i.email ?? null, contract_ref: i.contractRef ?? null,
          contract_start: i.contractStart ?? null, contract_end: i.contractEnd ?? null, sla_response_hours: i.slaResponseHours ?? null, sla_fix_hours: i.slaFixHours ?? null, notes: i.notes ?? null } as never).returningAll().executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'maintenance.vendor_create', resourceType: 'maintenance_vendor', resourceId: v.id, after: { name: v.name, trade: v.trade } });
        return this.vendorView(v);
      } catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE_VENDOR', 'A contractor with this name already exists'); if ((e as { code?: string }).code === '23514') throw fail(422, 'VALIDATION_FAILED', 'The contract end date is before its start'); throw e; }
    });
  }
  async updateVendor(id: string, i: z.infer<typeof S.UpdateVendor>) {
    return this.tdb.tx(async (trx) => {
      const set: Record<string, unknown> = {};
      const map: Record<string, string> = { name: 'name', trade: 'trade', contactName: 'contact_name', phone: 'phone', email: 'email', contractRef: 'contract_ref', contractStart: 'contract_start', contractEnd: 'contract_end', slaResponseHours: 'sla_response_hours', slaFixHours: 'sla_fix_hours', notes: 'notes', status: 'status' };
      for (const [k, col] of Object.entries(map)) if ((i as Record<string, unknown>)[k] !== undefined) set[col] = (i as Record<string, unknown>)[k];
      if (!Object.keys(set).length) throw fail(422, 'VALIDATION_FAILED', 'Nothing to change');
      try {
        const v = await trx.updateTable('maintenance_vendor').set(set as never).where('id', '=', id).returningAll().executeTakeFirst();
        if (!v) throw fail(404, 'NOT_FOUND', 'Contractor not found');
        await this.audit.record(trx, { action: 'maintenance.vendor_update', resourceType: 'maintenance_vendor', resourceId: id, after: set });
        return this.vendorView(v);
      } catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE_VENDOR', 'A contractor with this name already exists'); if ((e as { code?: string }).code === '23514') throw fail(422, 'VALIDATION_FAILED', 'The contract end date is before its start'); throw e; }
    });
  }
}
