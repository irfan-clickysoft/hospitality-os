import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addUser, as, assignRole, createTestApp, provision } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
const call = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers });

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'lent'); });
afterAll(async () => { await app.close(); });

describe('legal entities (the companies that can own a property)', () => {
  it('the owner can list them, so a new property can be given an owner company', async () => {
    const r = await call('/v1/property-owners', as(T.tenantId, T.ownerUserId));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().items.some((x: any) => x.id === T.legalEntityId && typeof x.name === 'string')).toBe(true);
  });
  it('a property-level front-desk user cannot (only someone who can manage properties for the whole business)', async () => {
    const pid = (await app.inject({ method: 'POST', url: '/v1/properties', headers: as(T.tenantId, T.ownerUserId), payload: { legalEntityId: T.legalEntityId, code: 'LE1', name: 'Legal entity test' } })).json().id as string;
    const fd = await addUser(T.tenantId, 'fd@lent.test'); await assignRole(T.tenantId, fd, 'front_desk_agent', 'PROPERTY', pid);
    const r = await call('/v1/property-owners', as(T.tenantId, fd));
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('PERMISSION_DENIED');
  });
  it('is refused without a sign-in', async () => {
    const r = await call('/v1/property-owners', {});
    expect(r.statusCode).toBe(401);
  });
});
