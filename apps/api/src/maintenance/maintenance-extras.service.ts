import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money, addDays } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { fmt, type Trx } from '../companies/companies.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { MediaService, mediaUrl } from '../media/media.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const MAX_MEDIA = 12; const MAX_VIDEOS = 2;
const CLOSED = ['VERIFIED', 'CANCELLED', 'REJECTED'];

/** Date arithmetic for a schedule's interval: months and years keep the day of the month, or the last day of a shorter month. */
export function addInterval(date: string, n: number, unit: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'): string {
  if (unit === 'DAY') return addDays(date, n);
  if (unit === 'WEEK') return addDays(date, 7 * n);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const months = (unit === 'MONTH' ? n : 12 * n) + (m - 1); const ty = y + Math.floor(months / 12); const tm = months % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** What goes with a work order besides its status: pictures and videos, the bills that have to be paid, and the recurring jobs that create orders by themselves. */
@Injectable()
export class MaintenanceExtrasService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuthorizationService) private readonly authz: AuthorizationService, @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService, @Inject(MediaService) private readonly media: MediaService, @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}
  private async can(userId: string, permission: string, propertyId: string) { return (await this.authz.check(userId, { permission, scope: { propertyId } })).effect === 'ALLOW'; }
  private async prop(trx: Trx, id: string) {
    const p = await trx.selectFrom('property').select(['id', 'code', 'currency', 'business_date']).where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return p;
  }
  private async order(trx: Trx, propertyId: string, id: string) {
    const r = await trx.selectFrom('work_order').selectAll().where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst();
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Work order not found' });
    return r;
  }
  private async event(trx: Trx, id: string, action: string, userId: string, note: string | null, amount?: bigint) {
    await trx.insertInto('work_order_event').values({ tenant_id: currentTenant().tenantId, work_order_id: id, action, note, amount_minor: amount?.toString() ?? null, actor_id: userId } as never).execute();
  }

  // ───────────── pictures and videos ─────────────
  async mediaOf(trx: Trx, orderId: string) {
    const rows = await trx.selectFrom('work_order_media as m').leftJoin('staff_user as u', 'u.id', 'm.uploaded_by').select(['m.id', 'm.kind', 'm.stage', 'm.file_name', 'm.caption', 'm.created_at', 'm.uploaded_by', 'u.full_name']).where('m.work_order_id', '=', orderId).orderBy('m.created_at').execute();
    const t = currentTenant().tenantId;
    return rows.map((m) => ({ id: m.id, kind: m.kind, stage: m.stage, url: mediaUrl(t, m.file_name, ''), caption: m.caption, by: m.full_name, uploadedBy: m.uploaded_by, at: m.created_at }));
  }
  /** The person who asked, whoever it is assigned to, and managers and approvers may add pictures; anyone who can see the job sees them. */
  async addMedia(propertyId: string, orderId: string, userId: string, data: Buffer) {
    const stored = await this.media.storePublic(data);
    try {
      return await this.tdb.tx(async (trx) => {
        const r = await this.order(trx, propertyId, orderId);
        if (CLOSED.includes(r.status)) throw fail(409, 'WRONG_STATE', 'Pictures cannot be added to a job that is closed');
        const mine = r.reported_by === userId || r.assigned_to === userId;
        if (!mine && !(await this.can(userId, 'maintenance.manage', propertyId)) && !(await this.can(userId, 'maintenance.approve', propertyId))) throw fail(403, 'NOT_YOUR_JOB', 'Only the person who asked, the one doing the work, or a manager can add pictures');
        const rows = await trx.selectFrom('work_order_media').select(['kind']).where('work_order_id', '=', orderId).execute();
        if (rows.length >= MAX_MEDIA) throw fail(409, 'PHOTO_LIMIT', `A job can have up to ${MAX_MEDIA} pictures and videos`);
        if (stored.kind === 'VIDEO' && rows.filter((x) => x.kind === 'VIDEO').length >= MAX_VIDEOS) throw fail(409, 'VIDEO_LIMIT', `A job can have up to ${MAX_VIDEOS} videos`);
        const stage = r.status === 'REQUESTED' ? 'REPORTED' : r.status === 'DONE' ? 'COMPLETED' : 'PROGRESS';
        const m = await trx.insertInto('work_order_media').values({ tenant_id: currentTenant().tenantId, work_order_id: orderId, kind: stored.kind, stage, file_name: stored.fileName, content_type: stored.contentType, size_bytes: String(stored.size), uploaded_by: userId } as never).returning('id').executeTakeFirstOrThrow();
        await this.event(trx, orderId, 'MEDIA', userId, `${stored.kind === 'VIDEO' ? 'Video' : 'Picture'} added (${stage.toLowerCase()})`);
        await this.audit.record(trx, { action: 'maintenance.media_add', resourceType: 'work_order', resourceId: orderId, propertyId, after: { mediaId: m.id, kind: stored.kind, stage } });
        return { id: m.id, kind: stored.kind, stage, url: mediaUrl(currentTenant().tenantId, stored.fileName, '') };
      });
    } catch (e) { await this.media.removePublic(stored.fileName); throw e; }
  }
  async removeMedia(propertyId: string, orderId: string, id: string, userId: string) {
    const gone = await this.tdb.tx(async (trx) => {
      const r = await this.order(trx, propertyId, orderId);
      const m = await trx.selectFrom('work_order_media').selectAll().where('id', '=', id).where('work_order_id', '=', orderId).executeTakeFirst();
      if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Picture not found' });
      if (m.uploaded_by !== userId && !(await this.can(userId, 'maintenance.manage', propertyId))) throw fail(403, 'PERMISSION_DENIED', 'Only the person who added it, or a manager, can remove it');
      if (CLOSED.includes(r.status)) throw fail(409, 'WRONG_STATE', 'A closed job keeps its pictures');
      await trx.deleteFrom('work_order_media').where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'maintenance.media_remove', resourceType: 'work_order', resourceId: orderId, propertyId, after: { mediaId: id } });
      return m.file_name;
    });
    await this.media.removePublic(gone);
  }

  // ───────────── bills ─────────────
  private async canSeeBills(userId: string, propertyId: string) { return (await this.can(userId, 'maintenance.manage', propertyId)) || (await this.can(userId, 'maintenance.approve', propertyId)) || (await this.can(userId, 'maintenance.pay', propertyId)); }
  private billView(b: Awaited<ReturnType<MaintenanceExtrasService['billRows']>>[number], cur: string) {
    return { id: b.id, workOrderId: b.work_order_id, orderNumber: b.number, orderTitle: b.title, vendorId: b.vendor_id, payee: b.vendor_name ?? b.payee, billNo: b.bill_no, billDate: b.bill_date, dueDate: b.due_date, amount: fmt(b.amount_minor, cur), note: b.note, hasFile: !!b.file_name, status: b.status,
      decidedAt: b.decided_at, rejectReason: b.reject_reason, paidAt: b.paid_at, paidMethod: b.paid_method, paidRef: b.paid_ref, createdAt: b.created_at };
  }
  private async billRows(trx: Trx, propertyId: string, where: { orderId?: string; status?: string[]; vendorId?: string; limit?: number }) {
    let q = trx.selectFrom('work_order_bill as b').innerJoin('work_order as o', 'o.id', 'b.work_order_id').leftJoin('maintenance_vendor as v', 'v.id', 'b.vendor_id')
      .select(['b.id', 'b.work_order_id', 'b.vendor_id', 'b.payee', 'b.bill_no', 'b.bill_date', 'b.due_date', 'b.amount_minor', 'b.note', 'b.file_name', 'b.status', 'b.decided_at', 'b.reject_reason', 'b.paid_at', 'b.paid_method', 'b.paid_ref', 'b.created_at', 'o.number', 'o.title', 'v.name as vendor_name'])
      .where('b.property_id', '=', propertyId).orderBy('b.created_at', 'desc').limit(where.limit ?? 200);
    if (where.orderId) q = q.where('b.work_order_id', '=', where.orderId);
    if (where.status) q = q.where('b.status', 'in', where.status as never);
    if (where.vendorId) q = q.where('b.vendor_id', '=', where.vendorId);
    return q.execute();
  }
  /** For one work order: its bills, what has been billed and paid against the estimate. Only people who deal with bills get them. */
  async billsOf(trx: Trx, propertyId: string, orderId: string, userId: string, cur: string, estimateMinor: string | null) {
    if (!(await this.canSeeBills(userId, propertyId))) return null;
    const rows = await this.billRows(trx, propertyId, { orderId });
    const live = rows.filter((b) => b.status !== 'REJECTED'); const billed = live.reduce((a, b) => a + BigInt(b.amount_minor), 0n); const paid = rows.filter((b) => b.status === 'PAID').reduce((a, b) => a + BigInt(b.amount_minor), 0n);
    return { items: rows.map((b) => this.billView(b, cur)), billed: fmt(billed, cur), paid: fmt(paid, cur), unpaid: fmt(billed - paid, cur), overEstimate: estimateMinor !== null && billed > BigInt(estimateMinor) };
  }
  async addBill(propertyId: string, orderId: string, userId: string, i: z.infer<typeof S.BillCreate>) {
    if (!(await this.can(userId, 'maintenance.manage', propertyId)) && !(await this.can(userId, 'maintenance.approve', propertyId))) throw fail(403, 'PERMISSION_DENIED', 'Recording a bill needs the "maintenance.manage" permission');
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const r = await this.order(trx, propertyId, orderId);
      if (['REQUESTED', 'REJECTED', 'CANCELLED'].includes(r.status)) throw fail(409, 'WRONG_STATE', 'A bill belongs to a job that was approved and not cancelled');
      const vendorId = i.vendorId ?? (i.payee ? null : r.vendor_id);
      if (!vendorId && !i.payee) throw fail(422, 'VALIDATION_FAILED', 'Say who the bill is from: choose the contractor or write the shop’s name', { field: 'payee' });
      if (vendorId && !(await trx.selectFrom('maintenance_vendor').select('id').where('id', '=', vendorId).executeTakeFirst())) throw fail(404, 'NOT_FOUND', 'Contractor not found');
      const amount = Money.parse(i.amount, p.currency).minor;
      if (amount <= 0n) throw fail(422, 'VALIDATION_FAILED', 'The amount must be more than zero', { field: 'amount' });
      try {
        const b = await trx.insertInto('work_order_bill').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, work_order_id: orderId, vendor_id: vendorId, payee: vendorId ? null : i.payee, bill_no: i.billNo, bill_date: i.billDate, due_date: i.dueDate ?? null, amount_minor: amount.toString(), note: i.note ?? null, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
        await this.event(trx, orderId, 'BILL', userId, `Bill ${i.billNo} recorded`, amount);
        await this.audit.record(trx, { action: 'maintenance.bill_add', resourceType: 'work_order', resourceId: orderId, propertyId, after: { billId: b.id, billNo: i.billNo, amount: amount.toString() } });
        return { id: b.id };
      } catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE', 'This contractor’s bill number is already recorded'); throw e; }
    });
  }
  private async billRow(trx: Trx, propertyId: string, orderId: string, id: string) {
    const b = await trx.selectFrom('work_order_bill').selectAll().where('id', '=', id).where('work_order_id', '=', orderId).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Bill not found' });
    return b;
  }
  async attachBill(propertyId: string, orderId: string, id: string, userId: string, data: Buffer) {
    if (!(await this.can(userId, 'maintenance.manage', propertyId)) && !(await this.can(userId, 'maintenance.approve', propertyId))) throw fail(403, 'PERMISSION_DENIED', 'Adding a bill needs the "maintenance.manage" permission');
    const stored = await this.media.storePrivate(data);
    try {
      const old = await this.tdb.tx(async (trx) => {
        const b = await this.billRow(trx, propertyId, orderId, id);
        if (b.status !== 'RECEIVED') throw fail(409, 'WRONG_STATE', 'The bill’s copy can only be changed before it is approved');
        await trx.updateTable('work_order_bill').set({ file_name: stored.fileName, content_type: stored.contentType } as never).where('id', '=', id).execute();
        await this.audit.record(trx, { action: 'maintenance.bill_file', resourceType: 'work_order', resourceId: orderId, propertyId, after: { billId: id } });
        return b.file_name;
      });
      if (old) await this.media.removePrivate(old);
      return { id, hasFile: true };
    } catch (e) { await this.media.removePrivate(stored.fileName); throw e; }
  }
  async billFile(propertyId: string, orderId: string, id: string, userId: string) {
    if (!(await this.canSeeBills(userId, propertyId))) throw fail(403, 'PERMISSION_DENIED', 'Bills are for people who manage, approve or pay them');
    const b = await this.tdb.tx((trx) => trx.selectFrom('work_order_bill').select(['file_name', 'bill_no']).where('id', '=', id).where('work_order_id', '=', orderId).where('property_id', '=', propertyId).executeTakeFirst());
    if (!b?.file_name) throw new NotFoundException({ code: 'NOT_FOUND', message: 'There is no copy of this bill' });
    return { ...(await this.media.openPrivate(b.file_name)), name: b.bill_no };
  }
  async approveBill(propertyId: string, orderId: string, id: string, userId: string, note: string | null) {
    return this.tdb.tx(async (trx) => {
      const b = await this.billRow(trx, propertyId, orderId, id);
      if (b.status !== 'RECEIVED') throw fail(409, 'WRONG_STATE', `A bill that is ${b.status.toLowerCase()} cannot be approved`);
      await trx.updateTable('work_order_bill').set({ status: 'APPROVED', decided_by: userId, decided_at: sql`now()` } as never).where('id', '=', id).execute();
      await this.event(trx, orderId, 'BILL_APPROVED', userId, note ?? `Bill ${b.bill_no} approved`, BigInt(b.amount_minor));
      await this.audit.record(trx, { action: 'maintenance.bill_approve', resourceType: 'work_order', resourceId: orderId, propertyId, after: { billId: id, amount: b.amount_minor } });
      return { id, status: 'APPROVED' };
    });
  }
  async rejectBill(propertyId: string, orderId: string, id: string, userId: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      const b = await this.billRow(trx, propertyId, orderId, id);
      if (!['RECEIVED', 'APPROVED'].includes(b.status)) throw fail(409, 'WRONG_STATE', `A bill that is ${b.status.toLowerCase()} cannot be rejected`);
      await trx.updateTable('work_order_bill').set({ status: 'REJECTED', decided_by: userId, decided_at: sql`now()`, reject_reason: reason } as never).where('id', '=', id).execute();
      await this.event(trx, orderId, 'BILL_REJECTED', userId, reason, BigInt(b.amount_minor));
      await this.audit.record(trx, { action: 'maintenance.bill_reject', resourceType: 'work_order', resourceId: orderId, propertyId, after: { billId: id, reason } });
      return { id, status: 'REJECTED' };
    });
  }
  async payBill(propertyId: string, orderId: string, id: string, userId: string, i: z.infer<typeof S.BillPay>) {
    return this.tdb.tx(async (trx) => {
      const b = await this.billRow(trx, propertyId, orderId, id);
      if (b.status !== 'APPROVED') throw fail(409, 'WRONG_STATE', b.status === 'PAID' ? 'This bill is already paid' : 'A bill must be approved before it is paid');
      await trx.updateTable('work_order_bill').set({ status: 'PAID', paid_by: userId, paid_at: sql`now()`, paid_method: i.method, paid_ref: i.ref ?? null } as never).where('id', '=', id).execute();
      await this.event(trx, orderId, 'BILL_PAID', userId, `Bill ${b.bill_no} paid by ${i.method.toLowerCase().replace('_', ' ')}${i.ref ? ` (${i.ref})` : ''}`, BigInt(b.amount_minor));
      await this.audit.record(trx, { action: 'maintenance.bill_pay', resourceType: 'work_order', resourceId: orderId, propertyId, after: { billId: id, amount: b.amount_minor, method: i.method, ref: i.ref ?? null } });
      return { id, status: 'PAID' };
    });
  }
  /** What is owed to contractors: bills waiting for approval, approved and unpaid, and paid, in total and by contractor. */
  async bills(propertyId: string, userId: string, q: z.infer<typeof S.BillQuery>) {
    if (!(await this.canSeeBills(userId, propertyId))) throw fail(403, 'PERMISSION_DENIED', 'Bills are for people who manage, approve or pay them');
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const status = q.status === 'ALL' ? undefined : q.status === 'OPEN' ? ['RECEIVED', 'APPROVED'] : [q.status];
      const rows = await this.billRows(trx, propertyId, { status, vendorId: q.vendorId, limit: q.limit });
      const all = await this.billRows(trx, propertyId, { limit: 1000 });
      const sum = (st: string) => all.filter((b) => b.status === st).reduce((a, b) => a + BigInt(b.amount_minor), 0n);
      const owed = new Map<string, bigint>();
      for (const b of all.filter((x) => x.status === 'APPROVED')) { const k = b.vendor_name ?? b.payee ?? '—'; owed.set(k, (owed.get(k) ?? 0n) + BigInt(b.amount_minor)); }
      return { items: rows.map((b) => this.billView(b, p.currency)), totals: { awaitingApproval: fmt(sum('RECEIVED'), p.currency), approvedUnpaid: fmt(sum('APPROVED'), p.currency), paid: fmt(sum('PAID'), p.currency) },
        owedByPayee: [...owed.entries()].map(([payee, m]) => ({ payee, amount: fmt(m, p.currency) })).sort((a, b) => Number(b.amount.amount) - Number(a.amount.amount)) };
    });
  }

  // ───────────── recurring preventive jobs ─────────────
  private scheduleView(s: Awaited<ReturnType<MaintenanceExtrasService['scheduleRows']>>[number], cur: string) {
    return { id: s.id, title: s.title, description: s.description, category: s.category, priority: s.priority, roomId: s.room_id, room: s.room, area: s.area, everyN: s.every_n, unit: s.unit, nextDue: s.next_due, leadDays: s.lead_days, assignedTo: s.assigned_to, assignee: s.assignee, vendorId: s.vendor_id, contractor: s.vendor,
      estimatedCost: s.estimated_cost_minor === null ? null : fmt(s.estimated_cost_minor, cur), active: s.active, lastCreatedFor: s.last_created_for };
  }
  private scheduleRows(trx: Trx, propertyId: string) {
    return trx.selectFrom('maintenance_schedule as s').leftJoin('room as r', 'r.id', 's.room_id').leftJoin('staff_user as u', 'u.id', 's.assigned_to').leftJoin('maintenance_vendor as v', 'v.id', 's.vendor_id')
      .select(['s.id', 's.title', 's.description', 's.category', 's.priority', 's.room_id', 's.area', 's.every_n', 's.unit', 's.next_due', 's.lead_days', 's.assigned_to', 's.vendor_id', 's.estimated_cost_minor', 's.active', 's.last_created_for', 'r.number as room', 'u.full_name as assignee', 'v.name as vendor'])
      .where('s.property_id', '=', propertyId).orderBy('s.next_due').orderBy('s.title').execute();
  }
  async schedules(propertyId: string) {
    return this.tdb.tx(async (trx) => { const p = await this.prop(trx, propertyId); return { items: (await this.scheduleRows(trx, propertyId)).map((s) => this.scheduleView(s, p.currency)) }; });
  }
  async createSchedules(propertyId: string, userId: string, i: z.infer<typeof S.ScheduleCreate>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      if (i.assignedTo && !(await this.can(i.assignedTo, 'maintenance.work', propertyId))) throw fail(422, 'NOT_A_TECHNICIAN', 'That person cannot be given maintenance work');
      if (i.vendorId && !(await trx.selectFrom('maintenance_vendor').select('id').where('id', '=', i.vendorId).where('status', '=', 'ACTIVE').executeTakeFirst())) throw fail(422, 'VENDOR_INVALID', 'Choose an active contractor');
      if (i.roomIds.length) {
        const found = await trx.selectFrom('room').select('id').where('property_id', '=', propertyId).where('id', 'in', i.roomIds).execute();
        if (found.length !== new Set(i.roomIds).size) throw fail(404, 'NOT_FOUND', 'A room was not found');
      }
      const targets: Array<string | null> = i.roomIds.length ? [...new Set(i.roomIds)] : [null];
      const ids: string[] = [];
      for (const room of targets) {
        const s = await trx.insertInto('maintenance_schedule').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, title: i.title, description: i.description ?? null, category: i.category, priority: i.priority, room_id: room, area: room ? null : i.area ?? null,
          every_n: i.everyN, unit: i.unit, next_due: i.firstDue, lead_days: i.leadDays, assigned_to: i.assignedTo ?? null, vendor_id: i.vendorId ?? null, estimated_cost_minor: i.estimatedCost ? Money.parse(i.estimatedCost, p.currency).minor.toString() : null, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
        ids.push(s.id);
      }
      await this.audit.record(trx, { action: 'maintenance.schedule_create', resourceType: 'maintenance_schedule', resourceId: ids[0]!, propertyId, after: { title: i.title, every: `${i.everyN} ${i.unit}`, count: ids.length } });
      return { ids };
    });
  }
  async updateSchedule(propertyId: string, id: string, userId: string, i: z.infer<typeof S.ScheduleUpdate>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const cur = await trx.selectFrom('maintenance_schedule').selectAll().where('id', '=', id).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Schedule not found' });
      const m: Record<string, unknown> = {};
      if (i.title !== undefined) m.title = i.title; if (i.description !== undefined) m.description = i.description; if (i.priority !== undefined) m.priority = i.priority; if (i.area !== undefined) m.area = i.area;
      if (i.everyN !== undefined) m.every_n = i.everyN; if (i.unit !== undefined) m.unit = i.unit; if (i.nextDue !== undefined) m.next_due = i.nextDue; if (i.leadDays !== undefined) m.lead_days = i.leadDays; if (i.active !== undefined) m.active = i.active;
      if (i.estimatedCost !== undefined) m.estimated_cost_minor = i.estimatedCost === null ? null : Money.parse(i.estimatedCost, p.currency).minor.toString();
      if (i.assignedTo !== undefined || i.vendorId !== undefined) {
        const to = i.assignedTo !== undefined ? i.assignedTo : cur.assigned_to; const v = i.vendorId !== undefined ? i.vendorId : cur.vendor_id;
        if (to && v) { if (i.assignedTo && !i.vendorId) m.vendor_id = null; else if (i.vendorId && !i.assignedTo) m.assigned_to = null; else throw fail(422, 'VALIDATION_FAILED', 'Choose a technician or a contractor, not both'); }
        if (to && !(await this.can(to, 'maintenance.work', propertyId))) throw fail(422, 'NOT_A_TECHNICIAN', 'That person cannot be given maintenance work');
        if (i.assignedTo !== undefined) m.assigned_to = i.assignedTo; if (i.vendorId !== undefined) m.vendor_id = i.vendorId;
        if (i.assignedTo && i.vendorId === undefined) m.vendor_id = null; if (i.vendorId && i.assignedTo === undefined) m.assigned_to = null;
      }
      if (!Object.keys(m).length) throw fail(422, 'VALIDATION_FAILED', 'Nothing to change');
      await trx.updateTable('maintenance_schedule').set(m as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'maintenance.schedule_update', resourceType: 'maintenance_schedule', resourceId: id, propertyId, after: m });
      return { id };
    });
  }

  /**
   * Creates the work orders for every schedule that is due within its lead time, once per due date, already approved (whoever made the schedule approved it) and given to the technician or
   * contractor the schedule names. Then moves the schedule to its next date, skipping any dates already missed so a long gap does not bury the board in old jobs. Runs at the end of each night audit.
   */
  async generateDueIn(trx: Trx, propertyId: string, today: string, userId: string | null) {
    const p = await this.prop(trx, propertyId);
    const due = await trx.selectFrom('maintenance_schedule').selectAll().where('property_id', '=', propertyId).where('active', '=', true).where(sql<boolean>`next_due - lead_days <= ${today}::date`).forUpdate().execute();
    let created = 0;
    for (const s of due) {
      const dueDate = String(s.next_due).slice(0, 10);
      const exists = await trx.selectFrom('work_order').select('id').where('schedule_id', '=', s.id).where('due_date', '=', dueDate).executeTakeFirst();
      if (!exists) {
        const seq = (await sql<{ v: string }>`INSERT INTO property_counter (tenant_id, property_id, name, value) VALUES (${currentTenant().tenantId}, ${propertyId}, 'workorder', 1)
          ON CONFLICT (tenant_id, property_id, name) DO UPDATE SET value = property_counter.value + 1 RETURNING value::text AS v`.execute(trx)).rows[0]!.v;
        const assigned = !!(s.assigned_to || s.vendor_id); const now = new Date(this.clock.now());
        const o = await trx.insertInto('work_order').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, number: `${p.code}-WO${seq.padStart(5, '0')}`, room_id: s.room_id, area: s.area, category: s.category, title: s.title, description: s.description, priority: s.priority, kind: 'PREVENTIVE',
          estimated_cost_minor: s.estimated_cost_minor, status: assigned ? 'ASSIGNED' : 'OPEN', assigned_to: s.assigned_to, vendor_id: s.vendor_id, assigned_at: assigned ? now : null, due_date: dueDate, reported_by: s.created_by, approved_by: s.created_by, approved_at: now, schedule_id: s.id } as never).returning(['id', 'number']).executeTakeFirstOrThrow();
        await this.event(trx, o.id, 'CREATE', userId ?? s.created_by, `Scheduled: every ${s.every_n} ${s.unit.toLowerCase()}${s.every_n > 1 ? 's' : ''}, due ${dueDate}`);
        await this.audit.record(trx, { action: 'maintenance.scheduled_create', resourceType: 'work_order', resourceId: o.id, propertyId, after: { number: o.number, scheduleId: s.id, dueDate } });
        await this.outbox.publish(trx, { aggregateType: 'work_order', aggregateId: o.id, eventType: 'WorkOrderCreated', propertyId, businessDate: p.business_date, payload: { workOrderId: o.id, number: o.number, roomId: s.room_id, priority: s.priority, outOfOrder: false } });
        created++;
      }
      let next = addInterval(dueDate, s.every_n, s.unit);
      while (next < today) next = addInterval(next, s.every_n, s.unit);
      await trx.updateTable('maintenance_schedule').set({ next_due: next, last_created_for: dueDate } as never).where('id', '=', s.id).execute();
    }
    return { created };
  }
  /** The same, on demand, for the property's current business date. */
  async runDue(propertyId: string, userId: string) {
    return this.tdb.tx(async (trx) => { const p = await this.prop(trx, propertyId); return this.generateDueIn(trx, propertyId, p.business_date, userId); });
  }
}
