import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { DB } from '@hos/db';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { idSearchHashes } from '../front-desk/id-documents.js';
import { normalizePhone } from './phone.js';
import { residencyOf, type CreateGuest, type UpdateGuest } from './schemas.js';

const dto = (g: any) => ({ id: g.id, fullName: g.full_name, phone: g.phone, email: g.email, nationality: g.nationality, residency: g.residency, vip: g.vip, doNotRent: g.do_not_rent, notes: g.notes, version: g.version });

@Injectable()
export class GuestsService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService) {}

  async create(i: z.infer<typeof CreateGuest>) { return this.tdb.tx((trx) => this.createIn(trx, i)); }

  /** Same as create, inside the caller's transaction (a booking creates its guest atomically). */
  async createIn(trx: Transaction<DB>, i: z.infer<typeof CreateGuest>) {
    {
      const norm = normalizePhone(i.phone);
      if (!i.allowDuplicate && (norm || i.email)) {
        const dup = await trx.selectFrom('guest').selectAll().where((eb) => eb.or([...(norm ? [eb('phone_norm', '=', norm)] : []), ...(i.email ? [eb('email', '=', i.email)] : [])])).limit(5).execute();
        if (dup.length) throw new HttpException({ code: 'DUPLICATE_GUEST', message: 'A guest with this phone number or email already exists. Use the existing profile or confirm it is a different person.', candidates: dup.map(dto) }, 409);
      }
      const g = await trx.insertInto('guest').values({ tenant_id: currentTenant().tenantId, full_name: i.fullName.trim(), phone: i.phone ?? null, phone_norm: norm, email: i.email ?? null,
        nationality: i.nationality ?? null, residency: residencyOf(i.nationality), vip: i.vip, notes: i.notes ?? null }).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'guest.create', resourceType: 'guest', resourceId: g.id, after: { fullName: g.full_name, nationality: g.nationality, vip: g.vip } });
      return dto(g);
    }
  }

  async get(id: string) {
    const g = await this.tdb.tx((trx) => trx.selectFrom('guest').selectAll().where('id', '=', id).executeTakeFirst());
    if (!g) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Guest not found' });
    return dto(g);
  }

  /**
   * Find a returning guest from whatever the desk has: any part of the name in any order, a phone number in any format, an email, or an ID number (CNIC or passport).
   * An ID is matched through its keyed hash: the number itself is never readable here. Each result says how many stays the guest has had and when the last was.
   */
  async search(q: string, limit = 20) {
    const text = q.trim();
    if (text.length < 2) return [];
    const norm = normalizePhone(text);
    const tokens = text.split(/\s+/).map((t) => t.replace(/[%_]/g, '')).filter((t) => t.length >= 2).slice(0, 5);
    const hashes = idSearchHashes(text);
    const out = await this.tdb.tx(async (trx) => {
      const rows = await trx.selectFrom('guest').selectAll().where((eb) => eb.or([
        sql<boolean>`full_name % ${text}`,
        ...(tokens.length ? [eb.and(tokens.map((t) => sql<boolean>`full_name ILIKE ${'%' + t + '%'}`))] : []),
        ...(norm ? [eb('phone_norm', 'like', `%${norm.slice(-9)}`)] : []), eb('email', '=', text),
        ...(hashes.length ? [eb('id', 'in', eb.selectFrom('stay_guest as sg').innerJoin('reservation_room as rr', 'rr.id', 'sg.reservation_room_id').innerJoin('reservation as r', 'r.id', 'rr.reservation_id').select('r.guest_id').where('sg.id_hash', 'in', hashes))] : []),
      ])).orderBy(sql`similarity(full_name, ${text})`, 'desc').limit(Math.min(limit, 50)).execute();
      if (!rows.length) return [];
      const ids = rows.map((g) => g.id);
      const stays = await trx.selectFrom('reservation as r').innerJoin('reservation_room as rr', 'rr.reservation_id', 'r.id').select(['r.guest_id', sql<number>`count(distinct r.id)::int`.as('n'), sql<string>`max(rr.arrival)`.as('last')])
        .where('r.guest_id', 'in', ids).where('rr.status', 'in', ['CHECKED_IN', 'CHECKED_OUT']).groupBy('r.guest_id').execute();
      const byId = hashes.length ? new Set((await trx.selectFrom('stay_guest as sg').innerJoin('reservation_room as rr', 'rr.id', 'sg.reservation_room_id').innerJoin('reservation as r', 'r.id', 'rr.reservation_id').select('r.guest_id').where('sg.id_hash', 'in', hashes).where('r.guest_id', 'in', ids).execute()).map((x) => x.guest_id)) : new Set<string>();
      return rows.map((g) => { const st = stays.find((x) => x.guest_id === g.id); return { ...dto(g), stays: st?.n ?? 0, lastStay: st?.last ?? null, matchedById: byId.has(g.id) }; });
    });
    return out;
  }

  async update(id: string, i: z.infer<typeof UpdateGuest>) {
    return this.tdb.tx(async (trx) => {
      const before = await trx.selectFrom('guest').selectAll().where('id', '=', id).executeTakeFirst();
      if (!before) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Guest not found' });
      const m: Record<string, unknown> = { version: sql`version + 1` };
      if (i.fullName !== undefined) m.full_name = i.fullName.trim();
      if (i.phone !== undefined) { m.phone = i.phone; m.phone_norm = normalizePhone(i.phone); }
      if (i.email !== undefined) m.email = i.email;
      if (i.nationality !== undefined) { m.nationality = i.nationality; m.residency = residencyOf(i.nationality); }
      if (i.vip !== undefined) m.vip = i.vip;
      if (i.doNotRent !== undefined) m.do_not_rent = i.doNotRent;
      if (i.notes !== undefined) m.notes = i.notes;
      const after = await trx.updateTable('guest').set(m as never).where('id', '=', id).where('version', '=', i.version).returningAll().executeTakeFirst();
      if (!after) throw new HttpException({ code: 'VERSION_CONFLICT', message: 'This guest was changed by someone else. Reload and try again.' }, 412);
      await this.audit.record(trx, { action: 'guest.update', resourceType: 'guest', resourceId: id, before: dto(before), after: dto(after) });
      return dto(after);
    });
  }
}
