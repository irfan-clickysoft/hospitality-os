import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext { tenantId: string; actorId?: string; requestId?: string; ip?: string; userAgent?: string }

const storage = new AsyncLocalStorage<TenantContext>();

/** Establishes the tenant for the current async scope. Called ONLY by the authentication layer, never from client input. */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T { return storage.run(ctx, fn); }

export function currentTenant(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('No tenant context: tenant-scoped data access outside an authenticated request');
  return ctx;
}

export function tryCurrentTenant(): TenantContext | undefined { return storage.getStore(); }
