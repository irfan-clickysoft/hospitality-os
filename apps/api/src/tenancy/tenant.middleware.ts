import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PRINCIPAL_RESOLVER, type PrincipalResolver } from './principal.js';
import { runWithTenant } from './tenant-context.js';

const CORRELATION = /^[A-Za-z0-9_-]{8,64}$/;

/** Resolves the principal, assigns a correlation id, and pins the tenant for the rest of the request's async scope. */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(@Inject(PRINCIPAL_RESOLVER) private readonly resolver: PrincipalResolver) {}

  async use(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): Promise<void> {
    const incoming = req.headers['x-correlation-id'];
    const requestId = typeof incoming === 'string' && CORRELATION.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-correlation-id', requestId);
    let principal;
    try { principal = await this.resolver.resolve(req); } catch (e) { return next(e); }
    if (!principal) { runWithTenantless(req, requestId); return next(); }
    runWithTenant({
      tenantId: principal.tenantId, actorId: principal.userId, requestId,
      sessionId: principal.sessionId, sessionState: principal.sessionState, mfaVerifiedAt: principal.mfaVerifiedAt, csrfToken: principal.csrfToken,
      ip: req.socket.remoteAddress, userAgent: req.headers['user-agent'],
    }, () => next());
  }
}

function runWithTenantless(req: IncomingMessage, requestId: string): void {
  (req as IncomingMessage & { requestId?: string }).requestId = requestId;
}
