import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { canAssignRole, decide, holdsAnywhere, type AuthzRequest, type Decision, type Grant, type Limits, type ResourceScope, type RoleAssignmentRequest } from '@hos/auth';
import { TenantDb } from '../db/tenant-db.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthorizationService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb) {}

  /** All grants (permission × scope × limits) currently held by a user. */
  async loadGrants(userId: string): Promise<Grant[]> {
    const rows = await this.tdb.tx((trx) =>
      trx.selectFrom('role_assignment as ra')
        .innerJoin('role_permission as rp', (j) => j.onRef('rp.tenant_id', '=', 'ra.tenant_id').onRef('rp.role_id', '=', 'ra.role_id'))
        .select(['rp.permission_key', 'ra.scope_type', 'ra.scope_id', 'ra.limits', 'ra.valid_from', 'ra.valid_to'])
        .where('ra.user_id', '=', userId)
        .execute());
    return rows.map((r) => ({
      permission: r.permission_key, scopeType: r.scope_type, scopeId: r.scope_id,
      limits: (r.limits ?? {}) as Limits, validFrom: new Date(r.valid_from), validTo: r.valid_to ? new Date(r.valid_to) : null,
    }));
  }

  /** Resolves the full scope chain from the database (RLS-bound). Unknown or foreign ids look identical: 404. */
  async resolveScope(scope: ResourceScope | undefined): Promise<ResourceScope | undefined> {
    if (!scope?.propertyId) return scope;
    if (!UUID.test(scope.propertyId)) throw new BadRequestException({ code: 'INVALID_ID', message: 'Invalid property id' });
    const row = await this.tdb.tx((trx) =>
      trx.selectFrom('property').select(['id', 'legal_entity_id']).where('id', '=', scope.propertyId!).executeTakeFirst());
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Resource not found' });
    return { ...scope, propertyId: row.id, legalEntityId: row.legal_entity_id };
  }

  /**
   * The branches a user may use a permission on: every branch (a company-wide grant), or just the listed ones (grants for a branch, or for a legal entity, which covers its branches).
   * Head office (entries with no branch) needs the company-wide grant.
   */
  async allowedBranches(userId: string, permission: string): Promise<{ all: true } | { all: false; ids: string[] }> {
    const grants = (await this.loadGrants(userId)).filter((g) => g.permission === permission && g.validFrom <= new Date() && (g.validTo === null || new Date() < g.validTo));
    if (grants.some((g) => g.scopeType === 'TENANT')) return { all: true };
    const ids = new Set<string>(grants.filter((g) => g.scopeType === 'PROPERTY' && g.scopeId).map((g) => g.scopeId!));
    const les = grants.filter((g) => g.scopeType === 'LEGAL_ENTITY' && g.scopeId).map((g) => g.scopeId!);
    if (les.length) for (const r of await this.tdb.tx((trx) => trx.selectFrom('property').select('id').where('legal_entity_id', 'in', les).execute())) ids.add(r.id);
    return { all: false, ids: [...ids] };
  }

  async holdsAnywhere(userId: string, permission: string): Promise<boolean> {
    return holdsAnywhere(await this.loadGrants(userId), permission);
  }

  async check(userId: string, req: AuthzRequest): Promise<Decision> {
    const [grants, scope] = await Promise.all([this.loadGrants(userId), this.resolveScope(req.scope)]);
    return decide(grants, { ...req, scope });
  }

  async checkAssignRole(actorId: string, req: RoleAssignmentRequest): Promise<Decision> {
    return canAssignRole(await this.loadGrants(actorId), req);
  }
}
