import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { TenantDb } from '../db/tenant-db.js';
import { GuestsService } from '../guests/guests.service.js';
import { FolioService } from '../folio/folio.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';

const fail = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const text = (n: number) => z.string().trim().max(n).nullish().transform((v) => (v ? v : null));

export const LogVisit = z.object({
  kind: z.enum(['VISITOR', 'VEHICLE', 'DELIVERY', 'CONTRACTOR']), name: z.string().trim().min(2).max(120).nullish().transform((v) => v ?? null), phone: text(30), idLast4: z.string().regex(/^[0-9A-Za-z]{4}$/).nullish().transform((v) => v ?? null),
  plate: z.string().trim().min(2).max(20).nullish().transform((v) => (v ? v.toUpperCase() : null)), visiting: text(120), purpose: text(200), note: text(300),
}).refine((v) => v.name || v.plate, { message: 'Give a name or a vehicle number', path: ['name'] });

/** The gate: who is expected today (names shortened, nothing else about the guest), and a log of visitors, vehicles and deliveries coming in and going out. */
@Injectable()
export class GateService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(FolioService) private readonly folios: FolioService, @Inject(AuditService) private readonly audit: AuditService, @Inject(GuestsService) private readonly guests: GuestsService, @Inject(CLOCK) private readonly clock: ClockLike) {}

  /** "Sara Khan" → "Sara K.": enough for the gate to recognise an arrival, not enough to identify the guest elsewhere. */
  private short(full: string) { const p = full.trim().split(/\s+/); return p.length < 2 ? p[0]! : `${p[0]} ${p[p.length - 1]![0]!.toUpperCase()}.`; }

  async arrivals(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const rows = await sql<{ confirmation_no: string; guest: string; type: string; adults: number; children: number; status: string; room: string | null }>`
        SELECT r.confirmation_no, g.full_name AS guest, rt.name AS type, l.adults, l.children, l.status, rm.number AS room
        FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id
        JOIN room_type rt ON rt.id = l.room_type_id LEFT JOIN room_assignment a ON a.assignment_ref = l.id AND a.status IN ('ASSIGNED','IN_HOUSE') LEFT JOIN room rm ON rm.id = a.room_id
        WHERE l.tenant_id = ${currentTenant().tenantId} AND l.property_id = ${propertyId} AND l.arrival = ${p.business_date}::date AND l.status IN ('CONFIRMED','CHECKED_IN')
        ORDER BY l.status DESC, r.confirmation_no`.execute(trx);
      const inHouse = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM reservation_room WHERE tenant_id = ${currentTenant().tenantId} AND property_id = ${propertyId} AND status = 'CHECKED_IN'`.execute(trx)).rows[0]!.n;
      return { date: p.business_date, inHouse, items: rows.rows.map((r) => ({ confirmationNo: r.confirmation_no, guest: this.short(r.guest), roomType: r.type, adults: r.adults, children: r.children, arrived: r.status === 'CHECKED_IN', room: r.room })) };
    });
  }

  private view(v: { id: string; kind: string; name: string | null; phone: string | null; id_last4: string | null; plate: string | null; visiting: string | null; purpose: string | null; note: string | null; in_at: Date; out_at: Date | null; guest_id?: string | null }) {
    return { id: v.id, kind: v.kind, name: v.name, phone: v.phone, idLast4: v.id_last4, plate: v.plate, visiting: v.visiting, purpose: v.purpose, note: v.note, inAt: v.in_at, outAt: v.out_at, guestId: v.guest_id ?? null };
  }
  async log(propertyId: string, userId: string, i: z.infer<typeof LogVisit>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const v = await trx.insertInto('gate_visit').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, kind: i.kind, name: i.name, phone: i.phone, id_last4: i.idLast4, plate: i.plate, visiting: i.visiting, purpose: i.purpose, note: i.note,
        in_at: new Date(this.clock.now()), logged_by: userId, business_date: p.business_date } as never).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'gate.in', resourceType: 'gate_visit', resourceId: v.id, propertyId, after: { kind: i.kind, name: i.name, plate: i.plate, visiting: i.visiting } });
      return this.view(v as never);
    });
  }
  async out(propertyId: string, id: string, userId: string) {
    return this.tdb.tx(async (trx) => {
      const v = await trx.selectFrom('gate_visit').selectAll().where('id', '=', id).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
      if (!v) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Entry not found' });
      if (v.out_at) throw fail(409, 'ALREADY_OUT', 'This visit is already marked as gone');
      const u = await trx.updateTable('gate_visit').set({ out_at: new Date(this.clock.now()), out_by: userId } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'gate.out', resourceType: 'gate_visit', resourceId: id, propertyId });
      return this.view(u as never);
    });
  }
  /** A visitor who is staying the night is registered as a guest (name and phone from the gate log); the full ID is taken at check-in, on the registration card. */
  async register(propertyId: string, id: string, userId: string, nationality: string | null, allowDuplicate: boolean) {
    return this.tdb.tx(async (trx) => {
      const v = await trx.selectFrom('gate_visit').selectAll().where('id', '=', id).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
      if (!v) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Entry not found' });
      if (v.kind !== 'VISITOR' || !v.name) throw fail(422, 'NOT_A_VISITOR', 'Only a named visitor can be registered as a guest');
      if (v.guest_id) throw fail(409, 'ALREADY_REGISTERED', 'This visitor is already registered as a guest');
      const g = await this.guests.createIn(trx, { fullName: v.name, phone: v.phone, nationality, vip: false, allowDuplicate } as never);
      await trx.updateTable('gate_visit').set({ guest_id: g.id } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'gate.register_guest', resourceType: 'gate_visit', resourceId: id, propertyId, after: { guestId: g.id } });
      return { guest: g, visit: this.view({ ...v, guest_id: g.id } as never) };
    });
  }
  /** Who is at the property now, and what came and went today (by business date). */
  async list(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const open = await trx.selectFrom('gate_visit').selectAll().where('property_id', '=', propertyId).where('out_at', 'is', null).orderBy('in_at', 'desc').limit(200).execute();
      const done = await trx.selectFrom('gate_visit').selectAll().where('property_id', '=', propertyId).where('out_at', 'is not', null).where('business_date', '=', p.business_date).orderBy('out_at', 'desc').limit(200).execute();
      return { open: open.map((v) => this.view(v as never)), today: done.map((v) => this.view(v as never)) };
    });
  }
}
