import type { IncomingMessage } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal, PrincipalResolver } from '../tenancy/principal.js';
import { loadIdentityConfig } from './identity.config.js';
import { SessionService } from './session.service.js';

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

@Injectable()
export class SessionPrincipalResolver implements PrincipalResolver {
  private readonly cfg = loadIdentityConfig();
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  async resolve(req: IncomingMessage): Promise<Principal | null> {
    const s = await this.sessions.validate(readCookie(req.headers.cookie, this.cfg.cookieName));
    if (!s) return null;
    return { tenantId: s.tenantId, userId: s.userId, sessionId: s.sessionId, sessionState: s.state, mfaVerifiedAt: s.mfaVerifiedAt, csrfToken: s.csrfToken };
  }
}
