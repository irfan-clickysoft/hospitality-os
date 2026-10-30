import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { FolioService, fmt } from '../folio/folio.service.js';
import { MediaService } from '../media/media.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const OPEN_STATES = ['SUSPECTED', 'VERIFIED', 'CHARGE_APPROVED', 'DISPUTED'];
type Trx = Parameters<Parameters<TenantDb['tx']>[0]>[0];

@Injectable()
export class DamageService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuthorizationService) private readonly authz: AuthorizationService, @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FolioService) private readonly folio: FolioService, @Inject(MediaService) private readonly media: MediaService) {}

  private async prop(trx: Trx, id: string) {
    const p = await trx.selectFrom('property').select(['id', 'code', 'currency', 'business_date', 'timezone']).where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return p;
  }
  private async row(trx: Trx, propertyId: string, id: string) {
    const r = await trx.selectFrom('damage_case').selectAll().where('property_id', '=', propertyId).where('id', '=', id).executeTakeFirst();
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Damage case not found' });
    return r;
  }
  private async event(trx: Trx, id: string, action: string, userId: string, note?: string | null, details?: object) {
    await trx.insertInto('damage_event').values({ tenant_id: currentTenant().tenantId, damage_id: id, action, note: note ?? null, details: details ? JSON.stringify(details) : null, actor_id: userId } as never).execute();
  }
  private m(v: string | null | undefined, cur: string) { return v === null || v === undefined ? null : fmt(v, cur); }
  private parse(v: string, cur: string) { return Money.parse(v, cur).minor; }
  private brief(r: Awaited<ReturnType<DamageService['row']>>, cur: string, extra: { room?: string | null; guest?: string | null; conf?: string | null; reporter?: string | null } = {}) {
    return { id: r.id, ref: r.ref, status: r.status, area: r.area, category: r.category, severity: r.severity, description: r.description, discoveredAt: r.discovered_at, room: extra.room ?? null, guest: extra.guest ?? null, confirmationNo: extra.conf ?? null, reservationId: r.reservation_id,
      estimated: this.m(r.estimated_minor, cur), actual: this.m(r.actual_minor, cur), charge: this.m(r.charge_minor, cur), waived: fmt(r.waived_minor, cur), reportedBy: extra.reporter ?? null, version: r.version };
  }

  async list(propertyId: string, q: z.infer<typeof S.DamageList>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const t = currentTenant().tenantId; const st = q.status ? q.status.split(',') : null; const needle = q.q ? `%${q.q.toLowerCase()}%` : null;
      const r = await sql<Record<string, any>>`SELECT d.id, d.ref, d.status, d.area, d.category, d.severity, d.discovered_at, d.estimated_minor::text AS est, d.actual_minor::text AS act, d.charge_minor::text AS chg, d.waived_minor::text AS wv, d.reservation_id, rm.number AS room, g.full_name AS guest, r.confirmation_no AS conf, u.full_name AS reporter,
          (SELECT count(*) FROM damage_media m WHERE m.damage_id = d.id)::int AS photos
        FROM damage_case d LEFT JOIN room rm ON rm.id = d.room_id LEFT JOIN guest g ON g.id = d.guest_id LEFT JOIN reservation r ON r.id = d.reservation_id LEFT JOIN staff_user u ON u.id = d.reported_by
        WHERE d.tenant_id = ${t} AND d.property_id = ${propertyId} ${st ? sql`AND d.status IN (${sql.join(st)})` : sql``} ${needle ? sql`AND (lower(d.ref) LIKE ${needle} OR lower(d.area) LIKE ${needle} OR lower(coalesce(g.full_name, '')) LIKE ${needle} OR lower(coalesce(r.confirmation_no, '')) LIKE ${needle} OR coalesce(rm.number, '') LIKE ${needle})` : sql``}
          ${q.from ? sql`AND d.discovered_at >= ${q.from}::date` : sql``} ${q.to ? sql`AND d.discovered_at < (${q.to}::date + 1)` : sql``} ORDER BY d.discovered_at DESC LIMIT ${q.limit}`.execute(trx);
      return { items: r.rows.map((x) => ({ id: x.id, ref: x.ref, status: x.status, area: x.area, category: x.category, severity: x.severity, discoveredAt: x.discovered_at, room: x.room, guest: x.guest, confirmationNo: x.conf, reservationId: x.reservation_id, reporter: x.reporter, photos: x.photos,
        estimated: this.m(x.est, p.currency), actual: this.m(x.act, p.currency), charge: this.m(x.chg, p.currency), waived: fmt(x.wv, p.currency) })) };
    });
  }

  async create(propertyId: string, userId: string, i: z.infer<typeof S.DamageCreate>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const t = currentTenant().tenantId;
      let reservationId: string | null = null, lineId: string | null = null, guestId: string | null = null, roomId: string | null = i.roomId ?? null;
      if (i.reservationId) {
        const l = await sql<{ id: string; guest_id: string }>`SELECT l.id, r.guest_id FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id WHERE l.tenant_id = ${t} AND l.property_id = ${propertyId} AND r.id = ${i.reservationId} ${i.lineId ? sql`AND l.id = ${i.lineId}` : sql``} ORDER BY l.line_no LIMIT 1`.execute(trx);
        const x = l.rows[0]; if (!x) throw fail(404, 'NOT_FOUND', 'That booking was not found at this property');
        reservationId = i.reservationId; lineId = x.id; guestId = x.guest_id;
        if (!roomId) roomId = (await sql<{ room_id: string }>`SELECT room_id FROM room_assignment WHERE assignment_ref = ${x.id} ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0]?.room_id ?? null;
      }
      if (roomId) { const ok = await trx.selectFrom('room').select('id').where('id', '=', roomId).where('property_id', '=', propertyId).executeTakeFirst(); if (!ok) throw fail(404, 'NOT_FOUND', 'That room was not found at this property'); }
      const seq = (await sql<{ v: string }>`INSERT INTO property_counter (tenant_id, property_id, name, value) VALUES (${t}, ${propertyId}, 'damage', 1) ON CONFLICT (tenant_id, property_id, name) DO UPDATE SET value = property_counter.value + 1 RETURNING value::text AS v`.execute(trx)).rows[0]!.v;
      const ref = `DMG-${p.code}-${seq.padStart(4, '0')}`;
      const row = await trx.insertInto('damage_case').values({ tenant_id: t, property_id: propertyId, ref, reservation_id: reservationId, reservation_room_id: lineId, room_id: roomId, guest_id: guestId, discovered_at: i.discoveredAt ?? new Date(), area: i.area, category: i.category, severity: i.severity,
        description: i.description, estimated_minor: i.estimatedCost ? this.parse(i.estimatedCost, p.currency).toString() : null, reported_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await this.event(trx, row.id, 'REPORTED', userId, i.description);
      await this.audit.record(trx, { action: 'damage.report', resourceType: 'damage_case', resourceId: row.id, propertyId, after: { ref, severity: i.severity, reservationId } });
      return { id: row.id, ref };
    });
  }

  async get(propertyId: string, id: string, userId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const r = await this.row(trx, propertyId, id);
      const names = await sql<Record<string, any>>`SELECT (SELECT number FROM room WHERE id = ${r.room_id}) AS room, (SELECT full_name FROM guest WHERE id = ${r.guest_id}) AS guest, (SELECT confirmation_no FROM reservation WHERE id = ${r.reservation_id}) AS conf, (SELECT status FROM reservation_room WHERE id = ${r.reservation_room_id}) AS line_status,
          (SELECT full_name FROM staff_user WHERE id = ${r.reported_by}) AS reporter, (SELECT full_name FROM staff_user WHERE id = ${r.approved_by}) AS approver, (SELECT full_name FROM staff_user WHERE id = ${r.charged_by}) AS charger, (SELECT full_name FROM staff_user WHERE id = ${r.guest_notified_by}) AS notifier`.execute(trx);
      const n = names.rows[0]!;
      const events = await sql<Record<string, any>>`SELECT e.id, e.action, e.note, e.details, e.at, u.full_name AS who FROM damage_event e LEFT JOIN staff_user u ON u.id = e.actor_id WHERE e.damage_id = ${id} ORDER BY e.at, e.id`.execute(trx);
      const photos = await trx.selectFrom('damage_media').select(['id', 'created_at']).where('damage_id', '=', id).orderBy('created_at').execute();
      const canCharge = (await this.authz.check(userId, { permission: 'damage.charge', scope: { propertyId } })).effect === 'ALLOW';
      let folio: { number: string; status: string; balance: ReturnType<typeof fmt> } | null = null;
      if (r.folio_id) { const f = await trx.selectFrom('folio').select(['folio_no', 'status', 'balance_minor']).where('id', '=', r.folio_id).executeTakeFirst(); if (f) folio = { number: f.folio_no, status: f.status, balance: fmt(f.balance_minor, p.currency) }; }
      return { ...this.brief(r, p.currency, { room: n.room, guest: n.guest, conf: n.conf, reporter: n.reporter }), internalNote: r.internal_note, lineStatus: n.line_status, guestNotifiedAt: r.guest_notified_at, guestNotifiedBy: n.notifier, guestResponse: r.guest_response, guestResponseNote: r.guest_response_note, guestResponseAt: r.guest_response_at,
        approvedBy: n.approver, approvedAt: r.approved_at, chargedBy: n.charger, chargedAt: r.charged_at, postingId: r.posting_id, folio, waiveReason: r.waive_reason, resolutionNote: r.resolution_note, canCharge, currency: p.currency,
        taxNote: 'The charge is posted as a miscellaneous charge and taxed by the property’s tax rules for that code.',
        events: events.rows.map((e) => ({ id: e.id, action: e.action, note: e.note, details: e.details, at: e.at, by: e.who })), photos: photos.map((x) => ({ id: x.id })) };
    });
  }

  async update(propertyId: string, id: string, userId: string, i: z.infer<typeof S.DamageUpdate>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const r = await this.row(trx, propertyId, id);
      if (!OPEN_STATES.includes(r.status)) throw fail(409, 'CASE_CLOSED', 'This case is closed; its facts can no longer be changed');
      const set: Record<string, unknown> = {}; const changed: string[] = [];
      for (const [k, col] of [['area', 'area'], ['category', 'category'], ['severity', 'severity'], ['description', 'description']] as const) if (i[k] !== undefined && i[k] !== r[col]) { set[col] = i[k]; changed.push(k); }
      if (i.estimatedCost !== undefined) { set.estimated_minor = i.estimatedCost === null ? null : this.parse(i.estimatedCost, p.currency).toString(); changed.push('estimatedCost'); }
      if (i.actualCost !== undefined) { set.actual_minor = i.actualCost === null ? null : this.parse(i.actualCost, p.currency).toString(); changed.push('actualCost'); }
      if (i.internalNote !== undefined) { set.internal_note = i.internalNote; changed.push('internalNote'); }
      if (!changed.length) return { id };
      await trx.updateTable('damage_case').set({ ...set, version: sql`version + 1` } as never).where('id', '=', id).execute();
      await this.event(trx, id, 'UPDATED', userId, null, { fields: changed, before: Object.fromEntries(Object.keys(set).map((k) => [k, (r as Record<string, unknown>)[k] ?? null])) });
      return { id };
    });
  }

  private async transition(propertyId: string, id: string, userId: string, from: string[], to: string, apply: (trx: Trx, r: Awaited<ReturnType<DamageService['row']>>, p: Awaited<ReturnType<DamageService['prop']>>) => Promise<{ set?: Record<string, unknown>; note?: string | null; details?: object; action: string }>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const r = await this.row(trx, propertyId, id);
      if (!from.includes(r.status)) throw fail(409, 'INVALID_STATE', `This cannot be done while the case is “${r.status.toLowerCase().replace('_', ' ')}”`);
      const o = await apply(trx, r, p);
      await trx.updateTable('damage_case').set({ ...(o.set ?? {}), status: to, version: sql`version + 1` } as never).where('id', '=', id).execute();
      await this.event(trx, id, o.action, userId, o.note, o.details);
      await this.audit.record(trx, { action: `damage.${o.action.toLowerCase()}`, resourceType: 'damage_case', resourceId: id, propertyId, before: { status: r.status }, after: { status: to, ...(o.details ?? {}) } });
      return { id, status: to };
    });
  }

  verify(pid: string, id: string, userId: string, i: z.infer<typeof S.Verify>) {
    return this.transition(pid, id, userId, ['SUSPECTED'], 'VERIFIED', async (_t, _r, p) => ({ action: 'VERIFIED', note: i.note ?? null, set: i.actualCost ? { actual_minor: this.parse(i.actualCost, p.currency).toString() } : {} }));
  }
  dismiss(pid: string, id: string, userId: string, i: z.infer<typeof S.Reason>) {
    return this.transition(pid, id, userId, ['SUSPECTED', 'VERIFIED', 'DISPUTED'], 'DISMISSED', async () => ({ action: 'DISMISSED', note: i.reason, set: { resolution_note: i.reason } }));
  }
  async notifyGuest(pid: string, id: string, userId: string) {
    return this.tdb.tx(async (trx) => {
      const r = await this.row(trx, pid, id);
      if (!['VERIFIED', 'CHARGE_APPROVED', 'DISPUTED'].includes(r.status)) throw fail(409, 'INVALID_STATE', 'Verify the damage before telling the guest');
      await trx.updateTable('damage_case').set({ guest_notified_at: sql`now()`, guest_notified_by: userId, version: sql`version + 1` } as never).where('id', '=', id).execute();
      await this.event(trx, id, 'GUEST_NOTIFIED', userId); return { id };
    });
  }
  async guestResponse(pid: string, id: string, userId: string, i: z.infer<typeof S.GuestResponse>) {
    return this.tdb.tx(async (trx) => {
      const r = await this.row(trx, pid, id);
      if (!r.guest_notified_at) throw fail(409, 'GUEST_NOT_NOTIFIED', 'Record that the guest was told first');
      if (!OPEN_STATES.includes(r.status)) throw fail(409, 'CASE_CLOSED', 'This case is closed');
      await trx.updateTable('damage_case').set({ guest_response: i.response, guest_response_note: i.note ?? null, guest_response_at: sql`now()`, ...(i.response === 'DISPUTED' ? { status: 'DISPUTED' } : r.status === 'DISPUTED' ? { status: 'VERIFIED' } : {}), version: sql`version + 1` } as never).where('id', '=', id).execute();
      await this.event(trx, id, i.response === 'DISPUTED' ? 'GUEST_DISPUTED' : 'GUEST_ACKNOWLEDGED', userId, i.note); return { id };
    });
  }
  approveCharge(pid: string, id: string, userId: string, i: z.infer<typeof S.ApproveCharge>) {
    return this.transition(pid, id, userId, ['VERIFIED', 'DISPUTED', 'CHARGE_APPROVED'], 'CHARGE_APPROVED', async (_t, r, p) => {
      if (!r.guest_notified_at) throw fail(409, 'GUEST_NOT_NOTIFIED', 'Tell the guest about the damage and the amount before approving a charge');
      if (!r.reservation_id) throw fail(409, 'NO_BOOKING', 'This damage is not linked to a booking, so there is no bill to charge');
      const amount = this.parse(i.amount, p.currency); if (amount <= 0n) throw fail(422, 'AMOUNT_INVALID', 'The charge must be more than zero');
      return { action: 'CHARGE_APPROVED', note: i.reason ?? null, set: { charge_minor: amount.toString(), approved_by: userId, approved_at: sql`now()` }, details: { amount: amount.toString() } };
    });
  }
  async charge(pid: string, id: string, userId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, pid); const r = await this.row(trx, pid, id);
      if (r.status !== 'CHARGE_APPROVED' || !r.charge_minor || !r.reservation_id) throw fail(409, 'INVALID_STATE', 'Approve the charge first');
      if (r.posting_id) throw fail(409, 'ALREADY_CHARGED', 'This charge is already on the bill');
      const f = await trx.selectFrom('folio').select(['id', 'currency', 'status']).where('reservation_id', '=', r.reservation_id).where('folio_type', '=', 'GUEST').where('status', '<>', 'VOID').executeTakeFirst();
      if (!f) throw fail(409, 'NO_FOLIO', 'The booking has no guest bill');
      if (f.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'The guest bill is already closed. Reopen it, or settle this separately.');
      const net = BigInt(r.charge_minor) - BigInt(r.waived_minor); if (net <= 0n) throw fail(409, 'NOTHING_TO_CHARGE', 'The whole amount was waived');
      const postingId = await this.folio.post(trx, { folioId: f.id, propertyId: pid, currency: f.currency, type: 'CHARGE', txnCode: 'MISC', amount: net, businessDate: p.business_date, sourceType: 'DAMAGE', sourceRef: id, description: `Damage: ${r.area} (${r.ref})`, userId, lineId: r.reservation_room_id ?? undefined });
      await trx.updateTable('damage_case').set({ status: 'CHARGED', posting_id: postingId, folio_id: f.id, charged_by: userId, charged_at: sql`now()`, version: sql`version + 1` } as never).where('id', '=', id).execute();
      await this.event(trx, id, 'CHARGED', userId, null, { postingId, amount: net.toString() });
      await this.audit.record(trx, { action: 'damage.charged', resourceType: 'damage_case', resourceId: id, propertyId: pid, after: { postingId, amount: net.toString(), folioId: f.id } });
      return { id, postingId, charged: fmt(net, f.currency) };
    });
  }
  waive(pid: string, id: string, userId: string, i: z.infer<typeof S.Waive>) {
    return this.transition(pid, id, userId, ['VERIFIED', 'DISPUTED', 'CHARGE_APPROVED'], 'WAIVED', async (_t, r, p) => {
      const base = r.charge_minor ?? r.actual_minor ?? r.estimated_minor ?? '0';
      const amount = i.amount ? this.parse(i.amount, p.currency) : BigInt(base);
      return { action: 'WAIVED', note: i.reason, set: { waived_minor: amount.toString(), waive_reason: i.reason, approved_by: userId, approved_at: sql`now()` }, details: { amount: amount.toString() } };
    });
  }
  resolve(pid: string, id: string, userId: string, i: z.infer<typeof S.Resolve>) {
    return this.transition(pid, id, userId, ['CHARGED', 'WAIVED', 'DISMISSED'], 'RESOLVED', async () => ({ action: 'RESOLVED', note: i.note, set: { resolution_note: i.note } }));
  }
  async addNote(pid: string, id: string, userId: string, i: z.infer<typeof S.Note>) {
    return this.tdb.tx(async (trx) => { await this.row(trx, pid, id); await this.event(trx, id, 'NOTE', userId, i.note); return { id }; });
  }

  async addPhoto(pid: string, id: string, userId: string, data: Buffer) {
    const file = await this.media.savePrivateImage(data, 8 * 1024 * 1024);
    try {
      return await this.tdb.tx(async (trx) => {
        await this.row(trx, pid, id);
        const n = await trx.selectFrom('damage_media').select(({ fn }) => fn.countAll<string>().as('n')).where('damage_id', '=', id).executeTakeFirstOrThrow();
        if (Number(n.n) >= 10) throw fail(409, 'PHOTO_LIMIT', 'A case can have up to 10 pictures');
        const m = await trx.insertInto('damage_media').values({ tenant_id: currentTenant().tenantId, damage_id: id, file_name: file, uploaded_by: userId }).returning('id').executeTakeFirstOrThrow();
        await this.event(trx, id, 'PHOTO_ADDED', userId); return { id: m.id };
      });
    } catch (e) { await this.media.removePrivate(file); throw e; }
  }
  async photoFile(pid: string, id: string, photoId: string) {
    const f = await this.tdb.tx(async (trx) => { await this.row(trx, pid, id); return trx.selectFrom('damage_media').select('file_name').where('id', '=', photoId).where('damage_id', '=', id).executeTakeFirst(); });
    if (!f) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Picture not found' });
    return this.media.readPrivate(f.file_name);
  }
}
