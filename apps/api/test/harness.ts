import 'reflect-metadata';
import type { IncomingMessage } from 'node:http';
import { Controller, Get } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Kysely } from 'kysely';
import { createDb, type DB } from '@hos/db';
import { AppModule } from '../src/app.module.js';
import { DB_ADMIN } from '../src/db/db.module.js';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import { PRINCIPAL_RESOLVER, type PrincipalResolver } from '../src/tenancy/principal.js';
import { URLS } from './env.js';

/** TEST-ONLY principal resolver: trusts headers. Production uses the identity module; this never ships. */
class HeaderPrincipalResolver implements PrincipalResolver {
  async resolve(req: IncomingMessage) {
    const t = req.headers['x-test-tenant'], u = req.headers['x-test-user'];
    if (typeof t !== 'string' || typeof u !== 'string') return null;
    // x-test-mfa: 1 simulates a session whose second factor was verified just now (for sensitive-permission tests).
    return { tenantId: t, userId: u, sessionState: 'ACTIVE' as const, mfaVerifiedAt: req.headers['x-test-mfa'] === '1' ? new Date() : null };
  }
}

/** A route that forgot its permission metadata: the guard must refuse it. */
@Controller('test-unprotected')
export class UnprotectedController { @Get() get() { return { leaked: true }; } }

/** `realAuth: true` exercises the real session/cookie resolver; default uses a header-based stand-in for authorization-only tests. */
export async function createTestApp(opts: { realAuth?: boolean } = {}): Promise<NestFastifyApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule, DiscoveryModule], controllers: [UnprotectedController] });
  if (!opts.realAuth) builder = builder.overrideProvider(PRINCIPAL_RESOLVER).useClass(HeaderPrincipalResolver);
  const mod = await builder.compile();
  const app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

export const adminDb: Kysely<DB> = createDb(URLS.admin, 4);
export const appDb: Kysely<DB> = createDb(URLS.app, 4);

export async function provision(app: NestFastifyApplication, slug: string) {
  const prov = app.get(ProvisioningService);
  const t = await prov.createTenant({ name: slug, slug, ownerEmail: `owner@${slug}.test`, ownerName: `${slug} owner` });
  const props = [];
  for (const code of ['P1', 'P2']) {
    props.push((await adminDb.insertInto('property').values({
      tenant_id: t.tenantId, legal_entity_id: t.legalEntityId, code, name: `${slug} ${code}`, business_date: '2026-10-20', brand_id: null,
    }).returning('id').executeTakeFirstOrThrow()).id);
  }
  return { ...t, propertyIds: props as [string, string] };
}

export async function addUser(tenantId: string, email: string) {
  return (await adminDb.insertInto('staff_user').values({ tenant_id: tenantId, email, full_name: email, password_hash: null }).returning('id').executeTakeFirstOrThrow()).id;
}

export async function assignRole(tenantId: string, userId: string, roleKey: string, scopeType: 'TENANT' | 'PROPERTY', scopeId: string | null, extra: { validTo?: Date; limits?: object } = {}) {
  const role = await adminDb.selectFrom('role').select('id').where('tenant_id', '=', tenantId).where('key', '=', roleKey).executeTakeFirstOrThrow();
  await adminDb.insertInto('role_assignment').values({
    tenant_id: tenantId, user_id: userId, role_id: role.id, scope_type: scopeType, scope_id: scopeId,
    valid_to: extra.validTo ?? null, limits: JSON.stringify(extra.limits ?? {}),
  }).execute();
}

export const as = (tenantId: string, userId: string, o: { mfa?: boolean } = {}) => ({ 'x-test-tenant': tenantId, 'x-test-user': userId, ...(o.mfa ? { 'x-test-mfa': '1' } : {}) });
