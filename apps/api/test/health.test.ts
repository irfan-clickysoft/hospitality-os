import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

process.env.DATABASE_URL_APP ??= 'postgres://hos_app:dev@localhost:5432/hos_test';

import { AppModule } from '../src/app.module.js';
import { runWithTenant, currentTenant } from '../src/tenancy/tenant-context.js';

let app: NestFastifyApplication;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => { await app.close(); });

describe('health', () => {
  it('GET /healthz', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok' });
  });
  it('GET /readyz checks the database', async () => {
    const r = await app.inject({ method: 'GET', url: '/readyz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ready', db: 'ok' });
  });
});

describe('tenant context', () => {
  it('is unavailable outside an authenticated scope', () => {
    expect(() => currentTenant()).toThrow(/No tenant context/);
  });
  it('is isolated per async scope', async () => {
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => runWithTenant({ tenantId: 'A' }, async () => { await new Promise((r) => setTimeout(r, 5)); return currentTenant().tenantId; })),
      Promise.resolve().then(() => runWithTenant({ tenantId: 'B' }, async () => currentTenant().tenantId)),
    ]);
    expect([a, b]).toEqual(['A', 'B']);
  });
});
