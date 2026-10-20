import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import type { Trx } from '../companies/companies.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { newToken } from '../identity/tokens.js';
import { SessionService } from '../identity/session.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { ROLE_PRESETS } from './presets.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const INVITE_DAYS = 7;

/** Who may use the system and what they may do. Nobody can lift themselves or others above their own authority, lock the business out of itself, or touch an account they do not outrank. */
@Injectable()
export class StaffService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  // ───────────── reading ─────────────
  async roles() {
    return this.tdb.tx(async (trx) => {
      const roles = await trx.selectFrom('role').select(['id', 'key', 'name', 'is_system']).orderBy('name').execute();
      const perms = await trx.selectFrom('role_permission').select(['role_id', 'permission_key']).execute();
      const labels = await trx.selectFrom('permission').select(['key', 'description']).execute();
      const have = new Set(roles.map((r) => r.key));
      return { permissionLabels: Object.fromEntries(labels.map((p) => [p.key, p.description])), presets: ROLE_PRESETS.map((p) => ({ ...p, roles: p.roles.filter((k) => have.has(k)) })).filter((p) => p.roles.length >= 2), items: roles.map((r) => ({ key: r.key, name: r.name, system: r.is_system, permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.permission_key).sort() })) };
    });
  }
  /** A number to reach the person on, e.g. to message a technician about an urgent job. */
  async setPhone(actorId: string, id: string, phone: string | null) {
    return this.tdb.tx(async (trx) => {
      const u = await trx.updateTable('staff_user').set({ phone }).where('id', '=', id).returning('id').executeTakeFirst();
      if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });
      await this.audit.record(trx, { action: 'user.phone', resourceType: 'staff_user', resourceId: id, after: { phoneSet: !!phone } });
      void actorId;
      return { id, phone };
    });
  }
  async list() {
    return this.tdb.tx(async (trx) => {
      const users = await trx.selectFrom('staff_user').select(['id', 'email', 'full_name', 'phone', 'status', 'mfa_enabled', 'preferred_locale', 'created_at']).orderBy('full_name').execute();
      const asg = await sql<{ id: string; user_id: string; key: string; name: string; scope_type: string; scope_id: string | null; scope_name: string | null; valid_to: string | null; limits: unknown }>`
        SELECT ra.id, ra.user_id, r.key, r.name, ra.scope_type, ra.scope_id, p.name AS scope_name, ra.valid_to::text, ra.limits FROM role_assignment ra JOIN role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        LEFT JOIN property p ON p.tenant_id = ra.tenant_id AND p.id = ra.scope_id AND ra.scope_type = 'PROPERTY'
        WHERE ra.tenant_id = ${currentTenant().tenantId} AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now()) ORDER BY r.name`.execute(trx);
      const lastSeen = await sql<{ user_id: string; at: string }>`SELECT user_id, max(created_at)::text AS at FROM user_session WHERE tenant_id = ${currentTenant().tenantId} GROUP BY user_id`.execute(trx);
      return { items: users.map((u) => ({ id: u.id, email: u.email, fullName: u.full_name, phone: u.phone, status: u.status, mfaEnabled: u.mfa_enabled, locale: u.preferred_locale, lastLogin: lastSeen.rows.find((x) => x.user_id === u.id)?.at ?? null,
        assignments: asg.rows.filter((a) => a.user_id === u.id).map((a) => ({ id: a.id, roleKey: a.key, role: a.name, scopeType: a.scope_type, scopeId: a.scope_id, scope: a.scope_type === 'TENANT' ? null : a.scope_name, validTo: a.valid_to, limits: a.limits })) })) };
    });
  }

  // ───────────── authority ─────────────
  /** Can the actor assign this role at this scope? (Uses the platform's escalation rules: only roles made of permissions the actor holds, within their own scope and limits.) */
  private async mayAssign(actorId: string, perms: readonly string[], scopeType: 'TENANT' | 'PROPERTY' | 'LEGAL_ENTITY' | 'DEPARTMENT', scopeId: string | null, limits: object = {}) {
    const scope = scopeType === 'PROPERTY' ? await this.authz.resolveScope({ propertyId: scopeId! }) : {};
    return (await this.authz.checkAssignRole(actorId, { rolePermissions: perms, scopeType, scopeId, scope: scope ?? {}, limits: limits as never })).effect === 'ALLOW';
  }
  /** The actor must outrank the target: everything the target holds must be something the actor could hand out. Stops a property manager disabling the owner. */
  private async assertOutranks(trx: Trx, actorId: string, targetId: string) {
    if (actorId === targetId) throw fail(403, 'SELF_ACTION', 'You cannot do this to your own account. Ask another administrator.');
    const rows = await sql<{ scope_type: 'TENANT' | 'PROPERTY' | 'LEGAL_ENTITY' | 'DEPARTMENT'; scope_id: string | null; limits: object; perms: string[] }>`
      SELECT ra.scope_type, ra.scope_id, ra.limits, array_agg(rp.permission_key) AS perms FROM role_assignment ra JOIN role_permission rp ON rp.tenant_id = ra.tenant_id AND rp.role_id = ra.role_id
      WHERE ra.tenant_id = ${currentTenant().tenantId} AND ra.user_id = ${targetId} AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now()) GROUP BY ra.id, ra.scope_type, ra.scope_id, ra.limits`.execute(trx);
    for (const r of rows.rows) if (!(await this.mayAssign(actorId, r.perms, r.scope_type, r.scope_id, r.limits))) throw fail(403, 'INSUFFICIENT_AUTHORITY', 'This person holds more authority than you do');
  }
  private async user(trx: Trx, id: string, lock = false) {
    let q = trx.selectFrom('staff_user').selectAll().where('id', '=', id);
    if (lock) q = q.forUpdate();
    const u = await q.executeTakeFirst();
    if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });
    return u;
  }
  /** At least one active person must always be able to manage the business itself. */
  private async assertNotLastOwner(trx: Trx, exceptUserId: string, exceptAssignmentId?: string) {
    const r = await sql<{ n: number }>`SELECT count(DISTINCT u.id)::int AS n FROM staff_user u JOIN role_assignment ra ON ra.tenant_id = u.tenant_id AND ra.user_id = u.id JOIN role_permission rp ON rp.tenant_id = ra.tenant_id AND rp.role_id = ra.role_id AND rp.permission_key = 'tenant.manage'
      WHERE u.tenant_id = ${currentTenant().tenantId} AND u.status <> 'DISABLED' AND ra.scope_type = 'TENANT' AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
        AND NOT (u.id = ${exceptUserId} AND ${exceptAssignmentId ?? null}::uuid IS NULL) AND (${exceptAssignmentId ?? null}::uuid IS NULL OR ra.id <> ${exceptAssignmentId ?? null}::uuid)`.execute(trx);
    if ((r.rows[0]?.n ?? 0) === 0) throw fail(409, 'LAST_OWNER', 'The business must always keep at least one active owner who can manage it');
  }

  // ───────────── people ─────────────
  private async issueToken(trx: Trx, userId: string, purpose: 'INVITE' | 'PASSWORD_RESET') {
    await trx.updateTable('user_token').set({ used_at: sql`now()` as never }).where('user_id', '=', userId).where('used_at', 'is', null).execute();          // earlier links stop working
    const t = newToken(currentTenant().tenantId);
    await trx.insertInto('user_token').values({ tenant_id: currentTenant().tenantId, user_id: userId, purpose, token_hash: t.hash, expires_at: new Date(this.clock.now() + INVITE_DAYS * 86_400_000), used_at: null } as never).execute();
    return { token: t.token, expiresInDays: INVITE_DAYS };
  }
  async create(actorId: string, i: z.infer<typeof S.CreateUser>) {
    return this.tdb.tx(async (trx) => {
      let u;
      try { u = await trx.insertInto('staff_user').values({ tenant_id: currentTenant().tenantId, email: i.email, full_name: i.fullName, preferred_locale: i.locale, password_hash: null } as never).returning(['id', 'email', 'full_name']).executeTakeFirstOrThrow(); }
      catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE', 'A user with that email already exists'); throw e; }
      const invite = await this.issueToken(trx, u.id, 'INVITE');
      await this.audit.record(trx, { action: 'staff.create', resourceType: 'staff_user', resourceId: u.id, after: { email: u.email, fullName: u.full_name } });
      return { id: u.id, email: u.email, fullName: u.full_name, status: 'INVITED', invite };
    });
  }
  /** A new link for someone who has not accepted yet (invite) or who is locked out (password reset). Shown once; only its hash is kept. */
  async reinvite(actorId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const u = await this.user(trx, id, true);
      if (u.status === 'DISABLED') throw fail(409, 'USER_DISABLED', 'This account is disabled');
      await this.assertOutranks(trx, actorId, id);
      const invite = await this.issueToken(trx, id, u.status === 'INVITED' ? 'INVITE' : 'PASSWORD_RESET');
      await this.sessions.revokeAllForUser(trx, id);
      await this.audit.record(trx, { action: 'staff.reinvite', resourceType: 'staff_user', resourceId: id, after: { purpose: u.status === 'INVITED' ? 'INVITE' : 'PASSWORD_RESET' } });
      return { id, invite, purpose: u.status === 'INVITED' ? 'INVITE' : 'PASSWORD_RESET' };
    });
  }
  async setDisabled(actorId: string, id: string, disabled: boolean, reason: string) {
    return this.tdb.tx(async (trx) => {
      const u = await this.user(trx, id, true);
      await this.assertOutranks(trx, actorId, id);
      if (disabled) {
        if (u.status === 'DISABLED') return { id, status: 'DISABLED' };
        await this.assertNotLastOwner(trx, id);
        await trx.updateTable('staff_user').set({ status: 'DISABLED' } as never).where('id', '=', id).execute();
        await this.sessions.revokeAllForUser(trx, id);
      } else {
        if (u.status !== 'DISABLED') return { id, status: u.status };
        await trx.updateTable('staff_user').set({ status: u.password_hash ? 'ACTIVE' : 'INVITED', failed_login_count: 0, locked_until: null } as never).where('id', '=', id).execute();
      }
      const after = await this.user(trx, id);
      await this.audit.record(trx, { action: disabled ? 'staff.disable' : 'staff.enable', resourceType: 'staff_user', resourceId: id, before: { status: u.status }, after: { status: after.status }, note: reason });
      return { id, status: after.status };
    });
  }
  /** For a lost phone: clears the second factor so the person can enrol again at their next sign-in. */
  async resetMfa(actorId: string, id: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      await this.user(trx, id, true);
      await this.assertOutranks(trx, actorId, id);
      await trx.deleteFrom('user_recovery_code').where('user_id', '=', id).execute();
      await trx.deleteFrom('user_mfa_totp').where('user_id', '=', id).execute();
      await trx.updateTable('staff_user').set({ mfa_enabled: false } as never).where('id', '=', id).execute();
      await this.sessions.revokeAllForUser(trx, id);
      await this.audit.record(trx, { action: 'staff.mfa_reset', resourceType: 'staff_user', resourceId: id, reasonCode: 'MFA_RESET', note: reason });
      return { id, mfaEnabled: false };
    });
  }

  // ───────────── roles ─────────────
  async assign(actorId: string, id: string, i: z.infer<typeof S.AssignRole>) {
    return this.tdb.tx(async (trx) => {
      await this.user(trx, id, true);
      if (actorId === id) throw fail(403, 'SELF_ACTION', 'You cannot change your own roles. Ask another administrator.');
      const r = await this.assignIn(trx, actorId, id, i);
      await this.sessions.revokeAllForUser(trx, id);                    // sign in again to pick up the new access
      return r;
    });
  }
  /** Several roles at once, at one place: all of them or none. Roles the person already has there are left alone and reported. A role the actor may not hand out refuses the whole set, naming it. */
  async assignMany(actorId: string, id: string, i: z.infer<typeof S.AssignRoles>) {
    return this.tdb.tx(async (trx) => {
      await this.user(trx, id, true);
      if (actorId === id) throw fail(403, 'SELF_ACTION', 'You cannot change your own roles. Ask another administrator.');
      const given: Array<{ roleKey: string; role: string }> = []; const already: string[] = [];
      for (const roleKey of [...new Set(i.roleKeys)]) {
        try { const r = await this.assignIn(trx, actorId, id, { roleKey, scopeType: i.scopeType, scopeId: i.scopeId, validTo: i.validTo, limits: i.limits }); given.push({ roleKey, role: r.role }); }
        catch (e) {
          const c = (e as { response?: { code?: string } }).response?.code;
          if (c === 'ALREADY_ASSIGNED') { already.push(roleKey); continue; }
          if (c === 'INSUFFICIENT_AUTHORITY') throw fail(403, 'INSUFFICIENT_AUTHORITY', `You cannot give the role "${roleKey}": it holds permissions you do not hold yourself. Nothing was changed.`, { roleKey });
          throw e;
        }
      }
      if (given.length) await this.sessions.revokeAllForUser(trx, id);
      return { given, already };
    });
  }
  private async assignIn(trx: Trx, actorId: string, id: string, i: z.infer<typeof S.AssignRole>) {
      const role = await trx.selectFrom('role').select(['id', 'key', 'name']).where('key', '=', i.roleKey).executeTakeFirst();
      if (!role) throw fail(404, 'NOT_FOUND', 'Role not found');
      if (i.scopeType === 'PROPERTY' && !(await trx.selectFrom('property').select('id').where('id', '=', i.scopeId!).executeTakeFirst())) throw fail(404, 'NOT_FOUND', 'Property not found');
      const perms = (await trx.selectFrom('role_permission').select('permission_key').where('role_id', '=', role.id).execute()).map((p) => p.permission_key);
      if (!(await this.mayAssign(actorId, perms, i.scopeType, i.scopeId ?? null, i.limits))) throw fail(403, 'INSUFFICIENT_AUTHORITY', 'You can only give roles made of permissions you hold yourself, at places and limits within your own');
      const dup = await trx.selectFrom('role_assignment').select('id').where('user_id', '=', id).where('role_id', '=', role.id).where('scope_type', '=', i.scopeType).where((eb) => i.scopeId ? eb('scope_id', '=', i.scopeId) : eb('scope_id', 'is', null))
        .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', new Date(this.clock.now()))])).executeTakeFirst();
      if (dup) throw fail(409, 'ALREADY_ASSIGNED', 'This person already has that role there');
      const a = await trx.insertInto('role_assignment').values({ tenant_id: currentTenant().tenantId, user_id: id, role_id: role.id, scope_type: i.scopeType, scope_id: i.scopeId ?? null, limits: JSON.stringify(i.limits), valid_to: i.validTo ? new Date(i.validTo) : null } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'staff.role_assign', resourceType: 'staff_user', resourceId: id, after: { role: role.key, scopeType: i.scopeType, scopeId: i.scopeId ?? null, validTo: i.validTo ?? null, limits: i.limits } });
      return { id: a.id, roleKey: role.key, role: role.name, scopeType: i.scopeType, scopeId: i.scopeId ?? null };
  }
  async revoke(actorId: string, id: string, assignmentId: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      await this.user(trx, id, true);
      if (actorId === id) throw fail(403, 'SELF_ACTION', 'You cannot change your own roles. Ask another administrator.');
      const r = await this.revokeIn(trx, actorId, id, assignmentId, reason);
      await this.sessions.revokeAllForUser(trx, id);
      return r;
    });
  }
  /** Ends several of a person's roles at once, all or none. */
  async revokeMany(actorId: string, id: string, i: z.infer<typeof S.RevokeRoles>) {
    return this.tdb.tx(async (trx) => {
      await this.user(trx, id, true);
      if (actorId === id) throw fail(403, 'SELF_ACTION', 'You cannot change your own roles. Ask another administrator.');
      for (const a of [...new Set(i.assignmentIds)]) await this.revokeIn(trx, actorId, id, a, i.reason);
      await this.sessions.revokeAllForUser(trx, id);
      return { ended: i.assignmentIds.length };
    });
  }
  private async revokeIn(trx: Trx, actorId: string, id: string, assignmentId: string, reason: string) {
      const a = await sql<{ scope_type: 'TENANT' | 'PROPERTY' | 'LEGAL_ENTITY' | 'DEPARTMENT'; scope_id: string | null; limits: object; key: string; perms: string[] }>`
        SELECT ra.scope_type, ra.scope_id, ra.limits, r.key, array_agg(rp.permission_key) AS perms FROM role_assignment ra JOIN role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id JOIN role_permission rp ON rp.tenant_id = ra.tenant_id AND rp.role_id = ra.role_id
        WHERE ra.tenant_id = ${currentTenant().tenantId} AND ra.id = ${assignmentId} AND ra.user_id = ${id} AND (ra.valid_to IS NULL OR ra.valid_to > now()) GROUP BY ra.id, ra.scope_type, ra.scope_id, ra.limits, r.key`.execute(trx);
      const row = a.rows[0];
      if (!row) throw fail(404, 'NOT_FOUND', 'That role assignment was not found or has already ended');
      if (!(await this.mayAssign(actorId, row.perms, row.scope_type, row.scope_id, row.limits))) throw fail(403, 'INSUFFICIENT_AUTHORITY', 'This role carries more authority than you hold');
      if (row.perms.includes('tenant.manage') && row.scope_type === 'TENANT') await this.assertNotLastOwner(trx, id, assignmentId);
      await trx.updateTable('role_assignment').set({ valid_to: new Date(this.clock.now()) } as never).where('id', '=', assignmentId).execute();
      await this.audit.record(trx, { action: 'staff.role_revoke', resourceType: 'staff_user', resourceId: id, before: { role: row.key, scopeType: row.scope_type, scopeId: row.scope_id }, note: reason });
      return { id: assignmentId, ended: true };
  }

  // ───────────── the audit trail, readable ─────────────
  async auditTrail(q: z.infer<typeof S.AuditQuery>) {
    return this.tdb.tx(async (trx) => {
      let qb = trx.selectFrom('audit_log as a').leftJoin('staff_user as u', (j) => j.onRef('u.id', '=', 'a.actor_id').onRef('u.tenant_id', '=', 'a.tenant_id')).leftJoin('property as p', (j) => j.onRef('p.id', '=', 'a.property_id').onRef('p.tenant_id', '=', 'a.tenant_id'))
        .select(['a.id', 'a.occurred_at', 'a.actor_type', 'a.actor_id', 'u.full_name as actor', 'a.action', 'a.resource_type', 'a.resource_id', 'a.property_id', 'p.name as property', 'a.reason_code', 'a.note'])
        .orderBy('a.occurred_at', 'desc').orderBy('a.id').limit(q.limit);
      if (q.action) qb = qb.where('a.action', 'like', `${q.action.replace(/[%_\\]/g, '')}%`);
      if (q.before) qb = qb.where('a.occurred_at', '<', new Date(q.before));
      return { items: (await qb.execute()).map((r) => ({ id: r.id, at: r.occurred_at, actorType: r.actor_type, actorId: r.actor_id, actor: r.actor, action: r.action, resourceType: r.resource_type, resourceId: r.resource_id, property: r.property, reasonCode: r.reason_code, note: r.note })) };
    });
  }
}
void ConflictException; void ForbiddenException;
