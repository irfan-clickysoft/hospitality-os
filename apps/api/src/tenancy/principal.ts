import type { IncomingMessage } from 'node:http';

export interface Principal { tenantId: string; userId: string }

/**
 * Resolves the authenticated principal from a request (session cookie / bearer token). The real implementation arrives with the
 * identity slice; until then the default resolves nobody, so every protected route answers 401.
 */
export interface PrincipalResolver { resolve(req: IncomingMessage): Promise<Principal | null> }
export const PRINCIPAL_RESOLVER = Symbol('PRINCIPAL_RESOLVER');

export class NullPrincipalResolver implements PrincipalResolver {
  async resolve(): Promise<Principal | null> { return null; }
}
