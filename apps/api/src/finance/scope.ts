import { HttpException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuthorizationService } from '../authz/authorization.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';

export type Scope = { all: true } | { all: false; ids: string[] };

/** Which branches the signed-in person may see or act on for a finance permission. A company-wide role sees everything; a branch role sees only its branches, never head office. */
@Injectable()
export class FinanceScope {
  constructor(@Inject(AuthorizationService) private readonly authz: AuthorizationService) {}

  of(permission: string): Promise<Scope> { return this.authz.allowedBranches(currentTenant().actorId!, permission); }
  allows(scope: Scope, branch: string | null): boolean { return scope.all || (branch !== null && scope.ids.includes(branch)); }

  /** Refuses unless every one of these branches (null is head office) is covered. */
  async assert(permission: string, branches: Array<string | null>): Promise<void> {
    const s = await this.of(permission); if (s.all) return;
    if (branches.some((b) => !this.allows(s, b))) throw new HttpException({ code: 'BRANCH_NOT_ALLOWED', message: 'You do not have this permission for one of the branches involved, or for head office.' }, 403);
  }
  async requireAll(permission: string, what: string): Promise<void> {
    if (!(await this.of(permission)).all) throw new HttpException({ code: 'COMPANY_WIDE_ONLY', message: `${what} needs a company-wide role.` }, 403);
  }
  /** `AND col IN (…)` for a branch-limited person, nothing for a company-wide one. */
  filter(scope: Scope, col: string) { return scope.all ? sql`` : scope.ids.length ? sql`AND ${sql.raw(col)} IN (${sql.join(scope.ids.map((i) => sql`${i}::uuid`))})` : sql`AND false`; }
}
