import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addUser, adminDb, as, assignRole, createTestApp, provision } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
let OM: Record<string, string>;
let n = 0;
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown) => app.inject({ method, url, headers, payload: body as object | undefined });
const ok = async (r: Promise<any>, status = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json(); };
const code = async (r: Promise<any>, status: number, c: string) => { const x = await r; expect(x.statusCode, x.body).toBe(status); expect(x.json().code).toBe(c); return x.json(); };
const SLUG = 'staff';
const PW = 'Correct-Horse-Battery-9';

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'staff'); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
afterAll(async () => { await app.close(); });

async function gm(propertyId: string) {
  const id = await addUser(T.tenantId, `gm${++n}@staff.test`); await assignRole(T.tenantId, id, 'general_manager', 'PROPERTY', propertyId);
  return { id, h: as(T.tenantId, id, { mfa: true }) };
}
const mk = (email: string, h = OM) => call('POST', '/v1/users', h, { email, fullName: 'New Person' });

describe('adding staff', () => {
  it('creates a user and a one-time link; the link sets the password once; the person then shows as active; emails are unique', async () => {
    const c = await ok(mk(`a${++n}@staff.test`), 201);
    expect(c).toMatchObject({ status: 'INVITED', invite: { token: expect.stringContaining('.'), expiresInDays: 7 } });
    await code(mk(c.email.toUpperCase()), 409, 'DUPLICATE');
    await code(call('POST', '/v1/auth/accept-invite', {}, { tenant: SLUG, token: c.invite.token, password: 'password1234' }), 400, 'WEAK_PASSWORD');
    expect((await call('POST', '/v1/auth/accept-invite', {}, { tenant: SLUG, token: c.invite.token, password: PW })).statusCode).toBe(204);
    await code(call('POST', '/v1/auth/accept-invite', {}, { tenant: SLUG, token: c.invite.token, password: PW }), 400, 'INVALID_TOKEN');
    const row = (await ok(call('GET', '/v1/users', OM))).items.find((u: any) => u.id === c.id);
    expect(row).toMatchObject({ status: 'ACTIVE', assignments: [] });
    // a new link replaces older ones; for an active person it is a password reset
    const r1 = await ok(call('POST', `/v1/users/${c.id}/invite`, OM)); expect(r1.purpose).toBe('PASSWORD_RESET');
    const r2 = await ok(call('POST', `/v1/users/${c.id}/invite`, OM));
    await code(call('POST', '/v1/auth/accept-invite', {}, { tenant: SLUG, token: r1.invite.token, password: PW }), 400, 'INVALID_TOKEN');
    expect((await call('POST', '/v1/auth/accept-invite', {}, { tenant: SLUG, token: r2.invite.token, password: `${PW}x` })).statusCode).toBe(204);
  });

  it('only people who manage users can; the second factor is needed', async () => {
    const clerk = await addUser(T.tenantId, `clerk${++n}@staff.test`); await assignRole(T.tenantId, clerk, 'front_desk_agent', 'PROPERTY', T.propertyIds[0]);
    await code(mk(`b${++n}@staff.test`, as(T.tenantId, clerk, { mfa: true })), 403, 'PERMISSION_DENIED');
    await code(mk(`c${++n}@staff.test`, as(T.tenantId, T.ownerUserId)), 403, 'MFA_REQUIRED');
    await code(call('GET', '/v1/roles', as(T.tenantId, clerk, { mfa: true })), 403, 'PERMISSION_DENIED');
    expect((await ok(call('GET', '/v1/roles', OM))).items.find((r: any) => r.key === 'front_desk_agent').permissions).toContain('folio.view');
  });
});

describe('roles', () => {
  it('are given at a property or for the whole business, with limits; nobody can hand out more than they hold; a manager is kept to their own property', async () => {
    const [p1, p2] = T.propertyIds;
    const boss = await gm(p1);
    const u = await ok(mk(`d${++n}@staff.test`), 201);
    const body = (o: Record<string, unknown> = {}) => ({ roleKey: 'front_desk_agent', scopeType: 'PROPERTY', scopeId: p1, ...o });
    await code(call('POST', `/v1/users/${u.id}/roles`, OM, body({ scopeType: 'TENANT', scopeId: p1 })), 400, 'VALIDATION_FAILED');
    const a = await ok(call('POST', `/v1/users/${u.id}/roles`, boss.h, body({ limits: { max_discount_pct: 5 } })), 201);
    expect(a).toMatchObject({ roleKey: 'front_desk_agent', scopeType: 'PROPERTY' });
    await code(call('POST', `/v1/users/${u.id}/roles`, boss.h, body()), 409, 'ALREADY_ASSIGNED');
    await code(call('POST', `/v1/users/${u.id}/roles`, boss.h, body({ scopeId: p2 })), 403, 'INSUFFICIENT_AUTHORITY');                       // another property
    await code(call('POST', `/v1/users/${u.id}/roles`, boss.h, body({ scopeType: 'TENANT', scopeId: null })), 403, 'INSUFFICIENT_AUTHORITY');   // wider than their own
    await code(call('POST', `/v1/users/${u.id}/roles`, boss.h, body({ roleKey: 'group_owner', scopeType: 'TENANT', scopeId: null })), 403, 'INSUFFICIENT_AUTHORITY');
    await code(call('POST', `/v1/users/${u.id}/roles`, boss.h, body({ roleKey: 'nonesuch' })), 404, 'NOT_FOUND');
    await code(call('POST', `/v1/users/${boss.id}/roles`, boss.h, body({ roleKey: 'accountant' })), 403, 'SELF_ACTION');
    await ok(call('POST', `/v1/users/${u.id}/roles`, OM, body({ roleKey: 'accountant', scopeType: 'TENANT', scopeId: null })), 201);               // the owner may
    const shown = (await ok(call('GET', '/v1/users', OM))).items.find((x: any) => x.id === u.id);
    expect(shown.assignments.map((x: any) => [x.roleKey, x.scopeType, x.scope]).sort()).toEqual([['accountant', 'TENANT', null], ['front_desk_agent', 'PROPERTY', 'staff P1']]);
    // ending a role
    await code(call('DELETE', `/v1/users/${u.id}/roles/${a.id}`, boss.h), 400, 'VALIDATION_FAILED');                                           // a reason is needed
    await ok(call('DELETE', `/v1/users/${u.id}/roles/${a.id}?reason=Moved%20to%20another%20hotel`, boss.h));
    await code(call('DELETE', `/v1/users/${u.id}/roles/${a.id}?reason=Again%20please`, boss.h), 404, 'NOT_FOUND');
    expect((await ok(call('GET', '/v1/users', OM))).items.find((x: any) => x.id === u.id).assignments.map((x: any) => x.roleKey)).toEqual(['accountant']);
    // the property manager cannot take away the accountant role: it is wider than theirs
    const acc = shown.assignments.find((x: any) => x.roleKey === 'accountant');
    await code(call('DELETE', `/v1/users/${u.id}/roles/${acc.id}?reason=I%20want%20to`, boss.h), 403, 'INSUFFICIENT_AUTHORITY');
  });
});

describe('looking after accounts', () => {
  it('disabling signs the person out everywhere and can be undone; a manager cannot touch the owner or themselves; resetting the second factor clears it', async () => {
    const [p1] = T.propertyIds;
    const boss = await gm(p1);
    const u = await ok(mk(`e${++n}@staff.test`), 201);
    await ok(call('POST', `/v1/users/${u.id}/roles`, OM, { roleKey: 'front_desk_agent', scopeType: 'PROPERTY', scopeId: p1 }), 201);
    await adminDb.insertInto('user_session').values({ tenant_id: T.tenantId, user_id: u.id, token_hash: Buffer.from(`sess-${n}`), csrf_hash: Buffer.from('c'), expires_at: new Date(Date.now() + 3_600_000), idle_expires_at: new Date(Date.now() + 3_600_000), mfa_verified_at: null } as never).execute().catch(() => undefined);
    await code(call('POST', `/v1/users/${u.id}/disable`, boss.h, { reason: 'x' }), 400, 'VALIDATION_FAILED');
    expect(await ok(call('POST', `/v1/users/${u.id}/disable`, boss.h, { reason: 'Left the company' }))).toMatchObject({ status: 'DISABLED' });
    expect((await adminDb.selectFrom('user_session').select('id').where('user_id', '=', u.id).where('revoked_at', 'is', null).execute())).toHaveLength(0);
    await code(call('POST', `/v1/users/${u.id}/invite`, boss.h), 409, 'USER_DISABLED');
    expect(await ok(call('POST', `/v1/users/${u.id}/enable`, boss.h, { reason: 'Came back' }))).toMatchObject({ status: 'INVITED' });
    await code(call('POST', `/v1/users/${T.ownerUserId}/disable`, boss.h, { reason: 'coup attempt' }), 403, 'INSUFFICIENT_AUTHORITY');
    await code(call('POST', `/v1/users/${T.ownerUserId}/reset-mfa`, boss.h, { reason: 'coup attempt' }), 403, 'INSUFFICIENT_AUTHORITY');
    await code(call('POST', `/v1/users/${boss.id}/disable`, boss.h, { reason: 'myself' }), 403, 'SELF_ACTION');
    await code(call('POST', `/v1/users/${T.ownerUserId}/disable`, OM, { reason: 'myself' }), 403, 'SELF_ACTION');
    // lost phone
    await adminDb.insertInto('user_mfa_totp').values({ tenant_id: T.tenantId, user_id: u.id, secret_enc: Buffer.from('x'), confirmed_at: new Date(), last_used_step: null } as never).execute();
    await adminDb.updateTable('staff_user').set({ mfa_enabled: true }).where('id', '=', u.id).execute();
    expect(await ok(call('POST', `/v1/users/${u.id}/reset-mfa`, boss.h, { reason: 'Lost phone, identity checked in person' }))).toMatchObject({ mfaEnabled: false });
    expect((await adminDb.selectFrom('user_mfa_totp').select('user_id').where('user_id', '=', u.id).execute())).toHaveLength(0);
    expect((await ok(call('GET', '/v1/users', OM))).items.find((x: any) => x.id === u.id).mfaEnabled).toBe(false);
  });

  it('every change is in the audit trail with who did it; the trail needs the permission and the second factor', async () => {
    const t = await ok(call('GET', '/v1/audit?action=staff.', OM));
    expect(t.items.length).toBeGreaterThan(5);
    expect(t.items.every((i: any) => i.action.startsWith('staff.'))).toBe(true);
    expect(t.items.find((i: any) => i.action === 'staff.role_assign')).toMatchObject({ actor: expect.any(String) });
    const clerk = await addUser(T.tenantId, `clerk${++n}@staff.test`); await assignRole(T.tenantId, clerk, 'front_desk_agent', 'TENANT', null);
    await code(call('GET', '/v1/audit', as(T.tenantId, clerk, { mfa: true })), 403, 'PERMISSION_DENIED');
    await code(call('GET', '/v1/audit', as(T.tenantId, T.ownerUserId)), 403, 'MFA_REQUIRED');
    const page = await ok(call('GET', '/v1/audit?limit=2', OM)); expect(page.items).toHaveLength(2);
  });
});

describe('several roles at once', () => {
  it('a small hotel’s manager is given several roles in one go; roles already held are left alone; one that is too wide refuses the whole set; and they can be removed together', async () => {
    const [p1, p2] = T.propertyIds;
    const boss = await gm(p1);
    const u = await ok(mk(`m${++n}@staff.test`), 201);
    const body = (o: Record<string, unknown> = {}) => ({ roleKeys: ['front_desk_agent', 'cashier', 'housekeeping_supervisor'], scopeType: 'PROPERTY', scopeId: p1, ...o });
    await code(call('POST', `/v1/users/${u.id}/roles/bulk`, boss.h, body({ roleKeys: [] })), 400, 'VALIDATION_FAILED');
    const r = await ok(call('POST', `/v1/users/${u.id}/roles/bulk`, boss.h, body()), 201);
    expect(r.given.map((x: any) => x.roleKey)).toEqual(['front_desk_agent', 'cashier', 'housekeeping_supervisor']); expect(r.already).toEqual([]);
    const again = await ok(call('POST', `/v1/users/${u.id}/roles/bulk`, boss.h, body({ roleKeys: ['cashier', 'night_auditor'] })), 201);
    expect(again.given.map((x: any) => x.roleKey)).toEqual(['night_auditor']); expect(again.already).toEqual(['cashier']);
    // one role too wide: nothing is given, and the answer names it
    const u2 = await ok(mk(`m${++n}@staff.test`), 201);
    const bad = await code(call('POST', `/v1/users/${u2.id}/roles/bulk`, boss.h, body({ roleKeys: ['front_desk_agent', 'group_owner'] })), 403, 'INSUFFICIENT_AUTHORITY');
    expect(bad.roleKey).toBe('group_owner');
    expect((await ok(call('GET', '/v1/users', OM))).items.find((x: any) => x.id === u2.id).assignments).toEqual([]);
    await code(call('POST', `/v1/users/${u2.id}/roles/bulk`, boss.h, body({ scopeId: p2 })), 403, 'INSUFFICIENT_AUTHORITY');          // another property
    await code(call('POST', `/v1/users/${boss.id}/roles/bulk`, boss.h, body()), 403, 'SELF_ACTION');
    // removing several together needs a reason and ends them all
    const shown = (await ok(call('GET', '/v1/users', OM))).items.find((x: any) => x.id === u.id);
    const ids = shown.assignments.filter((x: any) => ['cashier', 'night_auditor'].includes(x.roleKey)).map((x: any) => x.id);
    await code(call('POST', `/v1/users/${u.id}/roles/remove`, boss.h, { assignmentIds: ids, reason: 'x' }), 400, 'VALIDATION_FAILED');
    expect((await ok(call('POST', `/v1/users/${u.id}/roles/remove`, boss.h, { assignmentIds: ids, reason: 'No longer does the cash' }))).ended).toBe(2);
    expect((await ok(call('GET', '/v1/users', OM))).items.find((x: any) => x.id === u.id).assignments.map((x: any) => x.roleKey).sort()).toEqual(['front_desk_agent', 'housekeeping_supervisor']);
    const audit = await adminDb.selectFrom('audit_log').select('action').where('tenant_id', '=', T.tenantId).where('resource_id', '=', u.id).execute();
    expect(audit.filter((a) => a.action === 'staff.role_assign')).toHaveLength(4); expect(audit.filter((a) => a.action === 'staff.role_revoke')).toHaveLength(2);
  });

  it('the roles list carries plain-language labels for what each permission allows and the small-hotel presets', async () => {
    const r = await ok(call('GET', '/v1/roles', OM));
    expect(r.permissionLabels['fnb.manage']).toBeTruthy();
    expect(r.presets.find((p: any) => p.key === 'desk_and_cash').roles).toEqual(['front_desk_agent', 'cashier']);
    expect(r.presets.every((p: any) => p.roles.length >= 2 && p.roles.every((k: string) => r.items.some((x: any) => x.key === k)))).toBe(true);
  });
});
