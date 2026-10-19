import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { ROLE_TEMPLATES } from '@hos/auth';
import type { DB } from '@hos/db';
import { DB_ADMIN } from '../db/db.module.js';
import { newToken } from '../identity/tokens.js';

export interface CreateTenantInput {
  name: string; slug: string; ownerEmail: string; ownerName: string;
  legalEntityName?: string; referredBy?: string; platformActorId?: string;
}
/** `ownerInviteToken` is shown once to the platform operator for delivery (email/WhatsApp); only its hash is stored. */
export interface CreatedTenant { tenantId: string; legalEntityId: string; ownerUserId: string; ownerInviteToken: string }

/** Platform-realm operation (BYPASSRLS connection): creates a tenant with its legal entity, system roles and owner. */
@Injectable()
export class ProvisioningService {
  constructor(@Inject(DB_ADMIN) private readonly admin: Kysely<DB> | null) {}

  async createTenant(input: CreateTenantInput): Promise<CreatedTenant> {
    if (!this.admin) throw new Error('Provisioning requires DATABASE_URL_ADMIN');
    return this.admin.transaction().execute(async (trx) => {
      const tenant = await trx.insertInto('tenant').values({ name: input.name, slug: input.slug, status: 'TRIALING', referred_by: input.referredBy ?? null })
        .returning('id').executeTakeFirstOrThrow();
      const tenantId = tenant.id;
      const le = await trx.insertInto('legal_entity').values({ tenant_id: tenantId, name: input.legalEntityName ?? input.name, ntn: null, strn: null, address: null })
        .returning('id').executeTakeFirstOrThrow();

      const roleIds = new Map<string, string>();
      for (const t of ROLE_TEMPLATES) {
        const r = await trx.insertInto('role').values({ tenant_id: tenantId, key: t.key, name: t.name, is_system: true }).returning('id').executeTakeFirstOrThrow();
        roleIds.set(t.key, r.id);
        await trx.insertInto('role_permission').values(t.permissions.map((p) => ({ tenant_id: tenantId, role_id: r.id, permission_key: p }))).execute();
      }
      const owner = await trx.insertInto('staff_user').values({
        tenant_id: tenantId, email: input.ownerEmail, full_name: input.ownerName, password_hash: null, status: 'INVITED',
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('role_assignment').values({
        tenant_id: tenantId, user_id: owner.id, role_id: roleIds.get('group_owner')!, scope_type: 'TENANT', scope_id: null, valid_to: null,
      }).execute();

      const invite = newToken(tenantId);
      await trx.insertInto('user_token').values({
        tenant_id: tenantId, user_id: owner.id, purpose: 'INVITE', token_hash: invite.hash, expires_at: new Date(Date.now() + 7 * 86_400_000), used_at: null,
      }).execute();
      await trx.insertInto('audit_log').values({
        tenant_id: tenantId, actor_type: input.platformActorId ? 'PLATFORM_USER' : 'SYSTEM', actor_id: input.platformActorId ?? null, on_behalf_of: null,
        action: 'tenant.create', resource_type: 'tenant', resource_id: tenantId, property_id: null,
        before: null, after: JSON.stringify({ name: input.name, slug: input.slug }), reason_code: null, note: null, request_id: null, ip: null, user_agent: null,
      }).execute();
      await trx.insertInto('outbox_event').values({
        tenant_id: tenantId, aggregate_type: 'tenant', aggregate_id: tenantId, event_type: 'TenantCreated', event_version: 1,
        property_id: null, business_date: null, payload: JSON.stringify({ tenantId, slug: input.slug }), published_at: null,
      }).execute();
      return { tenantId, legalEntityId: le.id, ownerUserId: owner.id, ownerInviteToken: invite.token };
    });
  }

  /**
   * Brings every tenant's built-in roles up to the current templates: adds roles that did not exist when the tenant was created and adds permissions that
   * were introduced later. It only ever adds — a permission a tenant removed from a built-in role stays removed only if it was never part of the template,
   * and custom roles are never touched. Run it after each release (the deploy pipeline will do this automatically).
   */
  async syncSystemRoles(tenantId?: string): Promise<{ tenants: number; rolesAdded: number; permissionsAdded: number }> {
    if (!this.admin) throw new Error('Provisioning requires DATABASE_URL_ADMIN');
    return this.admin.transaction().execute(async (trx) => {
      let q = trx.selectFrom('tenant').select('id');
      if (tenantId) q = q.where('id', '=', tenantId);
      const tenants = await q.execute();
      let rolesAdded = 0, permissionsAdded = 0;
      for (const t of tenants) {
        for (const tpl of ROLE_TEMPLATES) {
          let role = await trx.selectFrom('role').select('id').where('tenant_id', '=', t.id).where('key', '=', tpl.key).executeTakeFirst();
          if (!role) { role = await trx.insertInto('role').values({ tenant_id: t.id, key: tpl.key, name: tpl.name, is_system: true }).returning('id').executeTakeFirstOrThrow(); rolesAdded++; }
          const have = new Set((await trx.selectFrom('role_permission').select('permission_key').where('tenant_id', '=', t.id).where('role_id', '=', role.id).execute()).map((r) => r.permission_key));
          const missing = tpl.permissions.filter((p) => !have.has(p));
          if (missing.length) { await trx.insertInto('role_permission').values(missing.map((p) => ({ tenant_id: t.id, role_id: role!.id, permission_key: p }))).execute(); permissionsAdded += missing.length; }
        }
      }
      return { tenants: tenants.length, rolesAdded, permissionsAdded };
    });
  }
}
