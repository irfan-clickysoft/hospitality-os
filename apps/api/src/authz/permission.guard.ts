import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SENSITIVE_PERMISSIONS } from '@hos/auth';
import { loadIdentityConfig } from '../identity/identity.config.js';
import { safeEqual } from '../identity/tokens.js';
import { tryCurrentTenant } from '../tenancy/tenant-context.js';
import { AuthorizationService } from './authorization.service.js';
import { ALLOW_PENDING_MFA, AUTHENTICATED_ONLY, PUBLIC_ROUTE, REQUIRE_PERMISSION, type RequirePermissionMeta } from './decorators.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard. Order: Origin check (unsafe methods) → public? → session state → CSRF → permission metadata (deny by default)
 * → sensitive-permission step-up → scoped permission decision.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly cfg = loadIdentityConfig();
  constructor(@Inject(Reflector) private readonly reflector: Reflector, @Inject(AuthorizationService) private readonly authz: AuthorizationService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const unsafe = !SAFE.has(String(req.method).toUpperCase());
    const origin = req.headers?.origin as string | undefined;
    if (unsafe && origin && this.cfg.allowedOrigins.length > 0 && !this.cfg.allowedOrigins.includes(origin)) {
      throw new ForbiddenException({ code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin is not allowed' });
    }

    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true;

    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY, targets);
    const meta = this.reflector.getAllAndOverride<RequirePermissionMeta | undefined>(REQUIRE_PERMISSION, targets);
    if (!meta && !authenticatedOnly) throw new ForbiddenException({ code: 'ROUTE_NOT_PROTECTED', message: 'Route declares no permission (deny by default)' });

    const tenant = tryCurrentTenant();
    if (!tenant?.actorId) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Authentication required' });

    if (tenant.sessionState === 'PENDING_MFA' && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_MFA, targets)) {
      throw new UnauthorizedException({ code: 'MFA_PENDING', message: 'Second factor required to continue' });
    }
    if (unsafe && tenant.csrfToken && !safeEqual(String(req.headers?.['x-csrf-token'] ?? ''), tenant.csrfToken)) {
      throw new ForbiddenException({ code: 'CSRF_INVALID', message: 'Missing or invalid CSRF token' });
    }
    if (!meta) return true; // authenticated-only route

    if (SENSITIVE_PERMISSIONS.has(meta.permission)) {
      const fresh = tenant.mfaVerifiedAt && Date.now() - tenant.mfaVerifiedAt.getTime() <= this.cfg.stepUpMinutes * 60_000;
      if (!fresh) throw new ForbiddenException({ code: 'MFA_REQUIRED', message: 'Verify your second factor (step-up) to perform this action' });
    }

    const decision = await this.authz.check(tenant.actorId, { permission: meta.permission, scope: meta.scope?.(req) });
    if (decision.effect === 'ALLOW') return true;
    if (decision.effect === 'APPROVAL_REQUIRED') throw new ForbiddenException({ code: 'APPROVAL_REQUIRED', message: decision.reason });
    throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You do not have permission to perform this action' });
  }
}
