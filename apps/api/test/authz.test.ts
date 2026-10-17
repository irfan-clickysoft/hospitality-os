import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { AUTHENTICATED_ONLY, PUBLIC_ROUTE, REQUIRE_PERMISSION } from '../src/authz/decorators.js';
import { addUser, as, assignRole, createTestApp, provision } from './harness.js';

let app: NestFastifyApplication;
let A: Awaited<ReturnType<typeof provision>>, B: Awaited<ReturnType<typeof provision>>;
const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

beforeAll(async () => { app = await createTestApp(); A = await provision(app, 'alpha'); B = await provision(app, 'bravo'); });
afterAll(async () => { await app.close(); });

describe('authentication & deny-by-default', () => {
  it('health is public', async () => { expect((await get('/healthz')).statusCode).toBe(200); });

  it('protected routes answer 401 problem+json without a principal', async () => {
    const r = await get(`/v1/properties/${A.propertyIds[0]}`);
    expect(r.statusCode).toBe(401);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(r.json().code).toBe('UNAUTHENTICATED');
  });

  it('a route with no permission metadata is refused even for the tenant owner', async () => {
    const r = await get('/test-unprotected', as(A.tenantId, A.ownerUserId));
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('ROUTE_NOT_PROTECTED');
  });

  it('contract: every real controller route declares a permission or is explicitly public', () => {
    const discovery = app.get(DiscoveryService), scanner = app.get(MetadataScanner), reflector = app.get(Reflector);
    const offenders: string[] = [];
    for (const w of discovery.getControllers()) {
      if (!w.instance || w.metatype?.name === 'UnprotectedController') continue;
      const proto = Object.getPrototypeOf(w.instance);
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = proto[name];
        if (!Reflect.getMetadata('path', handler) && Reflect.getMetadata('method', handler) === undefined) continue; // not a route
        const targets = [handler, w.metatype!];
        const ok = reflector.getAllAndOverride(PUBLIC_ROUTE, targets) || reflector.getAllAndOverride(AUTHENTICATED_ONLY, targets) || reflector.getAllAndOverride(REQUIRE_PERMISSION, targets);
        if (!ok) offenders.push(`${w.metatype?.name}.${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('echoes or generates a correlation id', async () => {
    const r1 = await get('/healthz', { 'x-correlation-id': 'req-abcdef123456' });
    expect(r1.headers['x-correlation-id']).toBe('req-abcdef123456');
    const r2 = await get('/healthz', { 'x-correlation-id': 'bad id with spaces!' });
    expect(r2.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('tenant isolation over HTTP', () => {
  it('owner reads their own property', async () => {
    const r = await get(`/v1/properties/${A.propertyIds[0]}`, as(A.tenantId, A.ownerUserId));
    expect(r.statusCode).toBe(200);
    expect(r.json().code).toBe('P1');
  });
  it("owner of tenant A gets 404 (not 403) for tenant B's property id", async () => {
    const r = await get(`/v1/properties/${B.propertyIds[0]}`, as(A.tenantId, A.ownerUserId));
    expect(r.statusCode).toBe(404);
  });
  it("a user id from tenant B presented under tenant A's context has no grants", async () => {
    const r = await get(`/v1/properties/${A.propertyIds[0]}`, as(A.tenantId, B.ownerUserId));
    expect(r.statusCode).toBe(403);
  });
  it('malformed ids are a 400, not a 500', async () => {
    const r = await get('/v1/properties/not-a-uuid', as(A.tenantId, A.ownerUserId));
    expect(r.statusCode).toBe(400);
  });
});

describe('scoped RBAC', () => {
  it('property-scoped front desk reads their property only', async () => {
    const u = await addUser(A.tenantId, 'fd@alpha.test');
    await assignRole(A.tenantId, u, 'front_desk_agent', 'PROPERTY', A.propertyIds[0]);
    expect((await get(`/v1/properties/${A.propertyIds[0]}`, as(A.tenantId, u))).statusCode).toBe(200);
    const other = await get(`/v1/properties/${A.propertyIds[1]}`, as(A.tenantId, u));
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('PERMISSION_DENIED');
  });
  it('a user with no role assignment is denied', async () => {
    const u = await addUser(A.tenantId, 'nobody@alpha.test');
    expect((await get(`/v1/properties/${A.propertyIds[0]}`, as(A.tenantId, u))).statusCode).toBe(403);
  });
  it('an expired assignment is denied', async () => {
    const u = await addUser(A.tenantId, 'expired@alpha.test');
    await assignRole(A.tenantId, u, 'general_manager', 'TENANT', null, { validTo: new Date(Date.now() - 60_000) });
    expect((await get(`/v1/properties/${A.propertyIds[0]}`, as(A.tenantId, u))).statusCode).toBe(403);
  });
});
