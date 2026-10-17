import { SetMetadata } from '@nestjs/common';
import type { ResourceScope } from '@hos/auth';

export const REQUIRE_PERMISSION = 'hos:require-permission';
export const PUBLIC_ROUTE = 'hos:public-route';

export interface RequirePermissionMeta {
  permission: string;
  /** Extracts the resource scope from the request (path params only; resolved/verified against the database by the guard). */
  scope?: (req: any) => ResourceScope;
}

/** Every non-public route MUST declare one; routes without metadata are rejected (deny by default). */
export const RequirePermission = (permission: string, opts: { scope?: (req: any) => ResourceScope } = {}) =>
  SetMetadata(REQUIRE_PERMISSION, { permission, ...opts } satisfies RequirePermissionMeta);

/** Explicitly unauthenticated route (health checks, login). Each use is reviewed. */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
