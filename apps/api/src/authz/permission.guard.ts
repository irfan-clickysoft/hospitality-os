import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthorizationService } from './authorization.service.js';
import { PUBLIC_ROUTE, REQUIRE_PERMISSION, type RequirePermissionMeta } from './decorators.js';
import { tryCurrentTenant } from '../tenancy/tenant-context.js';

/** Global guard: authentication required unless @Public; permission metadata required (deny by default). */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector, @Inject(AuthorizationService) private readonly authz: AuthorizationService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true;

    const meta = this.reflector.getAllAndOverride<RequirePermissionMeta | undefined>(REQUIRE_PERMISSION, targets);
    if (!meta) throw new ForbiddenException({ code: 'ROUTE_NOT_PROTECTED', message: 'Route declares no permission (deny by default)' });

    const tenant = tryCurrentTenant();
    if (!tenant?.actorId) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Authentication required' });

    const req = ctx.switchToHttp().getRequest();
    const decision = await this.authz.check(tenant.actorId, { permission: meta.permission, scope: meta.scope?.(req) });
    if (decision.effect === 'ALLOW') return true;
    if (decision.effect === 'APPROVAL_REQUIRED') throw new ForbiddenException({ code: 'APPROVAL_REQUIRED', message: decision.reason });
    throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You do not have permission to perform this action' });
  }
}
