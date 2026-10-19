import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'kysely';
import { ROLE_TEMPLATES } from '@hos/auth';
import { withTenant } from '@hos/db';
import { AuditService } from '../src/audit/audit.service.js';
import { redact } from '../src/audit/redact.js';
import { IdempotencyService, hashRequest } from '../src/idempotency/idempotency.service.js';
import { InboxService } from '../src/outbox/inbox.service.js';
import { OutboxRelay, type EventDispatcher, type OutboxRecord } from '../src/outbox/outbox.relay.js';
import { OutboxService } from '../src/outbox/outbox.service.js';
import { ProvisioningService } from '../src/provisioning/provisioning.service.js';
import { runWithTenant } from '../src/tenancy/tenant-context.js';
import { adminDb, appDb, createTestApp, provision } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'svc'); });
afterAll(async () => { await app.close(); });

const inTenant = <R>(fn: () => Promise<R>) => runWithTenant({ tenantId: T.tenantId, actorId: T.ownerUserId, requestId: 'req-test-0001' }, fn);

describe('provisioning', () => {
  it('seeds every system role with valid permissions, and the owner holds a tenant-wide grant', async () => {
    const roles = await withTenant(appDb, T.tenantId, (trx) => trx.selectFrom('role').select(['key']).execute());
    expect(roles.map((r) => r.key).sort()).toEqual(ROLE_TEMPLATES.map((r) => r.key).sort());
    const grants = await withTenant(appDb, T.tenantId, (trx) =>
      trx.selectFrom('role_assignment').select(['scope_type', 'user_id']).where('user_id', '=', T.ownerUserId).execute());
    expect(grants).toEqual([{ scope_type: 'TENANT', user_id: T.ownerUserId }]);
  });
  it('writes an audit row and a TenantCreated outbox event', async () => {
    const a = await adminDb.selectFrom('audit_log').select('action').where('tenant_id', '=', T.tenantId).execute();
    expect(a.map((x) => x.action)).toContain('tenant.create');
    const o = await adminDb.selectFrom('outbox_event').select('event_type').where('tenant_id', '=', T.tenantId).execute();
    expect(o.map((x) => x.event_type)).toContain('TenantCreated');
  });
  it('cannot create the same slug twice', async () => {
    await expect(app.get(ProvisioningService).createTenant({ name: 'dup', slug: 'svc', ownerEmail: 'x@y.test', ownerName: 'X' })).rejects.toThrow(/duplicate|unique/i);
  });
});

describe('audit', () => {
  it('commits with the change, and rolls back with it', async () => {
    const audit = app.get(AuditService);
    await inTenant(() => withTenant(appDb, T.tenantId, async (trx) => audit.record(trx, { action: 'test.commit', resourceType: 'x', resourceId: '1' })));
    await expect(inTenant(() => withTenant(appDb, T.tenantId, async (trx) => {
      await audit.record(trx, { action: 'test.rollback', resourceType: 'x' });
      throw new Error('boom');
    }))).rejects.toThrow('boom');
    const acts = (await adminDb.selectFrom('audit_log').select('action').where('tenant_id', '=', T.tenantId).execute()).map((r) => r.action);
    expect(acts).toContain('test.commit');
    expect(acts).not.toContain('test.rollback');
  });
  it('stamps actor and request id, and redacts sensitive fields', async () => {
    const audit = app.get(AuditService);
    await inTenant(() => withTenant(appDb, T.tenantId, (trx) => audit.record(trx, {
      action: 'guest.update', resourceType: 'guest', before: { name: 'A', cnic: '42101-1234567-1' }, after: { name: 'B', cnic: '42101-7654321-1', password_hash: 'x' } })));
    const row = await adminDb.selectFrom('audit_log').selectAll().where('tenant_id', '=', T.tenantId).where('action', '=', 'guest.update').executeTakeFirstOrThrow();
    expect(row.actor_id).toBe(T.ownerUserId);
    expect(row.request_id).toBe('req-test-0001');
    expect(JSON.stringify(row.before)).not.toContain('4210');
    expect(JSON.stringify(row.after)).toContain('[REDACTED]');
  });
  it('redact handles nesting, arrays, dates and bigint', () => {
    expect(redact({ a: [{ token: 't', ok: 1n }], d: new Date('2026-01-01T00:00:00Z') })).toEqual({ a: [{ token: '[REDACTED]', ok: '1' }], d: '2026-01-01T00:00:00.000Z' });
  });
});

class Collect implements EventDispatcher {
  seen: OutboxRecord[] = []; failFor = new Set<string>();
  async dispatch(e: OutboxRecord) { if (this.failFor.has(e.aggregateId)) throw new Error('down'); this.seen.push(e); }
}
const clearOutbox = () => sql`DELETE FROM outbox_event`.execute(adminDb);

describe('outbox relay', () => {
  it('publishes events committed with the state change, only once, and never events that rolled back', async () => {
    await clearOutbox();
    const ob = app.get(OutboxService);
    await inTenant(() => withTenant(appDb, T.tenantId, (trx) => ob.publish(trx, { aggregateType: 'reservation', aggregateId: 'r1', eventType: 'ReservationCreated', businessDate: '2026-10-20', payload: { n: 1 } })));
    await expect(inTenant(() => withTenant(appDb, T.tenantId, async (trx) => {
      await ob.publish(trx, { aggregateType: 'reservation', aggregateId: 'r2', eventType: 'ReservationCreated', payload: {} });
      throw new Error('rollback');
    }))).rejects.toThrow();
    const d = new Collect(); const relay = new OutboxRelay(adminDb, d);
    expect(await relay.drainOnce()).toEqual({ dispatched: 1, failed: 0, deadLettered: 0 });
    expect(d.seen.map((e) => e.aggregateId)).toEqual(['r1']);
    expect(d.seen[0]!.businessDate).toBe('2026-10-20');
    expect((await relay.drainOnce()).dispatched).toBe(0);
  });
  it('retries failures, preserves per-aggregate order, and dead-letters after max attempts', async () => {
    await clearOutbox();
    const ob = app.get(OutboxService);
    await inTenant(() => withTenant(appDb, T.tenantId, async (trx) => {
      for (const [agg, n] of [['a', 1], ['a', 2], ['b', 1]] as const) await ob.publish(trx, { aggregateType: 'x', aggregateId: agg, eventType: `E${n}`, payload: {} });
    }));
    const d = new Collect(); d.failFor.add('a');
    const relay = new OutboxRelay(adminDb, d, 3);
    expect(await relay.drainOnce()).toEqual({ dispatched: 1, failed: 1, deadLettered: 0 }); // b ok; a:E1 fails; a:E2 held back
    expect(d.seen.map((e) => e.aggregateId)).toEqual(['b']);
    d.failFor.clear();
    expect((await relay.drainOnce()).dispatched).toBe(2);
    expect(d.seen.filter((e) => e.aggregateId === 'a').map((e) => e.eventType)).toEqual(['E1', 'E2']); // order kept
    // dead letter
    await clearOutbox();
    await inTenant(() => withTenant(appDb, T.tenantId, (trx) => ob.publish(trx, { aggregateType: 'x', aggregateId: 'z', eventType: 'Z', payload: {} })));
    d.failFor.add('z');
    await relay.drainOnce(); await relay.drainOnce();
    expect((await relay.drainOnce()).deadLettered).toBe(1);
    expect((await relay.drainOnce()).failed).toBe(0);
  });
  it('concurrent relays never dispatch the same event twice', async () => {
    await clearOutbox();
    const ob = app.get(OutboxService);
    await inTenant(() => withTenant(appDb, T.tenantId, async (trx) => { for (let i = 0; i < 40; i++) await ob.publish(trx, { aggregateType: 'c', aggregateId: `c${i}`, eventType: 'E', payload: {} }); }));
    const d1 = new Collect(), d2 = new Collect();
    await Promise.all([new OutboxRelay(adminDb, d1).drainOnce(20), new OutboxRelay(adminDb, d2).drainOnce(20)]);
    await Promise.all([new OutboxRelay(adminDb, d1).drainOnce(20), new OutboxRelay(adminDb, d2).drainOnce(20)]);
    const all = [...d1.seen, ...d2.seen].map((e) => e.id);
    expect(all.length).toBe(40);
    expect(new Set(all).size).toBe(40);
  });
});

describe('inbox (idempotent consumers)', () => {
  it('runs the effect once per (consumer,event); a different consumer runs independently', async () => {
    const inbox = app.get(InboxService); let n = 0;
    const ev = '00000000-0000-4000-8000-000000000001';
    const run = (c: string) => withTenant(appDb, T.tenantId, (trx) => inbox.once(trx, T.tenantId, c, ev, async () => ++n));
    expect((await run('notify')).ran).toBe(true);
    expect((await run('notify')).ran).toBe(false);
    expect((await run('channels')).ran).toBe(true);
    expect(n).toBe(2);
  });
});

describe('idempotency', () => {
  const key = () => `key-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  it('replays the stored response and does not re-run the work', async () => {
    const idem = app.get(IdempotencyService); const k = key(); let runs = 0;
    const call = () => inTenant(() => withTenant(appDb, T.tenantId, (trx) =>
      idem.run(trx, k, hashRequest('POST', '/v1/x', { a: 1 }), async () => ({ statusCode: 201, body: { id: ++runs } }))));
    const first = await call(), second = await call();
    expect(first).toMatchObject({ replayed: false, statusCode: 201, body: { id: 1 } });
    expect(second).toMatchObject({ replayed: true, statusCode: 201, body: { id: 1 } });
    expect(runs).toBe(1);
  });
  it('rejects the same key with a different request (422)', async () => {
    const idem = app.get(IdempotencyService); const k = key();
    const call = (body: object) => inTenant(() => withTenant(appDb, T.tenantId, (trx) =>
      idem.run(trx, k, hashRequest('POST', '/v1/x', body), async () => ({ statusCode: 200, body: {} }))));
    await call({ a: 1 });
    await expect(call({ a: 2 })).rejects.toMatchObject({ status: 422 });
  });
  it('request hash ignores JSON key order', () => {
    expect(hashRequest('post', '/p', { a: 1, b: { c: 2, d: 3 } })).toBe(hashRequest('POST', '/p', { b: { d: 3, c: 2 }, a: 1 }));
  });
  it('concurrent duplicates execute the work exactly once', async () => {
    const idem = app.get(IdempotencyService); const k = key(); let runs = 0;
    const call = () => inTenant(() => withTenant(appDb, T.tenantId, (trx) =>
      idem.run(trx, k, 'h', async () => { runs++; await new Promise((r) => setTimeout(r, 50)); return { statusCode: 200, body: { ok: true } }; })));
    const results = await Promise.all([call(), call(), call(), call()]);
    expect(runs).toBe(1);
    expect(results.filter((r) => r.replayed).length).toBe(3);
  });
  it('a failed attempt leaves no key behind, so it can be retried', async () => {
    const idem = app.get(IdempotencyService); const k = key();
    await expect(inTenant(() => withTenant(appDb, T.tenantId, (trx) => idem.run(trx, k, 'h', async () => { throw new Error('fail'); })))).rejects.toThrow('fail');
    const r = await inTenant(() => withTenant(appDb, T.tenantId, (trx) => idem.run(trx, k, 'h', async () => ({ statusCode: 200, body: 1 }))));
    expect(r.replayed).toBe(false);
  });
  it('rejects malformed keys', async () => {
    const idem = app.get(IdempotencyService);
    await expect(inTenant(() => withTenant(appDb, T.tenantId, (trx) => idem.run(trx, 'short', 'h', async () => ({ statusCode: 200, body: 1 }))))).rejects.toMatchObject({ status: 400 });
  });
});

describe('built-in roles stay current', () => {
  it('adds roles and permissions introduced after a tenant was created, never removes, never touches custom roles', async () => {
    const t = await provision(app, 'rolesync');
    const roleId = async (key: string) => (await adminDb.selectFrom('role').select('id').where('tenant_id', '=', t.tenantId).where('key', '=', key).executeTakeFirstOrThrow()).id;
    const fd = await roleId('front_desk_agent');
    await adminDb.deleteFrom('role_permission').where('tenant_id', '=', t.tenantId).where('role_id', '=', fd).where('permission_key', 'in', ['frontdesk.check_in', 'frontdesk.check_out']).execute();
    await adminDb.deleteFrom('role').where('tenant_id', '=', t.tenantId).where('key', '=', 'property_admin').execute();
    const custom = (await adminDb.insertInto('role').values({ tenant_id: t.tenantId, key: 'night_shift_lead', name: 'Night shift lead', is_system: false }).returning('id').executeTakeFirstOrThrow()).id;
    await adminDb.insertInto('role_permission').values({ tenant_id: t.tenantId, role_id: custom, permission_key: 'report.view' }).execute();
    const r = await app.get(ProvisioningService).syncSystemRoles(t.tenantId);
    expect(r).toMatchObject({ tenants: 1, rolesAdded: 1 }); expect(r.permissionsAdded).toBeGreaterThanOrEqual(2);
    const perms = (await adminDb.selectFrom('role_permission').select('permission_key').where('tenant_id', '=', t.tenantId).where('role_id', '=', fd).execute()).map((p) => p.permission_key);
    expect(perms).toEqual(expect.arrayContaining(['frontdesk.check_in', 'frontdesk.check_out']));
    expect(await roleId('property_admin')).toBeDefined();
    expect((await adminDb.selectFrom('role_permission').select('permission_key').where('tenant_id', '=', t.tenantId).where('role_id', '=', custom).execute()).map((p) => p.permission_key)).toEqual(['report.view']);
    expect(await app.get(ProvisioningService).syncSystemRoles(t.tenantId)).toEqual({ tenants: 1, rolesAdded: 0, permissionsAdded: 0 });      // nothing left to add
  });
});
