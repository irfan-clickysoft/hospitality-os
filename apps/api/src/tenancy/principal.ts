import type { IncomingMessage } from 'node:http';

export interface Principal {
  tenantId: string;
  userId: string;
  sessionId?: string;
  sessionState?: 'PENDING_MFA' | 'ACTIVE';
  mfaVerifiedAt?: Date | null;
  /** Present for cookie sessions: unsafe requests must echo it in X-CSRF-Token. */
  csrfToken?: string;
}

/** Resolves the authenticated principal from a request (session cookie). */
export interface PrincipalResolver { resolve(req: IncomingMessage): Promise<Principal | null> }
export const PRINCIPAL_RESOLVER = Symbol('PRINCIPAL_RESOLVER');

export class NullPrincipalResolver implements PrincipalResolver {
  async resolve(): Promise<Principal | null> { return null; }
}
