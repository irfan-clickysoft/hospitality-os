import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { fmt } from '../folio/folio.service.js';
import { MediaService } from '../media/media.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
type Trx = Parameters<Parameters<TenantDb['tx']>[0]>[0];
/** Hours the property has to resolve a case, by severity. */
export const SLA_HOURS = { CRITICAL: 4, HIGH: 24, MEDIUM: 72, LOW: 168 } as const;
const RESTRICTED_TYPES = ['SAFETY', 'SECURITY', 'MEDICAL'];

@Injectable()
export class CaseService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuthorizationService) private readonly authz: AuthorizationService, @Inject(AuditService) private readonly audit: AuditService, @Inject(MediaService) private readonly media: MediaService) {}

  private async can(userId: string, permission: string, propertyId: string) { return (await this.authz.check(userId, { permission, scope: { propertyId } })).effect === 'ALLOW'; }
  private async prop(trx: Trx, id: string) {
    const p = await trx.selectFrom('property').select(['id', 'code', 'currency', 'business_date', 'timezone']).where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return p;
  }
  /** The case, or "not found" when it is restricted and the person may not see restricted cases (so its existence is not revealed). */
  private async row(trx: Trx, propertyId: string, id: string, userId: string) {
    const r = await trx.selectFrom('case_record').selectAll().where('property_id', '=', propertyId).where('id', '=', id).executeTakeFirst();
    if (!r || (r.confidentiality === 'RESTRICTED' && !(await this.can(userId, 'case.restricted', propertyId)))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Case not found' });
    return r;
  }
  private async event(trx: Trx, id: string, action: string, userId: string, note?: string | null, details?: object) {
    await trx.insertInto('case_event').values({ tenant_id: currentTenant().tenantId, case_id: id, action, note: note ?? null, details: details ? JSON.stringify(details) : null, actor_id: userId } as never).execute();
  }

  async list(propertyId: string, userId: string, q: z.infer<typeof S.CaseList>) {
    const restricted = await this.can(userId, 'case.restricted', propertyId);
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const t = currentTenant().tenantId; const st = q.status ? q.status.split(',') : null; const ty = q.type ? q.type.split(',') : null; const needle = q.q ? `%${q.q.toLowerCase()}%` : null;
      const r = await sql<Record<string, any>>`SELECT c.id, c.ref, c.type, c.category, c.severity, c.confidentiality, c.status, c.occurred_at, c.reported_at, c.sla_due_at, c.description, c.resolved_at, c.reservation_id, rm.number AS room, g.full_name AS guest, o.full_name AS owner, c.owner_id, c.compensation_minor::text AS comp,
          (c.status IN ('OPEN','IN_PROGRESS') AND c.sla_due_at < now()) AS overdue
        FROM case_record c LEFT JOIN room rm ON rm.id = c.room_id LEFT JOIN guest g ON g.id = c.guest_id LEFT JOIN staff_user o ON o.id = c.owner_id
        WHERE c.tenant_id = ${t} AND c.property_id = ${propertyId} ${restricted ? sql`` : sql`AND c.confidentiality = 'NORMAL'`} ${st ? sql`AND c.status IN (${sql.join(st)})` : sql``} ${ty ? sql`AND c.type IN (${sql.join(ty)})` : sql``}
          ${needle ? sql`AND (lower(c.ref) LIKE ${needle} OR lower(c.description) LIKE ${needle} OR lower(coalesce(g.full_name, '')) LIKE ${needle} OR coalesce(rm.number, '') LIKE ${needle})` : sql``} ORDER BY (c.status IN ('OPEN','IN_PROGRESS')) DESC, c.sla_due_at LIMIT ${q.limit}`.execute(trx);
      return { restrictedAccess: restricted, items: r.rows.map((x) => ({ id: x.id, ref: x.ref, type: x.type, category: x.category, severity: x.severity, restricted: x.confidentiality === 'RESTRICTED', status: x.status, occurredAt: x.occurred_at, reportedAt: x.reported_at, slaDueAt: x.sla_due_at, overdue: !!x.overdue,
        description: x.description, room: x.room, guest: x.guest, owner: x.owner, ownerId: x.owner_id, reservationId: x.reservation_id, resolvedAt: x.resolved_at, compensation: x.comp === null ? null : fmt(x.comp, p.currency) })) };
    });
  }

  async create(propertyId: string, userId: string, i: z.infer<typeof S.CaseCreate>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const t = currentTenant().tenantId;
      let guestId: string | null = null, roomId: string | null = i.roomId ?? null;
      if (i.reservationId) {
        const r = await trx.selectFrom('reservation').select(['id', 'guest_id']).where('id', '=', i.reservationId).where('property_id', '=', propertyId).executeTakeFirst();
        if (!r) throw fail(404, 'NOT_FOUND', 'That booking was not found at this property'); guestId = r.guest_id;
        if (!roomId) roomId = (await sql<{ room_id: string }>`SELECT a.room_id FROM room_assignment a JOIN reservation_room l ON l.id = a.assignment_ref WHERE l.reservation_id = ${i.reservationId} ORDER BY a.created_at DESC LIMIT 1`.execute(trx)).rows[0]?.room_id ?? null;
      }
      if (roomId && !(await trx.selectFrom('room').select('id').where('id', '=', roomId).where('property_id', '=', propertyId).executeTakeFirst())) throw fail(404, 'NOT_FOUND', 'That room was not found at this property');
      if (i.ownerId && !(await trx.selectFrom('staff_user').select('id').where('id', '=', i.ownerId).executeTakeFirst())) throw fail(404, 'NOT_FOUND', 'That staff member was not found');
      const restricted = RESTRICTED_TYPES.includes(i.type) || i.confidential;
      const seq = (await sql<{ v: string }>`INSERT INTO property_counter (tenant_id, property_id, name, value) VALUES (${t}, ${propertyId}, 'case', 1) ON CONFLICT (tenant_id, property_id, name) DO UPDATE SET value = property_counter.value + 1 RETURNING value::text AS v`.execute(trx)).rows[0]!.v;
      const ref = `CASE-${p.code}-${seq.padStart(4, '0')}`;
      const hours = SLA_HOURS[i.severity];
      const row = await trx.insertInto('case_record').values({ tenant_id: t, property_id: propertyId, ref, type: i.type, category: i.category ?? null, severity: i.severity, confidentiality: restricted ? 'RESTRICTED' : 'NORMAL', reservation_id: i.reservationId ?? null, room_id: roomId, guest_id: guestId,
        occurred_at: i.occurredAt ?? new Date(), channel: i.channel, reporter_name: i.reporterName ?? null, reported_by: userId, owner_id: i.ownerId ?? null, sla_due_at: sql`now() + make_interval(hours => ${hours})`, description: i.description, immediate_action: i.immediateAction ?? null } as never).returning('id').executeTakeFirstOrThrow();
      await this.event(trx, row.id, 'REPORTED', userId, restricted ? null : i.description, { type: i.type, severity: i.severity, slaHours: hours });
      await this.audit.record(trx, { action: 'case.report', resourceType: 'case_record', resourceId: row.id, propertyId, after: { ref, type: i.type, severity: i.severity, restricted } });
      return { id: row.id, ref, restricted, slaHours: hours };
    });
  }

  async get(propertyId: string, id: string, userId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const r = await this.row(trx, propertyId, id, userId);
      const n = (await sql<Record<string, any>>`SELECT (SELECT number FROM room WHERE id = ${r.room_id}) AS room, (SELECT full_name FROM guest WHERE id = ${r.guest_id}) AS guest, (SELECT confirmation_no FROM reservation WHERE id = ${r.reservation_id}) AS conf, (SELECT full_name FROM staff_user WHERE id = ${r.reported_by}) AS reporter,
          (SELECT full_name FROM staff_user WHERE id = ${r.owner_id}) AS owner, (SELECT full_name FROM staff_user WHERE id = ${r.resolved_by}) AS resolver`.execute(trx)).rows[0]!;
      const events = await sql<Record<string, any>>`SELECT e.id, e.action, e.note, e.details, e.at, u.full_name AS who FROM case_event e LEFT JOIN staff_user u ON u.id = e.actor_id WHERE e.case_id = ${id} ORDER BY e.at, e.id`.execute(trx);
      const photos = await trx.selectFrom('case_media').select('id').where('case_id', '=', id).orderBy('created_at').execute();
      return { id: r.id, ref: r.ref, type: r.type, category: r.category, severity: r.severity, restricted: r.confidentiality === 'RESTRICTED', status: r.status, occurredAt: r.occurred_at, reportedAt: r.reported_at, channel: r.channel, reporterName: r.reporter_name, reportedBy: n.reporter, owner: n.owner, ownerId: r.owner_id, slaDueAt: r.sla_due_at,
        overdue: ['OPEN', 'IN_PROGRESS'].includes(r.status) && r.sla_due_at.getTime() < Date.now(), description: r.description, immediateAction: r.immediate_action, rootCause: r.root_cause, correctiveAction: r.corrective_action, preventiveAction: r.preventive_action, compensationNote: r.compensation_note,
        compensation: r.compensation_minor === null ? null : fmt(r.compensation_minor, p.currency), resolvedAt: r.resolved_at, resolvedBy: n.resolver, resolutionNote: r.resolution_note, followupAt: r.followup_at, followupNote: r.followup_note, room: n.room, guest: n.guest, confirmationNo: n.conf, reservationId: r.reservation_id, version: r.version,
        events: events.rows.map((e) => ({ id: e.id, action: e.action, note: e.note, details: e.details, at: e.at, by: e.who })), photos: photos.map((x) => ({ id: x.id })) };
    });
  }

  async update(propertyId: string, id: string, userId: string, i: z.infer<typeof S.CaseUpdate>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const r = await this.row(trx, propertyId, id, userId);
      if (r.status === 'CLOSED') throw fail(409, 'CASE_CLOSED', 'A closed case cannot be changed. Reopen it first.');
      const set: Record<string, unknown> = {}; const changed: string[] = []; const before: Record<string, unknown> = {};
      const put = (field: string, col: string, v: unknown) => { if (v === undefined) return; const old = (r as Record<string, unknown>)[col] ?? null; if (JSON.stringify(old) === JSON.stringify(v)) return; set[col] = v; before[field] = old; changed.push(field); };
      put('category', 'category', i.category); put('severity', 'severity', i.severity); put('ownerId', 'owner_id', i.ownerId); put('description', 'description', i.description); put('immediateAction', 'immediate_action', i.immediateAction);
      put('rootCause', 'root_cause', i.rootCause); put('correctiveAction', 'corrective_action', i.correctiveAction); put('preventiveAction', 'preventive_action', i.preventiveAction); put('compensationNote', 'compensation_note', i.compensationNote);
      if (i.compensation !== undefined) put('compensation', 'compensation_minor', i.compensation === null ? null : Money.parse(i.compensation, p.currency).minor.toString());
      put('followupNote', 'followup_note', i.followupNote); if (i.followupAt !== undefined) put('followupAt', 'followup_at', i.followupAt);
      if (i.status && i.status !== r.status && r.status !== 'RESOLVED') { set.status = i.status; changed.push('status'); }
      if (i.ownerId && !(await trx.selectFrom('staff_user').select('id').where('id', '=', i.ownerId).executeTakeFirst())) throw fail(404, 'NOT_FOUND', 'That staff member was not found');
      if (set.severity && ['OPEN', 'IN_PROGRESS'].includes(r.status)) set.sla_due_at = sql`${r.reported_at} + make_interval(hours => ${SLA_HOURS[set.severity as keyof typeof SLA_HOURS]})`;
      if (!changed.length) return { id };
      if (!set.status && r.status === 'OPEN' && (changed.includes('ownerId') || changed.includes('rootCause') || changed.includes('correctiveAction'))) { set.status = 'IN_PROGRESS'; }
      await trx.updateTable('case_record').set({ ...set, version: sql`version + 1` } as never).where('id', '=', id).execute();
      await this.event(trx, id, changed.includes('ownerId') ? 'ASSIGNED' : 'UPDATED', userId, null, { fields: changed, before: r.confidentiality === 'RESTRICTED' ? undefined : before });
      await this.audit.record(trx, { action: 'case.update', resourceType: 'case_record', resourceId: id, propertyId, after: { fields: changed } });
      return { id };
    });
  }

  private async move(propertyId: string, id: string, userId: string, from: string[], to: string, action: string, note: string | null, set: Record<string, unknown> = {}) {
    return this.tdb.tx(async (trx) => {
      const r = await this.row(trx, propertyId, id, userId);
      if (!from.includes(r.status)) throw fail(409, 'INVALID_STATE', `This cannot be done while the case is “${r.status.toLowerCase().replace('_', ' ')}”`);
      await trx.updateTable('case_record').set({ ...set, status: to, version: sql`version + 1` } as never).where('id', '=', id).execute();
      await this.event(trx, id, action, userId, r.confidentiality === 'RESTRICTED' ? null : note);
      await this.audit.record(trx, { action: `case.${action.toLowerCase()}`, resourceType: 'case_record', resourceId: id, propertyId, before: { status: r.status }, after: { status: to } });
      return { id, status: to };
    });
  }
  resolve(pid: string, id: string, userId: string, note: string) { return this.move(pid, id, userId, ['OPEN', 'IN_PROGRESS'], 'RESOLVED', 'RESOLVED', note, { resolved_at: sql`now()`, resolved_by: userId, resolution_note: note }); }
  close(pid: string, id: string, userId: string) { return this.move(pid, id, userId, ['RESOLVED'], 'CLOSED', 'CLOSED', null); }
  reopen(pid: string, id: string, userId: string, reason: string) { return this.move(pid, id, userId, ['RESOLVED', 'CLOSED'], 'IN_PROGRESS', 'REOPENED', reason, { resolved_at: null, resolved_by: null }); }
  async addNote(pid: string, id: string, userId: string, note: string) {
    return this.tdb.tx(async (trx) => { const r = await this.row(trx, pid, id, userId); await this.event(trx, id, 'NOTE', userId, r.confidentiality === 'RESTRICTED' ? null : note, r.confidentiality === 'RESTRICTED' ? { restrictedNote: note } : undefined); return { id }; });
  }

  async addPhoto(pid: string, id: string, userId: string, data: Buffer) {
    const file = await this.media.savePrivateImage(data, 8 * 1024 * 1024);
    try {
      return await this.tdb.tx(async (trx) => {
        await this.row(trx, pid, id, userId);
        const n = await trx.selectFrom('case_media').select(({ fn }) => fn.countAll<string>().as('n')).where('case_id', '=', id).executeTakeFirstOrThrow();
        if (Number(n.n) >= 10) throw fail(409, 'PHOTO_LIMIT', 'A case can have up to 10 pictures');
        const m = await trx.insertInto('case_media').values({ tenant_id: currentTenant().tenantId, case_id: id, file_name: file, uploaded_by: userId }).returning('id').executeTakeFirstOrThrow();
        await this.event(trx, id, 'PHOTO_ADDED', userId); return { id: m.id };
      });
    } catch (e) { await this.media.removePrivate(file); throw e; }
  }
  async photoFile(pid: string, id: string, photoId: string, userId: string) {
    const f = await this.tdb.tx(async (trx) => { await this.row(trx, pid, id, userId); return trx.selectFrom('case_media').select('file_name').where('id', '=', photoId).where('case_id', '=', id).executeTakeFirst(); });
    if (!f) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Picture not found' });
    return this.media.readPrivate(f.file_name);
  }
}
