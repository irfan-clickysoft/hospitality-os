import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { DB } from '@hos/db';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';
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

  /** Name (fuzzy), phone (any format) or email. */
  async search(q: string, limit = 20) {
    const text = q.trim();
    if (text.length < 2) return [];
    const norm = normalizePhone(text);
    const rows = await this.tdb.tx((trx) => trx.selectFrom('guest').selectAll().where((eb) => eb.or([
      sql<boolean>`full_name % ${text}`, sql<boolean>`full_name ILIKE ${'%' + text.replace(/[%_]/g, '') + '%'}`,
      ...(norm ? [eb('phone_norm', 'like', `%${norm.slice(-9)}`)] : []), eb('email', '=', text),
    ])).orderBy(sql`similarity(full_name, ${text})`, 'desc').limit(Math.min(limit, 50)).execute());
    return rows.map(dto);
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
