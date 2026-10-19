import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'kysely';
import { PasswordService } from '../src/identity/password.service.js';
import { TotpService } from '../src/identity/totp.service.js';
import { readCookie } from '../src/identity/session.principal-resolver.js';
import { adminDb, assignRole, createTestApp, provision } from './harness.js';

const PW = 'a long and sturdy passphrase';
const ORIGIN = 'https://pms.test';
const totp = new TotpService();
const COOKIE = '__Host-hos_session';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>> & { slug: string };
let seq = 0;

beforeAll(async () => {
  app = await createTestApp({ realAuth: true });
  T = { ...(await provision(app, 'ident')), slug: 'ident' };
});
afterAll(async () => { await app.close(); });

const req = (method: 'GET' | 'POST', url: string, o: { cookie?: string; csrf?: string; body?: unknown; origin?: string } = {}) =>
  app.inject({ method, url, payload: o.body as object | undefined, headers: {
    ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.csrf ? { 'x-csrf-token': o.csrf } : {}), ...(o.origin ? { origin: o.origin } : {}) } });

const cookieFrom = (res: Awaited<ReturnType<typeof req>>) => {
  const sc = String(res.headers['set-cookie']);
  return { raw: sc, pair: sc.split(';')[0]! };
};

/** Creates an ACTIVE user with a password and a role, returning credentials. */
async function makeUser(roleKey = 'front_desk_agent', scope: 'TENANT' | 'PROPERTY' = 'TENANT') {
  const email = `u${++seq}@ident.test`;
  const hash = await app.get(PasswordService).hash(PW);
  const u = await adminDb.insertInto('staff_user').values({ tenant_id: T.tenantId, email, full_name: `User ${seq}`, password_hash: hash, status: 'ACTIVE' }).returning('id').executeTakeFirstOrThrow();
  await assignRole(T.tenantId, u.id, roleKey, scope, scope === 'PROPERTY' ? T.propertyIds[0] : null);
  return { id: u.id, email };
}

async function login(email: string, password = PW) {
  const res = await req('POST', '/v1/auth/login', { body: { tenant: T.slug, email, password } });
  if (res.statusCode !== 200) return { res };
  return { res, cookie: cookieFrom(res).pair, csrf: res.json().csrfToken as string, state: res.json().state as string };
}

async function enrollMfa(cookie: string, csrf: string) {
  const e = await req('POST', '/v1/auth/mfa/enroll', { cookie, csrf });
  expect(e.statusCode).toBe(200);
  const { secret } = e.json();
  const step = Math.floor(Date.now() / 30000);
  const c = await req('POST', '/v1/auth/mfa/confirm', { cookie, csrf, body: { code: totp.codeAtStep(secret, step) } });
  expect(c.statusCode).toBe(200);
  return { secret, usedStep: step, recoveryCodes: c.json().recoveryCodes as string[] };
}

describe('invitation & password setup', () => {
  it('rejects weak passwords and accepts a good one; the link is single-use', async () => {
    const weak = await req('POST', '/v1/auth/accept-invite', { body: { tenant: T.slug, token: T.ownerInviteToken, password: 'short' } });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().code).toBe('WEAK_PASSWORD');
    const ok = await req('POST', '/v1/auth/accept-invite', { body: { tenant: T.slug, token: T.ownerInviteToken, password: PW } });
    expect(ok.statusCode).toBe(204);
    const again = await req('POST', '/v1/auth/accept-invite', { body: { tenant: T.slug, token: T.ownerInviteToken, password: PW } });
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe('INVALID_TOKEN');
  });
  it('an invite token for another tenant is useless here', async () => {
    const other = await provision(app, 'ident-other');
    const r = await req('POST', '/v1/auth/accept-invite', { body: { tenant: T.slug, token: other.ownerInviteToken, password: PW } });
    expect(r.statusCode).toBe(400);
  });
});

describe('login', () => {
  it('sets a hardened session cookie and the session works', async () => {
    const u = await makeUser();
    const { res, cookie, csrf } = await login(u.email);
    expect(res.statusCode).toBe(200);
    const sc = cookieFrom(res).raw;
    expect(sc).toContain(`${COOKIE}=`);
    expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/Secure/); expect(sc).toMatch(/SameSite=Lax/); expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/Domain=/);
    expect(csrf.length).toBeGreaterThan(20);
    const me = await req('GET', '/v1/auth/me', { cookie: cookie! });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(u.email);
    expect(me.json().grants.length).toBeGreaterThan(0);
  });
  it('unknown tenant, unknown user and wrong password are indistinguishable', async () => {
    const u = await makeUser();
    const a = await req('POST', '/v1/auth/login', { body: { tenant: 'no-such-tenant', email: u.email, password: PW } });
    const b = await req('POST', '/v1/auth/login', { body: { tenant: T.slug, email: 'ghost@ident.test', password: PW } });
    const c = await req('POST', '/v1/auth/login', { body: { tenant: T.slug, email: u.email, password: 'wrong wrong wrong' } });
    for (const r of [a, b, c]) { expect(r.statusCode).toBe(401); expect(r.json().code).toBe('INVALID_CREDENTIALS'); }
    expect(new Set([a, b, c].map((r) => r.json().detail)).size).toBe(1);
  });
  it('a tampered or foreign-tenant cookie is rejected', async () => {
    const u = await makeUser();
    const { cookie } = await login(u.email);
    const value = readCookie(cookie, COOKIE)!;
    const tampered = `${COOKIE}=${value.slice(0, -2)}xx`;
    expect((await req('GET', '/v1/auth/me', { cookie: tampered })).statusCode).toBe(401);
    const swapped = `${COOKIE}=${'00000000-0000-4000-8000-000000000000'}${value.slice(36)}`;
    expect((await req('GET', '/v1/auth/me', { cookie: swapped })).statusCode).toBe(401);
  });
  it('validates input shape', async () => {
    const r = await req('POST', '/v1/auth/login', { body: { tenant: T.slug } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('VALIDATION_FAILED');
  });
  it('locks the account after repeated failures, even for the right password, and records it in the audit log', async () => {
    const u = await makeUser();
    for (let i = 0; i < 5; i++) await req('POST', '/v1/auth/login', { body: { tenant: T.slug, email: u.email, password: `wrong password ${i} xx` } });
    const locked = await req('POST', '/v1/auth/login', { body: { tenant: T.slug, email: u.email, password: PW } });
    expect(locked.statusCode).toBe(401);
    const actions = (await adminDb.selectFrom('audit_log').select('action').where('actor_id', '=', u.id).execute()).map((r) => r.action);
    expect(actions).toContain('auth.account_locked');
    await adminDb.updateTable('staff_user').set({ locked_until: new Date(Date.now() - 1000) }).where('id', '=', u.id).execute();
    expect((await login(u.email)).res.statusCode).toBe(200);
  });
  it('a disabled user cannot log in and an existing session stops working', async () => {
    const u = await makeUser();
    const { cookie } = await login(u.email);
    await adminDb.updateTable('staff_user').set({ status: 'DISABLED' }).where('id', '=', u.id).execute();
    expect((await req('GET', '/v1/auth/me', { cookie: cookie! })).statusCode).toBe(401);
    expect((await login(u.email)).res.statusCode).toBe(401);
  });
});

describe('sessions, CSRF and origin', () => {
  it('unsafe requests need the CSRF token; logout revokes the session', async () => {
    const u = await makeUser();
    const { cookie, csrf } = await login(u.email);
    const noCsrf = await req('POST', '/v1/auth/logout', { cookie: cookie! });
    expect(noCsrf.statusCode).toBe(403); expect(noCsrf.json().code).toBe('CSRF_INVALID');
    expect((await req('POST', '/v1/auth/logout', { cookie: cookie!, csrf: 'wrong' })).statusCode).toBe(403);
    expect((await req('POST', '/v1/auth/logout', { cookie: cookie!, csrf })).statusCode).toBe(204);
    expect((await req('GET', '/v1/auth/me', { cookie: cookie! })).statusCode).toBe(401);
  });
  it('rejects unsafe requests from a disallowed Origin and allows the configured one', async () => {
    const u = await makeUser();
    const evil = await req('POST', '/v1/auth/login', { origin: 'https://evil.example', body: { tenant: T.slug, email: u.email, password: PW } });
    expect(evil.statusCode).toBe(403); expect(evil.json().code).toBe('ORIGIN_NOT_ALLOWED');
    const good = await req('POST', '/v1/auth/login', { origin: ORIGIN, body: { tenant: T.slug, email: u.email, password: PW } });
    expect(good.statusCode).toBe(200);
  });
  it('idle and absolute expiry end the session', async () => {
    const u = await makeUser();
    const a = await login(u.email), b = await login(u.email);
    await adminDb.updateTable('user_session').set({ idle_expires_at: new Date(Date.now() - 1000) }).where('user_id', '=', u.id).where('csrf_token', '=', a.csrf!).execute();
    await adminDb.updateTable('user_session').set({ absolute_expires_at: new Date(Date.now() - 1000) }).where('user_id', '=', u.id).where('csrf_token', '=', b.csrf!).execute();
    expect((await req('GET', '/v1/auth/me', { cookie: a.cookie! })).statusCode).toBe(401);
    expect((await req('GET', '/v1/auth/me', { cookie: b.cookie! })).statusCode).toBe(401);
  });
  it('stores only a hash of the session token', async () => {
    const u = await makeUser();
    const { cookie } = await login(u.email);
    const token = readCookie(cookie, COOKIE)!;
    const rows = await sql<{ n: string }>`SELECT count(*) AS n FROM user_session WHERE encode(token_hash,'escape') = ${token}`.execute(adminDb);
    expect(rows.rows[0]!.n).toBe('0');
  });
  it('changing the password revokes the other sessions but not the current one', async () => {
    const u = await makeUser();
    const s1 = await login(u.email), s2 = await login(u.email);
    expect((await req('POST', '/v1/auth/password/change', { cookie: s1.cookie!, csrf: s1.csrf, body: { currentPassword: 'nope nope nope nope', newPassword: 'another sturdy passphrase' } })).statusCode).toBe(401);
    expect((await req('POST', '/v1/auth/password/change', { cookie: s1.cookie!, csrf: s1.csrf, body: { currentPassword: PW, newPassword: 'weak' } })).json().code).toBe('WEAK_PASSWORD');
    expect((await req('POST', '/v1/auth/password/change', { cookie: s1.cookie!, csrf: s1.csrf, body: { currentPassword: PW, newPassword: 'another sturdy passphrase' } })).statusCode).toBe(204);
    expect((await req('GET', '/v1/auth/me', { cookie: s1.cookie! })).statusCode).toBe(200);
    expect((await req('GET', '/v1/auth/me', { cookie: s2.cookie! })).statusCode).toBe(401);
    expect((await login(u.email, 'another sturdy passphrase')).res.statusCode).toBe(200);
  });
  it('persists the staff language preference (English / Urdu)', async () => {
    const u = await makeUser('housekeeper');
    const { cookie, csrf } = await login(u.email);
    expect((await req('POST', '/v1/auth/locale', { cookie: cookie!, csrf, body: { locale: 'ur' } })).statusCode).toBe(204);
    expect((await req('GET', '/v1/auth/me', { cookie: cookie! })).json().user.locale).toBe('ur');
    expect((await req('POST', '/v1/auth/locale', { cookie: cookie!, csrf, body: { locale: 'fr' } })).statusCode).toBe(400);
  });
});

describe('two-factor authentication & step-up', () => {
  it('sensitive endpoints refuse a session without a fresh second factor', async () => {
    const u = await makeUser('group_owner');
    const { cookie } = await login(u.email);
    const r = await req('GET', '/v1/audit-log', { cookie: cookie! });
    expect(r.statusCode).toBe(403); expect(r.json().code).toBe('MFA_REQUIRED');
  });
  it('enrol → audit log opens; next login requires the code; replay and wrong codes fail', async () => {
    const u = await makeUser('group_owner');
    const first = await login(u.email);
    const { secret, usedStep, recoveryCodes } = await enrollMfa(first.cookie!, first.csrf!);
    expect(recoveryCodes).toHaveLength(10);
    const audit = await req('GET', '/v1/audit-log', { cookie: first.cookie! });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().items.length).toBeGreaterThan(0);

    const second = await login(u.email);
    expect(second.state).toBe('PENDING_MFA');
    const pending = await req('GET', '/v1/auth/me', { cookie: second.cookie! });
    expect(pending.statusCode).toBe(401); expect(pending.json().code).toBe('MFA_PENDING');
    expect((await req('GET', '/v1/audit-log', { cookie: second.cookie! })).statusCode).toBe(401);

    const wrong = await req('POST', '/v1/auth/mfa/verify', { cookie: second.cookie!, csrf: second.csrf, body: { code: '000000' } });
    expect(wrong.statusCode).toBe(401); expect(wrong.json().code).toBe('INVALID_CODE');
    const replay = await req('POST', '/v1/auth/mfa/verify', { cookie: second.cookie!, csrf: second.csrf, body: { code: totp.codeAtStep(secret, usedStep) } });
    expect(replay.statusCode).toBe(401); // the confirmation code's time-step cannot be reused

    const good = await req('POST', '/v1/auth/mfa/verify', { cookie: second.cookie!, csrf: second.csrf, body: { code: totp.codeAtStep(secret, usedStep + 1) } });
    expect(good.statusCode).toBe(200);
    expect((await req('GET', '/v1/audit-log', { cookie: second.cookie! })).statusCode).toBe(200);
  });
  it('step-up window expires and can be renewed', async () => {
    const u = await makeUser('group_owner');
    const s = await login(u.email);
    const { secret, usedStep } = await enrollMfa(s.cookie!, s.csrf!);
    await adminDb.updateTable('user_session').set({ mfa_verified_at: new Date(Date.now() - 20 * 60_000) }).where('user_id', '=', u.id).execute();
    expect((await req('GET', '/v1/audit-log', { cookie: s.cookie! })).json().code).toBe('MFA_REQUIRED');
    const ok = await req('POST', '/v1/auth/mfa/verify', { cookie: s.cookie!, csrf: s.csrf, body: { code: totp.codeAtStep(secret, usedStep + 1) } });
    expect(ok.statusCode).toBe(200);
    expect((await req('GET', '/v1/audit-log', { cookie: s.cookie! })).statusCode).toBe(200);
  });
  it('five bad codes revoke the pending session', async () => {
    const u = await makeUser('group_owner');
    const s = await login(u.email);
    await enrollMfa(s.cookie!, s.csrf!);
    const p = await login(u.email);
    for (let i = 0; i < 5; i++) await req('POST', '/v1/auth/mfa/verify', { cookie: p.cookie!, csrf: p.csrf, body: { code: '111111' } });
    const after = await req('POST', '/v1/auth/mfa/verify', { cookie: p.cookie!, csrf: p.csrf, body: { code: '111111' } });
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe('UNAUTHENTICATED'); // session itself is gone
  });
  it('a recovery code works exactly once', async () => {
    const u = await makeUser('group_owner');
    const s = await login(u.email);
    const { recoveryCodes } = await enrollMfa(s.cookie!, s.csrf!);
    const code = recoveryCodes[0]!;
    const a = await login(u.email);
    expect((await req('POST', '/v1/auth/mfa/verify', { cookie: a.cookie!, csrf: a.csrf, body: { code } })).statusCode).toBe(200);
    const b = await login(u.email);
    expect((await req('POST', '/v1/auth/mfa/verify', { cookie: b.cookie!, csrf: b.csrf, body: { code } })).statusCode).toBe(401);
  });
  it('the TOTP seed is stored encrypted, never in plaintext', async () => {
    const u = await makeUser('group_owner');
    const s = await login(u.email);
    const { secret } = await enrollMfa(s.cookie!, s.csrf!);
    const row = await adminDb.selectFrom('user_mfa_totp').select('secret_enc').where('user_id', '=', u.id).executeTakeFirstOrThrow();
    expect(row.secret_enc.startsWith('v1:')).toBe(true);
    expect(row.secret_enc).not.toContain(secret);
  });
  it('a second enrolment is refused once MFA is on', async () => {
    const u = await makeUser('group_owner');
    const s = await login(u.email);
    await enrollMfa(s.cookie!, s.csrf!);
    expect((await req('POST', '/v1/auth/mfa/enroll', { cookie: s.cookie!, csrf: s.csrf })).statusCode).toBe(409);
  });
});

describe('RBAC through real sessions', () => {
  it('a property-scoped front-desk user reads their property but not the audit log', async () => {
    const u = await makeUser('front_desk_agent', 'PROPERTY');
    const { cookie } = await login(u.email);
    expect((await req('GET', `/v1/properties/${T.propertyIds[0]}`, { cookie: cookie! })).statusCode).toBe(200);
    expect((await req('GET', `/v1/properties/${T.propertyIds[1]}`, { cookie: cookie! })).statusCode).toBe(403);
    expect((await req('GET', '/v1/audit-log', { cookie: cookie! })).statusCode).toBe(403);
  });
  it('gate security cannot read property details or folios', async () => {
    const u = await makeUser('gate_security');
    const { cookie } = await login(u.email);
    expect((await req('GET', `/v1/properties/${T.propertyIds[0]}`, { cookie: cookie! })).statusCode).toBe(403);
  });
});
