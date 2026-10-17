import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import type { DB } from '@hos/db';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { TenantDb } from '../db/tenant-db.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

type Trx = Transaction<DB>;
type Hk = 'CLEAN' | 'DIRTY' | 'CLEANING' | 'INSPECTED';
type TaskType = (typeof import('./schemas.js'))['TASK_TYPES'][number];
const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const CREDIT: Record<TaskType, number> = { CHECKOUT_CLEAN: 1, STAYOVER: 0.5, ARRIVAL_PREP: 0.5, DEEP_CLEAN: 2, ON_DEMAND: 0.5 };
const OFFLINE_WINDOW_MS = 48 * 3_600_000;

@Injectable()
export class HousekeepingService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  private async prop(trx: Trx, id: string) {
    const p = await trx.selectFrom('property').select(['id', 'business_date', 'hk_require_inspection']).where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return p;
  }
  private async task(trx: Trx, propertyId: string, id: string, lock = true) {
    let q = trx.selectFrom('housekeeping_task').selectAll().where('id', '=', id).where('property_id', '=', propertyId);
    if (lock) q = q.forUpdate();
    const t = await q.executeTakeFirst();
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Task not found' });
    return t;
  }
  /** Offline devices report when something really happened; we accept it only inside a sane window. */
  private when(at?: string): Date {
    const now = this.clock.now();
    const t = at ? Date.parse(at) : NaN;
    return new Date(Number.isFinite(t) && t <= now + 60_000 && t >= now - OFFLINE_WINDOW_MS ? Math.min(t, now) : now);
  }
  private async isSupervisor(userId: string, propertyId: string) { return (await this.authz.check(userId, { permission: 'housekeeping.assign', scope: { propertyId } })).effect === 'ALLOW'; }

  /** The only place a room's housekeeping state changes. */
  async setRoomHk(trx: Trx, propertyId: string, roomId: string, status: Hk, reason: string) {
    const r = await trx.selectFrom('room').select(['number', 'hk_status']).where('id', '=', roomId).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room not found' });
    if (r.hk_status === status) return r;
    await trx.updateTable('room').set({ hk_status: status, hk_updated_at: new Date(this.clock.now()), version: sql`version + 1` as never }).where('id', '=', roomId).execute();
    await this.outbox.publish(trx, { aggregateType: 'room', aggregateId: roomId, eventType: 'RoomStatusChanged', propertyId, payload: { roomId, number: r.number, hkStatus: status, previous: r.hk_status, reason } });
    return r;
  }

  // ───────────── creation ─────────────
  private async insertTask(trx: Trx, propertyId: string, a: { roomId: string; type: TaskType; date: string; priority: number; sourceKey?: string; notes?: string | null; status?: 'PENDING' | 'SKIPPED'; skipReason?: string; assignedTo?: string | null; userId?: string }) {
    const row = await trx.insertInto('housekeeping_task').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, room_id: a.roomId, task_type: a.type, business_date: a.date, priority: a.priority,
      status: a.status ?? 'PENDING', skip_reason: a.skipReason ?? null, assigned_to: a.assignedTo ?? null, credit: CREDIT[a.type], notes: a.notes ?? null, source_key: a.sourceKey ?? null, created_by: a.userId ?? currentTenant().actorId ?? null } as never)
      .onConflict((oc) => oc.columns(['tenant_id', 'property_id', 'source_key']).where('source_key', 'is not', null).doNothing()).returning('id').executeTakeFirst();
    if (row) await this.outbox.publish(trx, { aggregateType: 'housekeeping_task', aggregateId: row.id, eventType: 'HousekeepingTaskCreated', propertyId, payload: { taskId: row.id, roomId: a.roomId, type: a.type, priority: a.priority } });
    return row?.id ?? null;
  }

  /** Called when a room is vacated (check-out or in-house move): the room turns dirty and a clean is queued. A same-day arrival makes it urgent. */
  async onRoomVacated(trx: Trx, propertyId: string, roomId: string, lineId: string, reason: string, userId?: string) {
    const p = await this.prop(trx, propertyId);
    await this.setRoomHk(trx, propertyId, roomId, 'DIRTY', reason);
    await trx.updateTable('room').set({ dnd: false }).where('id', '=', roomId).execute();
    // a pending stay-over service for this room is moot now
    await trx.updateTable('housekeeping_task').set({ status: 'CANCELLED', skip_reason: 'Guest left' }).where('room_id', '=', roomId).where('task_type', '=', 'STAYOVER').where('status', '=', 'PENDING').execute();
    const arriving = await sql<{ vip: boolean }>`SELECT g.vip FROM room_assignment a JOIN reservation_room l ON l.id = a.assignment_ref JOIN reservation r ON r.id = l.reservation_id JOIN guest g ON g.id = r.guest_id
      WHERE a.room_id = ${roomId} AND a.status = 'ASSIGNED' AND l.status = 'CONFIRMED' AND l.arrival <= ${p.business_date}::date AND l.departure > ${p.business_date}::date LIMIT 1`.execute(trx);
    const priority = arriving.rows[0] ? (arriving.rows[0].vip ? 1 : 2) : 3;
    await this.insertTask(trx, propertyId, { roomId, type: 'CHECKOUT_CLEAN', date: p.business_date, priority, sourceKey: `CHECKOUT_CLEAN:${roomId}:${lineId}`, userId });
  }

  /** Daily generation (the night audit will call this). Repeatable: running it twice creates nothing new. */
  async generate(propertyId: string, userId?: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const bd = p.business_date;
      const out = { stayovers: 0, skippedDnd: 0, arrivalPrep: 0, deepClean: 0, prioritised: 0 };
      const stay = await sql<{ room_id: string; dnd: boolean; hk_status: Hk }>`SELECT a.room_id, r.dnd, r.hk_status FROM room_assignment a JOIN reservation_room l ON l.id = a.assignment_ref JOIN room r ON r.id = a.room_id
        WHERE a.tenant_id = ${currentTenant().tenantId} AND a.property_id = ${propertyId} AND a.status = 'IN_HOUSE' AND l.arrival < ${bd}::date AND l.departure > ${bd}::date`.execute(trx);
      for (const s of stay.rows) {
        const id = await this.insertTask(trx, propertyId, { roomId: s.room_id, type: 'STAYOVER', date: bd, priority: 4, sourceKey: `STAYOVER:${s.room_id}:${bd}`, userId, ...(s.dnd ? { status: 'SKIPPED' as const, skipReason: 'Do not disturb' } : {}) });
        if (!id) continue;
        if (s.dnd) out.skippedDnd++; else { out.stayovers++; if (s.hk_status === 'CLEAN' || s.hk_status === 'INSPECTED') await this.setRoomHk(trx, propertyId, s.room_id, 'DIRTY', 'STAYOVER_DUE'); }
      }
      const arr = await sql<{ room_id: string; vip: boolean; hk_status: Hk }>`SELECT a.room_id, g.vip, r.hk_status FROM room_assignment a JOIN reservation_room l ON l.id = a.assignment_ref JOIN reservation res ON res.id = l.reservation_id
        JOIN guest g ON g.id = res.guest_id JOIN room r ON r.id = a.room_id
        WHERE a.tenant_id = ${currentTenant().tenantId} AND a.property_id = ${propertyId} AND a.status = 'ASSIGNED' AND l.status = 'CONFIRMED' AND l.arrival = ${bd}::date`.execute(trx);
      for (const a of arr.rows) {
        const pr = a.vip ? 1 : 2;
        const raised = await trx.updateTable('housekeeping_task').set({ priority: pr }).where('room_id', '=', a.room_id).where('status', 'in', ['PENDING', 'IN_PROGRESS']).where('priority', '>', pr).returning('id').execute();
        out.prioritised += raised.length;
        if (a.hk_status === 'DIRTY') {
          const open = await trx.selectFrom('housekeeping_task').select('id').where('room_id', '=', a.room_id).where('status', 'in', ['PENDING', 'IN_PROGRESS']).executeTakeFirst();
          if (!open && await this.insertTask(trx, propertyId, { roomId: a.room_id, type: 'ARRIVAL_PREP', date: bd, priority: pr, sourceKey: `ARRIVAL_PREP:${a.room_id}:${bd}`, userId })) out.arrivalPrep++;
        }
      }
      const back = await trx.selectFrom('room_block').select('room_id').where('property_id', '=', propertyId).where('cancelled_at', 'is', null).where('block_type', '=', 'OUT_OF_ORDER').where('end_date', '=', bd).execute();
      for (const b of back) if (await this.insertTask(trx, propertyId, { roomId: b.room_id, type: 'DEEP_CLEAN', date: bd, priority: 3, sourceKey: `DEEP_CLEAN:${b.room_id}:${bd}`, notes: 'Back from out-of-order', userId })) { out.deepClean++; await this.setRoomHk(trx, propertyId, b.room_id, 'DIRTY', 'BACK_IN_SERVICE'); }
      await this.audit.record(trx, { action: 'housekeeping.generate', resourceType: 'property', resourceId: propertyId, propertyId, after: out });
      return { businessDate: bd, ...out };
    });
  }

  async createManual(propertyId: string, userId: string, i: z.infer<typeof S.CreateTask>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const room = await trx.selectFrom('room').select(['id', 'number', 'status']).where('id', '=', i.roomId).where('property_id', '=', propertyId).executeTakeFirst();
      if (!room || room.status !== 'ACTIVE') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room not found' });
      if (i.assignTo) await this.assertAttendant(i.assignTo, propertyId);
      const id = await this.insertTask(trx, propertyId, { roomId: i.roomId, type: i.taskType, date: p.business_date, priority: i.priority, notes: i.notes, assignedTo: i.assignTo, userId, sourceKey: `MANUAL:${crypto.randomUUID()}` });
      await this.audit.record(trx, { action: 'housekeeping.task_create', resourceType: 'housekeeping_task', resourceId: id!, propertyId, after: { room: room.number, type: i.taskType } });
      return this.taskView(trx, id!);
    });
  }
  private async assertAttendant(assigneeId: string, propertyId: string) {
    const d = await this.authz.check(assigneeId, { permission: 'housekeeping.update', scope: { propertyId } });
    if (d.effect !== 'ALLOW') throw fail(422, 'NOT_AN_ATTENDANT', 'That person cannot be given housekeeping tasks at this property');
  }

  // ───────────── assignment and the attendant's flow ─────────────
  async assign(propertyId: string, userId: string, i: z.infer<typeof S.AssignTasks>) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      if (i.assigneeId) await this.assertAttendant(i.assigneeId, propertyId);
      const rows = await trx.selectFrom('housekeeping_task').select(['id', 'status']).where('property_id', '=', propertyId).where('id', 'in', i.taskIds).forUpdate().execute();
      if (rows.length !== new Set(i.taskIds).size) throw new NotFoundException({ code: 'NOT_FOUND', message: 'A task was not found' });
      const bad = rows.find((r) => r.status !== 'PENDING');
      if (bad) throw fail(409, 'TASK_NOT_PENDING', 'Only tasks that have not been started can be reassigned');
      await trx.updateTable('housekeeping_task').set({ assigned_to: i.assigneeId, version: sql`version + 1` as never }).where('id', 'in', i.taskIds).execute();
      await this.audit.record(trx, { action: 'housekeeping.assign', resourceType: 'property', resourceId: propertyId, propertyId, after: { taskIds: i.taskIds, assigneeId: i.assigneeId } });
      if (i.assigneeId) await this.outbox.publish(trx, { aggregateType: 'housekeeping_task', aggregateId: i.taskIds[0]!, eventType: 'HousekeepingTasksAssigned', propertyId, payload: { taskIds: i.taskIds, assigneeId: i.assigneeId } });
      return { assigned: rows.length };
    });
  }

  async start(propertyId: string, id: string, userId: string, i: z.infer<typeof S.StartTask>) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const t = await this.task(trx, propertyId, id);
      if (t.status === 'IN_PROGRESS' && t.assigned_to === userId) return this.taskView(trx, id);                       // a replayed offline action changes nothing
      if (t.status !== 'PENDING') throw fail(409, 'TASK_NOT_PENDING', 'This task is already done or closed');
      if (t.assigned_to && t.assigned_to !== userId && !(await this.isSupervisor(userId, propertyId))) throw fail(403, 'NOT_YOUR_TASK', 'This task is assigned to someone else');
      const open = await trx.selectFrom('housekeeping_task').select('id').where('assigned_to', '=', userId).where('status', '=', 'IN_PROGRESS').where('id', '<>', id).executeTakeFirst();
      if (open) throw fail(409, 'ALREADY_CLEANING', 'Finish or release the room you are cleaning first');
      await trx.updateTable('housekeeping_task').set({ status: 'IN_PROGRESS', assigned_to: t.assigned_to ?? userId, started_at: this.when(i.at), version: sql`version + 1` as never }).where('id', '=', id).execute();
      await this.setRoomHk(trx, propertyId, t.room_id, 'CLEANING', 'TASK_STARTED');
      await this.outbox.publish(trx, { aggregateType: 'housekeeping_task', aggregateId: id, eventType: 'HousekeepingTaskStarted', propertyId, payload: { taskId: id, roomId: t.room_id, userId } });
      return this.taskView(trx, id);
    });
  }

  async finish(propertyId: string, id: string, userId: string, i: z.infer<typeof S.FinishTask>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const t = await this.task(trx, propertyId, id);
      if (t.status === 'DONE' && t.assigned_to === userId) return this.taskView(trx, id);
      if (t.status !== 'IN_PROGRESS' && t.status !== 'PENDING') throw fail(409, 'TASK_NOT_OPEN', 'This task is already closed');
      if (t.assigned_to && t.assigned_to !== userId && !(await this.isSupervisor(userId, propertyId))) throw fail(403, 'NOT_YOUR_TASK', 'This task is assigned to someone else');
      const at = this.when(i.at);
      const needsInspection = p.hk_require_inspection && t.task_type !== 'STAYOVER';
      await trx.updateTable('housekeeping_task').set({ status: 'DONE', assigned_to: t.assigned_to ?? userId, started_at: t.started_at ?? at, finished_at: at, inspection: needsInspection ? 'PENDING' : null,
        notes: i.notes ? [t.notes, i.notes].filter(Boolean).join(' · ') : t.notes, version: sql`version + 1` as never }).where('id', '=', id).execute();
      await this.setRoomHk(trx, propertyId, t.room_id, 'CLEAN', 'TASK_FINISHED');
      await this.outbox.publish(trx, { aggregateType: 'housekeeping_task', aggregateId: id, eventType: 'HousekeepingTaskFinished', propertyId, payload: { taskId: id, roomId: t.room_id, userId, needsInspection } });
      return this.taskView(trx, id);
    });
  }

  /** Interrupted or reassigned: the room goes back to dirty and the task back in the queue. */
  async release(propertyId: string, id: string, userId: string) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const t = await this.task(trx, propertyId, id);
      if (t.status === 'PENDING') return this.taskView(trx, id);
      if (t.status !== 'IN_PROGRESS') throw fail(409, 'TASK_NOT_OPEN', 'Only a task in progress can be released');
      if (t.assigned_to !== userId && !(await this.isSupervisor(userId, propertyId))) throw fail(403, 'NOT_YOUR_TASK', 'This task is assigned to someone else');
      await trx.updateTable('housekeeping_task').set({ status: 'PENDING', started_at: null, version: sql`version + 1` as never }).where('id', '=', id).execute();
      await this.setRoomHk(trx, propertyId, t.room_id, 'DIRTY', 'TASK_RELEASED');
      return this.taskView(trx, id);
    });
  }

  async skip(propertyId: string, id: string, userId: string, i: z.infer<typeof S.SkipTask>) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const t = await this.task(trx, propertyId, id);
      if (t.status === 'SKIPPED') return this.taskView(trx, id);
      if (!['PENDING', 'IN_PROGRESS'].includes(t.status)) throw fail(409, 'TASK_NOT_OPEN', 'This task is already closed');
      if (t.task_type !== 'STAYOVER' && t.task_type !== 'ON_DEMAND') throw fail(422, 'NOT_SKIPPABLE', 'A room that has to be made ready cannot be skipped. Ask a supervisor to cancel it.');
      if (t.assigned_to && t.assigned_to !== userId && !(await this.isSupervisor(userId, propertyId))) throw fail(403, 'NOT_YOUR_TASK', 'This task is assigned to someone else');
      await trx.updateTable('housekeeping_task').set({ status: 'SKIPPED', skip_reason: i.reason, finished_at: this.when(i.at), version: sql`version + 1` as never }).where('id', '=', id).execute();
      if (t.task_type === 'STAYOVER') await this.setRoomHk(trx, propertyId, t.room_id, 'CLEAN', 'SERVICE_DECLINED');
      await this.audit.record(trx, { action: 'housekeeping.skip', resourceType: 'housekeeping_task', resourceId: id, propertyId, note: i.reason });
      return this.taskView(trx, id);
    });
  }

  async cancel(propertyId: string, id: string, userId: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const t = await this.task(trx, propertyId, id);
      if (t.status === 'CANCELLED') return this.taskView(trx, id);
      if (!['PENDING', 'IN_PROGRESS'].includes(t.status)) throw fail(409, 'TASK_NOT_OPEN', 'This task is already closed');
      await trx.updateTable('housekeeping_task').set({ status: 'CANCELLED', skip_reason: reason, version: sql`version + 1` as never }).where('id', '=', id).execute();
      if (t.status === 'IN_PROGRESS') await this.setRoomHk(trx, propertyId, t.room_id, 'DIRTY', 'TASK_CANCELLED');
      await this.audit.record(trx, { action: 'housekeeping.cancel', resourceType: 'housekeeping_task', resourceId: id, propertyId, note: reason });
      return this.taskView(trx, id);
    });
  }

  async inspect(propertyId: string, id: string, userId: string, i: z.infer<typeof S.InspectTask>) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const t = await this.task(trx, propertyId, id);
      if (t.status !== 'DONE' || t.inspection !== 'PENDING') throw fail(409, 'NOT_AWAITING_INSPECTION', 'This task is not waiting for inspection');
      if (t.assigned_to === userId) throw fail(403, 'SELF_INSPECTION', 'Someone other than the attendant must inspect the room');
      if (!i.pass && !i.note) throw fail(422, 'NOTE_REQUIRED', 'Say what needs doing again');
      const now = new Date(this.clock.now());
      if (i.pass) {
        await trx.updateTable('housekeeping_task').set({ inspection: 'PASSED', inspected_by: userId, inspected_at: now, inspection_note: i.note ?? null, version: sql`version + 1` as never }).where('id', '=', id).execute();
        await this.setRoomHk(trx, propertyId, t.room_id, 'INSPECTED', 'INSPECTION_PASSED');
      } else {
        // back to the attendant with the supervisor's note; the room is not ready
        await trx.updateTable('housekeeping_task').set({ status: 'PENDING', inspection: 'FAILED', inspected_by: userId, inspected_at: now, inspection_note: i.note, rework_count: t.rework_count + 1, finished_at: null, started_at: null, priority: Math.min(t.priority, 2), version: sql`version + 1` as never }).where('id', '=', id).execute();
        await this.setRoomHk(trx, propertyId, t.room_id, 'DIRTY', 'INSPECTION_FAILED');
      }
      await this.audit.record(trx, { action: i.pass ? 'housekeeping.inspect_pass' : 'housekeeping.inspect_fail', resourceType: 'housekeeping_task', resourceId: id, propertyId, note: i.note ?? undefined });
      await this.outbox.publish(trx, { aggregateType: 'housekeeping_task', aggregateId: id, eventType: 'RoomInspected', propertyId, payload: { taskId: id, roomId: t.room_id, passed: i.pass } });
      return this.taskView(trx, id);
    });
  }

  async setDnd(propertyId: string, roomId: string, userId: string, dnd: boolean) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const room = await trx.selectFrom('room').select(['id', 'number', 'dnd']).where('id', '=', roomId).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
      if (!room) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room not found' });
      if (room.dnd !== dnd) {
        await trx.updateTable('room').set({ dnd, version: sql`version + 1` as never }).where('id', '=', roomId).execute();
        if (dnd) await trx.updateTable('housekeeping_task').set({ status: 'SKIPPED', skip_reason: 'Do not disturb' }).where('room_id', '=', roomId).where('task_type', '=', 'STAYOVER').where('status', '=', 'PENDING').where('business_date', '=', p.business_date).execute();
        await this.audit.record(trx, { action: dnd ? 'housekeeping.dnd_on' : 'housekeeping.dnd_off', resourceType: 'room', resourceId: roomId, propertyId });
      }
      return { id: roomId, number: room.number, dnd };
    });
  }

  /** Supervisor override of a room's state (audited). The attendant flow is the normal way. */
  async overrideStatus(propertyId: string, roomId: string, userId: string, status: 'CLEAN' | 'DIRTY' | 'INSPECTED') {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const before = await this.setRoomHk(trx, propertyId, roomId, status, 'MANUAL');
      if (before.hk_status !== status) await this.audit.record(trx, { action: 'housekeeping.status', resourceType: 'room', resourceId: roomId, propertyId, before: { status: before.hk_status }, after: { status } });
      return { id: roomId, number: before.number, hkStatus: status };
    });
  }

  // ───────────── reading ─────────────
  private async taskView(trx: Trx, id: string) {
    const t = await trx.selectFrom('housekeeping_task as t').innerJoin('room as r', 'r.id', 't.room_id').leftJoin('staff_user as u', 'u.id', 't.assigned_to')
      .select(['t.id', 't.room_id', 'r.number', 'r.hk_status', 'r.dnd', 't.task_type', 't.business_date', 't.priority', 't.status', 't.assigned_to', 'u.full_name as assignee', 't.credit', 't.notes', 't.started_at', 't.finished_at',
        't.inspection', 't.inspection_note', 't.rework_count', 't.skip_reason', 't.version']).where('t.id', '=', id).executeTakeFirstOrThrow();
    return { id: t.id, roomId: t.room_id, roomNumber: t.number, roomStatus: t.hk_status, dnd: t.dnd, type: t.task_type, businessDate: t.business_date, priority: t.priority, status: t.status,
      assignee: t.assigned_to ? { id: t.assigned_to, name: t.assignee } : null, credit: Number(t.credit), notes: t.notes, startedAt: t.started_at, finishedAt: t.finished_at,
      inspection: t.inspection, inspectionNote: t.inspection_note, reworkCount: t.rework_count, skipReason: t.skip_reason, version: t.version };
  }

  async myTasks(propertyId: string, userId: string, includeDone: boolean) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const statuses = includeDone ? ['PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED'] as const : ['PENDING', 'IN_PROGRESS'] as const;
      const rows = await trx.selectFrom('housekeeping_task as t').innerJoin('room as r', 'r.id', 't.room_id').leftJoin('floor as f', 'f.id', 'r.floor_id')
        .select(['t.id', 'r.id as room_id', 'r.number', 'f.name as floor', 'r.dnd', 't.task_type', 't.priority', 't.status', 't.notes', 't.inspection', 't.inspection_note', 't.rework_count', 't.credit', 't.started_at', 't.finished_at'])
        .where('t.property_id', '=', propertyId).where('t.assigned_to', '=', userId).where('t.status', 'in', [...statuses])
        .$call((q) => (includeDone ? q.where('t.business_date', '=', p.business_date) : q)).orderBy('t.priority').orderBy('r.number').execute();
      return { businessDate: p.business_date, items: rows.map((t) => ({ id: t.id, roomId: t.room_id, roomNumber: t.number, floor: t.floor, dnd: t.dnd, type: t.task_type, priority: t.priority, status: t.status, notes: t.notes, inspection: t.inspection,
        inspectionNote: t.inspection_note, reworkCount: t.rework_count, credit: Number(t.credit), startedAt: t.started_at, finishedAt: t.finished_at })) };
    });
  }

  async board(propertyId: string, q: z.infer<typeof S.BoardQuery>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const bd = q.date ?? p.business_date;
      const tenant = currentTenant().tenantId;
      const [rooms, tasks, occ, blocks] = await Promise.all([
        sql<{ id: string; number: string; hk_status: Hk; dnd: boolean; type_code: string; floor: string | null }>`SELECT r.id, r.number, r.hk_status, r.dnd, t.code AS type_code, f.name AS floor FROM room r JOIN room_type t ON t.id = r.room_type_id
          LEFT JOIN floor f ON f.id = r.floor_id WHERE r.tenant_id = ${tenant} AND r.property_id = ${propertyId} AND r.status = 'ACTIVE' ORDER BY t.sort_order, t.code, lpad(regexp_replace(r.number, '\\D', '', 'g'), 8, '0'), r.number`.execute(trx),
        trx.selectFrom('housekeeping_task as t').leftJoin('staff_user as u', 'u.id', 't.assigned_to').select(['t.id', 't.room_id', 't.task_type', 't.priority', 't.status', 't.assigned_to', 'u.full_name as assignee', 't.credit', 't.inspection', 't.rework_count', 't.notes', 't.started_at', 't.finished_at', 't.business_date'])
          .where('t.property_id', '=', propertyId).where((eb) => eb.or([eb('t.status', 'in', ['PENDING', 'IN_PROGRESS']), eb.and([eb('t.business_date', '=', bd), eb('t.status', 'in', ['DONE', 'SKIPPED'])])])).execute(),
        sql<{ room_id: string; kind: string; vip: boolean }>`SELECT a.room_id, CASE WHEN a.status = 'IN_HOUSE' AND l.departure <= ${bd}::date THEN 'DEPARTING' WHEN a.status = 'IN_HOUSE' THEN 'OCCUPIED' ELSE 'ARRIVING' END AS kind, g.vip
          FROM room_assignment a JOIN reservation_room l ON l.id = a.assignment_ref JOIN reservation res ON res.id = l.reservation_id JOIN guest g ON g.id = res.guest_id
          WHERE a.tenant_id = ${tenant} AND a.property_id = ${propertyId} AND ((a.status = 'IN_HOUSE') OR (a.status = 'ASSIGNED' AND l.arrival = ${bd}::date))`.execute(trx),
        trx.selectFrom('room_block').select(['room_id', 'block_type']).where('property_id', '=', propertyId).where('cancelled_at', 'is', null).where('start_date', '<=', bd).where('end_date', '>', bd).execute(),
      ]);
      const open = tasks.filter((t) => t.status === 'PENDING' || t.status === 'IN_PROGRESS' || (t.status === 'DONE' && t.inspection === 'PENDING'));
      const roomRows = rooms.rows.map((r) => {
        const o = occ.rows.filter((x) => x.room_id === r.id);
        const block = blocks.find((b) => b.room_id === r.id);
        const t = tasks.filter((x) => x.room_id === r.id && (x.status !== 'DONE' || x.inspection === 'PENDING' || x.business_date === bd)).sort((a, b) => a.priority - b.priority);
        return { id: r.id, number: r.number, type: r.type_code, floor: r.floor, hkStatus: r.hk_status, dnd: r.dnd, occupancy: block ? block.block_type : o.some((x) => x.kind === 'OCCUPIED' || x.kind === 'DEPARTING') ? 'OCCUPIED' : 'VACANT',
          departingToday: o.some((x) => x.kind === 'DEPARTING'), arrivingToday: o.some((x) => x.kind === 'ARRIVING'), vipArrival: o.some((x) => x.kind === 'ARRIVING' && x.vip),
          tasks: t.map((x) => ({ id: x.id, type: x.task_type, priority: x.priority, status: x.status, assignee: x.assigned_to ? { id: x.assigned_to, name: x.assignee } : null, inspection: x.inspection, reworkCount: x.rework_count, notes: x.notes })) };
      });
      const byStatus = { CLEAN: 0, DIRTY: 0, CLEANING: 0, INSPECTED: 0 } as Record<Hk, number>;
      for (const r of roomRows) byStatus[r.hkStatus]++;
      const work = new Map<string, { userId: string; name: string | null; tasks: number; credits: number; done: number }>();
      for (const t of tasks) {
        if (!t.assigned_to || t.status === 'CANCELLED' || t.status === 'SKIPPED') continue;
        const w = work.get(t.assigned_to) ?? { userId: t.assigned_to, name: t.assignee, tasks: 0, credits: 0, done: 0 };
        w.tasks++; w.credits += Number(t.credit); if (t.status === 'DONE') w.done++;
        work.set(t.assigned_to, w);
      }
      const doneToday = tasks.filter((t) => t.status === 'DONE' && t.business_date === bd && t.started_at && t.finished_at);
      const minutes = doneToday.map((t) => (new Date(t.finished_at!).getTime() - new Date(t.started_at!).getTime()) / 60_000);
      return {
        propertyId, businessDate: bd, requireInspection: p.hk_require_inspection, rooms: roomRows,
        summary: { byStatus, openTasks: open.length, unassigned: open.filter((t) => !t.assigned_to && t.status === 'PENDING').length, awaitingInspection: tasks.filter((t) => t.status === 'DONE' && t.inspection === 'PENDING').length,
          doneToday: doneToday.length, avgMinutesPerRoom: minutes.length ? Math.round((minutes.reduce((a, b) => a + b, 0) / minutes.length) * 10) / 10 : null },
        workload: [...work.values()].map((w) => ({ ...w, credits: Math.round(w.credits * 100) / 100 })).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
      };
    });
  }

  async attendants(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const rows = await sql<{ id: string; full_name: string; email: string; locale: string }>`SELECT DISTINCT u.id, u.full_name, u.email, u.preferred_locale AS locale FROM staff_user u
        JOIN role_assignment ra ON ra.tenant_id = u.tenant_id AND ra.user_id = u.id JOIN role_permission rp ON rp.tenant_id = ra.tenant_id AND rp.role_id = ra.role_id AND rp.permission_key = 'housekeeping.update'
        WHERE u.tenant_id = ${currentTenant().tenantId} AND u.status <> 'DISABLED' AND (ra.valid_to IS NULL OR ra.valid_to > now()) AND ra.valid_from <= now()
          AND (ra.scope_type = 'TENANT' OR (ra.scope_type = 'PROPERTY' AND ra.scope_id = ${propertyId}))
          AND NOT EXISTS (SELECT 1 FROM role_permission x WHERE x.tenant_id = ra.tenant_id AND x.role_id = ra.role_id AND x.permission_key = 'tenant.manage')
        ORDER BY u.full_name`.execute(trx);
      return { items: rows.rows.map((r) => ({ id: r.id, name: r.full_name, email: r.email, locale: r.locale })) };
    });
  }

  async setSettings(propertyId: string, i: z.infer<typeof S.Settings>) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      await trx.updateTable('property').set({ hk_require_inspection: i.requireInspection }).where('id', '=', propertyId).execute();
      await this.audit.record(trx, { action: 'housekeeping.settings', resourceType: 'property', resourceId: propertyId, propertyId, after: i });
      return { requireInspection: i.requireInspection };
    });
  }

  // ───────────── issues and lost & found ─────────────
  async reportIssue(propertyId: string, userId: string, i: z.infer<typeof S.ReportIssue>) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      if (i.roomId && !(await trx.selectFrom('room').select('id').where('id', '=', i.roomId).where('property_id', '=', propertyId).executeTakeFirst())) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room not found' });
      const row = await trx.insertInto('room_issue').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, room_id: i.roomId ?? null, area: i.area ?? null, category: i.category, description: i.description, priority: i.priority, reported_by: userId } as never)
        .returning(['id', 'status', 'created_at']).executeTakeFirstOrThrow();
      await this.outbox.publish(trx, { aggregateType: 'room_issue', aggregateId: row.id, eventType: 'RoomIssueReported', propertyId, payload: { issueId: row.id, roomId: i.roomId ?? null, category: i.category, priority: i.priority } });
      await this.audit.record(trx, { action: 'housekeeping.issue_report', resourceType: 'room_issue', resourceId: row.id, propertyId, after: { category: i.category, priority: i.priority } });
      return { id: row.id, status: row.status, createdAt: row.created_at };
    });
  }
  async issues(propertyId: string, status: 'OPEN' | 'RESOLVED') {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const rows = await trx.selectFrom('room_issue as i').leftJoin('room as r', 'r.id', 'i.room_id').leftJoin('staff_user as u', 'u.id', 'i.reported_by')
        .select(['i.id', 'r.number', 'i.area', 'i.category', 'i.description', 'i.priority', 'i.status', 'u.full_name as reporter', 'i.created_at', 'i.resolved_at', 'i.resolution_note'])
        .where('i.property_id', '=', propertyId).where('i.status', '=', status).orderBy('i.priority').orderBy('i.created_at', 'desc').limit(200).execute();
      return { items: rows.map((r) => ({ id: r.id, roomNumber: r.number, area: r.area, category: r.category, description: r.description, priority: r.priority, status: r.status, reportedBy: r.reporter, createdAt: r.created_at, resolvedAt: r.resolved_at, resolutionNote: r.resolution_note })) };
    });
  }
  async resolveIssue(propertyId: string, id: string, userId: string, note?: string | null) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.updateTable('room_issue').set({ status: 'RESOLVED', resolved_by: userId, resolved_at: new Date(this.clock.now()), resolution_note: note ?? null }).where('id', '=', id).where('property_id', '=', propertyId).where('status', '=', 'OPEN').returning('id').executeTakeFirst();
      if (!r) throw new ConflictException({ code: 'NOT_OPEN', message: 'Issue not found or already resolved' });
      await this.audit.record(trx, { action: 'housekeeping.issue_resolve', resourceType: 'room_issue', resourceId: id, propertyId, note: note ?? undefined });
      return { id, status: 'RESOLVED' };
    });
  }
  async addLostFound(propertyId: string, userId: string, i: z.infer<typeof S.LostFoundCreate>) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      if (i.roomId && !(await trx.selectFrom('room').select('id').where('id', '=', i.roomId).where('property_id', '=', propertyId).executeTakeFirst())) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room not found' });
      const row = await trx.insertInto('lost_found').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, room_id: i.roomId ?? null, location: i.location ?? null, item: i.item, description: i.description ?? null, found_by: userId } as never).returning(['id', 'found_at']).executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'housekeeping.lost_found_add', resourceType: 'lost_found', resourceId: row.id, propertyId, after: { item: i.item } });
      return { id: row.id, foundAt: row.found_at };
    });
  }
  async lostFound(propertyId: string, status: 'FOUND' | 'RETURNED' | 'DISPOSED') {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const rows = await trx.selectFrom('lost_found as l').leftJoin('room as r', 'r.id', 'l.room_id').leftJoin('staff_user as u', 'u.id', 'l.found_by')
        .select(['l.id', 'r.number', 'l.location', 'l.item', 'l.description', 'l.status', 'u.full_name as finder', 'l.found_at', 'l.closed_at', 'l.closed_note']).where('l.property_id', '=', propertyId).where('l.status', '=', status).orderBy('l.found_at', 'desc').limit(200).execute();
      return { items: rows.map((r) => ({ id: r.id, roomNumber: r.number, location: r.location, item: r.item, description: r.description, status: r.status, foundBy: r.finder, foundAt: r.found_at, closedAt: r.closed_at, closedNote: r.closed_note })) };
    });
  }
  async closeLostFound(propertyId: string, id: string, userId: string, i: z.infer<typeof S.LostFoundClose>) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.updateTable('lost_found').set({ status: i.status, closed_by: userId, closed_at: new Date(this.clock.now()), closed_note: i.note ?? null }).where('id', '=', id).where('property_id', '=', propertyId).where('status', '=', 'FOUND').returning('id').executeTakeFirst();
      if (!r) throw new ConflictException({ code: 'NOT_OPEN', message: 'Item not found or already closed' });
      await this.audit.record(trx, { action: 'housekeeping.lost_found_close', resourceType: 'lost_found', resourceId: id, propertyId, after: { status: i.status }, note: i.note ?? undefined });
      return { id, status: i.status };
    });
  }
}
void ForbiddenException;
