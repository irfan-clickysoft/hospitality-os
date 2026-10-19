import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuthorizationService } from '../authz/authorization.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';

export type Status = 'OK' | 'ACTION' | 'NOTE';
export interface Check { code: string; status: Status; propertyId: string | null; propertyName: string | null; count?: number; detail?: string }

/**
 * "What is still missing before we run the business on this?" Reads the live configuration and says, per business and per property, what is set up,
 * what needs doing (money would be wrong or untaxed without it) and what is worth a look. Nothing here changes data; nothing is hidden or assumed.
 */
@Injectable()
export class ReadinessService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuthorizationService) private readonly authz: AuthorizationService) {}

  async report(userId: string) {
    return this.tdb.tx(async (trx) => {
      const t = currentTenant().tenantId;
      const props = await trx.selectFrom('property').select(['id', 'code', 'name', 'tax_jurisdiction', 'weekend_days', 'status']).where('status', '<>', 'ARCHIVED').orderBy('name').execute();
      const allowed: typeof props = [];
      for (const p of props) if ((await this.authz.check(userId, { permission: 'management.view', scope: { propertyId: p.id } })).effect === 'ALLOW') allowed.push(p);
      if (!allowed.length) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'This action needs the "management.view" permission' });
      const whole = allowed.length === props.length;
      const out: Check[] = [];
      const add = (c: Check) => out.push(c);

      if (whole) {
        for (const le of await trx.selectFrom('legal_entity').select(['name', 'ntn', 'strn']).execute()) {
          add({ code: 'ENTITY_NTN', status: le.ntn ? 'OK' : 'ACTION', propertyId: null, propertyName: le.name });
          add({ code: 'ENTITY_STRN', status: le.strn ? 'OK' : 'ACTION', propertyId: null, propertyName: le.name });
        }
        const noMfa = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM staff_user WHERE tenant_id = ${t} AND status = 'ACTIVE' AND NOT mfa_enabled`.execute(trx)).rows[0]!.n;
        add({ code: 'STAFF_MFA', status: Number(noMfa) === 0 ? 'OK' : 'NOTE', propertyId: null, propertyName: null, count: Number(noMfa) });
      }

      for (const p of allowed) {
        const base = { propertyId: p.id, propertyName: p.name };
        const taxActive = p.tax_jurisdiction ? (await sql<{ n: string }>`SELECT count(*)::text AS n FROM tax_code c JOIN tax_code_version v ON v.tenant_id = c.tenant_id AND v.tax_code_id = c.id
          WHERE c.tenant_id = ${t} AND c.jurisdiction = ${p.tax_jurisdiction} AND v.status = 'ACTIVE'`.execute(trx)).rows[0]!.n : '0';
        add({ code: !p.tax_jurisdiction ? 'TAX_JURISDICTION' : 'TAX_RATES', status: Number(taxActive) > 0 ? 'OK' : 'ACTION', ...base });

        const types = await sql<{ id: string; rooms: string; bar: string | null; amount: string | null; extra_adult: string | null; weekend: string | null }>`
          SELECT rt.id, (SELECT count(*) FROM room r WHERE r.tenant_id = rt.tenant_id AND r.room_type_id = rt.id)::text AS rooms,
            (SELECT rp.id::text FROM rate_plan rp WHERE rp.tenant_id = rt.tenant_id AND rp.property_id = rt.property_id AND rp.code = 'BAR' AND rp.status = 'ACTIVE' LIMIT 1) AS bar,
            b.amount_minor::text AS amount, b.extra_adult_minor::text AS extra_adult, b.weekend_amount_minor::text AS weekend
          FROM room_type rt LEFT JOIN rate_plan rp ON rp.tenant_id = rt.tenant_id AND rp.property_id = rt.property_id AND rp.code = 'BAR' AND rp.status = 'ACTIVE'
          LEFT JOIN rate_base b ON b.tenant_id = rt.tenant_id AND b.rate_plan_id = rp.id AND b.room_type_id = rt.id
          WHERE rt.tenant_id = ${t} AND rt.property_id = ${p.id}`.execute(trx);
        const unpriced = types.rows.filter((x) => !x.amount || BigInt(x.amount) <= 0n).length;
        add({ code: 'RATES', status: types.rows.length > 0 && unpriced === 0 ? 'OK' : 'ACTION', count: unpriced, ...base });
        const noRooms = types.rows.filter((x) => Number(x.rooms) === 0).length;
        if (noRooms) add({ code: 'ROOMTYPE_EMPTY', status: 'NOTE', count: noRooms, ...base });
        const zeroExtras = types.rows.filter((x) => x.amount && x.extra_adult !== null && BigInt(x.extra_adult) === 0n).length;
        add({ code: 'EXTRAS', status: zeroExtras === 0 ? 'OK' : 'NOTE', count: zeroExtras, ...base });

        const accts = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM payment_account WHERE tenant_id = ${t} AND (property_id = ${p.id} OR property_id IS NULL) AND status = 'ACTIVE'`.execute(trx)).rows[0]!.n;
        add({ code: 'PAYMENT_ACCOUNTS', status: Number(accts) > 0 ? 'OK' : 'ACTION', ...base });
        const menu = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM menu_item WHERE tenant_id = ${t} AND property_id = ${p.id} AND active`.execute(trx)).rows[0]!.n;
        add({ code: 'MENU', status: Number(menu) > 0 ? 'OK' : 'NOTE', ...base });
        const spaces = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM space WHERE tenant_id = ${t} AND property_id = ${p.id} AND active`.execute(trx)).rows[0]!.n;
        if (p.code === 'BLVD' || Number(spaces) > 0) add({ code: 'SPACES', status: Number(spaces) > 0 ? 'OK' : 'NOTE', ...base });
      }
      const rank: Record<Status, number> = { ACTION: 0, NOTE: 1, OK: 2 };
      out.sort((a, b) => rank[a.status] - rank[b.status]);
      return { items: out, summary: { action: out.filter((x) => x.status === 'ACTION').length, note: out.filter((x) => x.status === 'NOTE').length, ok: out.filter((x) => x.status === 'OK').length } };
    });
  }
}
