import { SetMetadata } from '@nestjs/common';
import type { ResourceScope } from '@hos/auth';

export const REQUIRE_PERMISSION = 'hos:require-permission';
export const PUBLIC_ROUTE = 'hos:public-route';
export const AUTHENTICATED_ONLY = 'hos:authenticated-only';
export const ALLOW_PENDING_MFA = 'hos:allow-pending-mfa';

export interface RequirePermissionMeta {
  permission: string;
  /** Extracts the resource scope from the request (path params only; resolved/verified against the database by the guard). */
  scope?: (req: any) => ResourceScope;
  /** Tenant-wide data: allow a user who holds the permission at any scope (e.g. a property-scoped front-desk agent reading guest profiles). */
  anyScope?: boolean;
}

/** Every non-public route MUST declare one; routes without metadata are rejected (deny by default). */
export const RequirePermission = (permission: string, opts: { scope?: (req: any) => ResourceScope; anyScope?: boolean } = {}) =>
  SetMetadata(REQUIRE_PERMISSION, { permission, ...opts } satisfies RequirePermissionMeta);

/** Explicitly unauthenticated route (health checks, login). Each use is reviewed. */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

/** Any authenticated user (no specific permission): own-profile / session management endpoints. */
export const Authenticated = () => SetMetadata(AUTHENTICATED_ONLY, true);

/** Reachable while the session is still waiting for its second factor (MFA verify, logout). */
export const AllowPendingMfa = () => SetMetadata(ALLOW_PENDING_MFA, true);
