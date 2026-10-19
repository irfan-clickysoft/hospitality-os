import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { resolveTenantBySlug, withTenant, type DB } from '@hos/db';
import { AuditService } from '../audit/audit.service.js';
import { SecretBox } from '../common/secret-box.js';
import { DB_APP } from '../db/db.module.js';
import { runWithTenant } from '../tenancy/tenant-context.js';
import { loadIdentityConfig } from './identity.config.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { parseToken, sha256 } from './tokens.js';
import { TotpService } from './totp.service.js';

export interface ClientMeta { ip?: string; userAgent?: string; requestId?: string }
export interface LoginResult { token: string; csrfToken: string; state: 'PENDING_MFA' | 'ACTIVE'; user: { id: string; email: string; fullName: string; locale: 'en' | 'ur' } }

const INVALID = () => new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid credentials, or the account is temporarily locked' });
const aad = (tenantId: string, userId: string) => `${tenantId}:${userId}`;
const normalizeRecovery = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, '');

@Injectable()
export class IdentityService {
  private readonly cfg = loadIdentityConfig();
  private readonly box = SecretBox.fromEnv();

  constructor(
    @Inject(DB_APP) private readonly db: Kysely<DB>,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(TotpService) private readonly totp: TotpService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private inTenant<T>(tenantId: string, actorId: string | undefined, meta: ClientMeta, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return runWithTenant({ tenantId, actorId, requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent }, () => withTenant(this.db, tenantId, fn));
  }

  async login(input: { tenant: string; email: string; password: string }, meta: ClientMeta): Promise<LoginResult> {
    const tenant = await resolveTenantBySlug(this.db, input.tenant);
    if (!tenant || ['CANCELLED', 'ARCHIVED'].includes(tenant.status)) { await this.passwords.burn(input.password); throw INVALID(); }

    const outcome = await this.inTenant(tenant.id, undefined, meta, async (trx) => {
      const user = await trx.selectFrom('staff_user').selectAll().where('email', '=', input.email).executeTakeFirst();
      if (!user || !user.password_hash || user.status !== 'ACTIVE') { await this.passwords.burn(input.password); return null; }
      const now = Date.now();
      const locked = user.locked_until !== null && new Date(user.locked_until).getTime() > now;
      const ok = await this.passwords.verify(user.password_hash, input.password); // always verify: constant work whether locked or not
      return runWithTenant({ tenantId: tenant.id, actorId: user.id, requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent }, async () => {
        if (locked || !ok) {
          if (!locked) {
            const count = user.failed_login_count + 1;
            const lock = count >= this.cfg.lockoutThreshold;
            await trx.updateTable('staff_user').set({ failed_login_count: lock ? 0 : count, locked_until: lock ? new Date(now + this.cfg.lockoutMinutes * 60_000) : null })
              .where('id', '=', user.id).execute();
            await this.audit.record(trx, { action: lock ? 'auth.account_locked' : 'auth.login_failed', resourceType: 'staff_user', resourceId: user.id });
          } else {
            await this.audit.record(trx, { action: 'auth.login_while_locked', resourceType: 'staff_user', resourceId: user.id });
          }
          return null;
        }
        const mfa = await trx.selectFrom('user_mfa_totp').select('confirmed_at').where('user_id', '=', user.id).executeTakeFirst();
        const state = mfa?.confirmed_at ? 'PENDING_MFA' as const : 'ACTIVE' as const;
        await trx.updateTable('staff_user').set({ failed_login_count: 0, locked_until: null, last_login_at: new Date(now) }).where('id', '=', user.id).execute();
        const s = await this.sessions.create(trx, tenant.id, user.id, state, meta);
        await this.audit.record(trx, { action: 'auth.login', resourceType: 'user_session', resourceId: s.sessionId, note: state === 'PENDING_MFA' ? 'password ok; awaiting second factor' : undefined });
        return { token: s.token, csrfToken: s.csrfToken, state, user: { id: user.id, email: user.email, fullName: user.full_name, locale: user.preferred_locale } };
      });
    });
    if (!outcome) throw INVALID();
    return outcome;
  }

  /** Completes login (PENDING_MFA) or step-up (ACTIVE) with a TOTP or recovery code. Failures are counted per session. */
  async verifyMfa(s: { tenantId: string; userId: string; sessionId: string }, code: string, meta: ClientMeta): Promise<boolean> {
    return this.inTenant(s.tenantId, s.userId, meta, async (trx) => {
      const row = await trx.selectFrom('user_mfa_totp').selectAll().where('user_id', '=', s.userId).where('confirmed_at', 'is not', null).executeTakeFirst();
      if (!row) throw new BadRequestException({ code: 'MFA_NOT_ENROLLED', message: 'Enrol in two-factor authentication first' });
      const trimmed = code.trim();
      let ok = false;
      const step = this.totp.check(this.box.open(row.secret_enc, aad(s.tenantId, s.userId)), trimmed);
      if (step !== null && (row.last_used_step === null || BigInt(step) > BigInt(row.last_used_step))) {
        await trx.updateTable('user_mfa_totp').set({ last_used_step: String(step) }).where('user_id', '=', s.userId).execute();
        ok = true;
      } else if (/^[a-z0-9-]{8,16}$/i.test(trimmed)) {
        const used = await trx.updateTable('user_recovery_code').set({ used_at: sql`now()` as never })
          .where('user_id', '=', s.userId).where('code_hash', '=', sha256(normalizeRecovery(trimmed))).where('used_at', 'is', null).returning('id').executeTakeFirst();
        ok = !!used;
      }
      if (ok) {
        await trx.updateTable('user_session').set({ state: 'ACTIVE', mfa_verified_at: sql`now()` as never, mfa_failed_count: 0 }).where('id', '=', s.sessionId).execute();
        await this.audit.record(trx, { action: 'auth.mfa_verified', resourceType: 'user_session', resourceId: s.sessionId });
      } else {
        const sess = await trx.updateTable('user_session').set((eb) => ({ mfa_failed_count: eb('mfa_failed_count', '+', 1) })).where('id', '=', s.sessionId).returning('mfa_failed_count').executeTakeFirst();
        if (sess && sess.mfa_failed_count >= this.cfg.mfaMaxFailures) await this.sessions.revoke(trx, s.sessionId);
        await this.audit.record(trx, { action: 'auth.mfa_failed', resourceType: 'user_session', resourceId: s.sessionId });
      }
      return ok;
    });
  }

  async enrollMfa(s: { tenantId: string; userId: string; email: string }, meta: ClientMeta): Promise<{ secret: string; otpauthUri: string }> {
    return this.inTenant(s.tenantId, s.userId, meta, async (trx) => {
      const existing = await trx.selectFrom('user_mfa_totp').select('confirmed_at').where('user_id', '=', s.userId).executeTakeFirst();
      if (existing?.confirmed_at) throw new ConflictException({ code: 'MFA_ALREADY_ENROLLED', message: 'Two-factor authentication is already enabled' });
      const secret = this.totp.generateSecret();
      const sealed = this.box.seal(secret, aad(s.tenantId, s.userId));
      await trx.deleteFrom('user_mfa_totp').where('user_id', '=', s.userId).execute();
      await trx.insertInto('user_mfa_totp').values({ tenant_id: s.tenantId, user_id: s.userId, secret_enc: sealed, confirmed_at: null, last_used_step: null }).execute();
      await this.audit.record(trx, { action: 'auth.mfa_enroll_started', resourceType: 'staff_user', resourceId: s.userId });
      return { secret, otpauthUri: this.totp.uri(s.email, this.cfg.issuer, secret) };
    });
  }

  async confirmMfa(s: { tenantId: string; userId: string; sessionId: string }, code: string, meta: ClientMeta): Promise<{ recoveryCodes: string[] } | null> {
    return this.inTenant(s.tenantId, s.userId, meta, async (trx) => {
      const row = await trx.selectFrom('user_mfa_totp').selectAll().where('user_id', '=', s.userId).where('confirmed_at', 'is', null).executeTakeFirst();
      if (!row) throw new BadRequestException({ code: 'MFA_NOT_STARTED', message: 'Start enrolment first' });
      const step = this.totp.check(this.box.open(row.secret_enc, aad(s.tenantId, s.userId)), code.trim());
      if (step === null) return null;
      const codes = Array.from({ length: 10 }, () => { const b = randomBytes(8).toString('hex'); return `${b.slice(0, 5)}-${b.slice(5, 10)}`; });
      await trx.updateTable('user_mfa_totp').set({ confirmed_at: sql`now()` as never, last_used_step: String(step) }).where('user_id', '=', s.userId).execute();
      await trx.updateTable('staff_user').set({ mfa_enabled: true }).where('id', '=', s.userId).execute();
      await trx.deleteFrom('user_recovery_code').where('user_id', '=', s.userId).execute();
      await trx.insertInto('user_recovery_code').values(codes.map((c) => ({ tenant_id: s.tenantId, user_id: s.userId, code_hash: sha256(normalizeRecovery(c)), used_at: null }))).execute();
      await trx.updateTable('user_session').set({ mfa_verified_at: sql`now()` as never }).where('id', '=', s.sessionId).execute();
      await this.audit.record(trx, { action: 'auth.mfa_enabled', resourceType: 'staff_user', resourceId: s.userId });
      return { recoveryCodes: codes };
    });
  }

  async acceptInvite(input: { tenant: string; token: string; password: string }, meta: ClientMeta): Promise<void> {
    const tenant = await resolveTenantBySlug(this.db, input.tenant);
    const parsed = parseToken(input.token);
    if (!tenant || !parsed || parsed.tenantId !== tenant.id) { await this.passwords.burn(input.password); throw new BadRequestException({ code: 'INVALID_TOKEN', message: 'This link is invalid or has expired' }); }
    await this.inTenant(tenant.id, undefined, meta, async (trx) => {
      const t = await trx.selectFrom('user_token').selectAll().where('token_hash', '=', parsed.hash).where('used_at', 'is', null).executeTakeFirst();
      if (!t || new Date(t.expires_at).getTime() <= Date.now()) throw new BadRequestException({ code: 'INVALID_TOKEN', message: 'This link is invalid or has expired' });
      const user = await trx.selectFrom('staff_user').selectAll().where('id', '=', t.user_id).executeTakeFirstOrThrow();
      const problems = this.passwords.violations(input.password, { email: user.email, fullName: user.full_name });
      if (problems.length) throw new BadRequestException({ code: 'WEAK_PASSWORD', message: problems.join('; ') });
      const h = await this.passwords.hash(input.password);
      await trx.updateTable('user_token').set({ used_at: sql`now()` as never }).where('id', '=', t.id).execute();
      await trx.updateTable('staff_user').set({ password_hash: h, status: user.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE', password_changed_at: sql`now()` as never, failed_login_count: 0, locked_until: null })
        .where('id', '=', user.id).execute();
      await this.sessions.revokeAllForUser(trx, user.id);
      await runWithTenant({ tenantId: tenant.id, actorId: user.id, requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent },
        () => this.audit.record(trx, { action: t.purpose === 'INVITE' ? 'auth.invite_accepted' : 'auth.password_reset', resourceType: 'staff_user', resourceId: user.id }));
    });
  }

  async changePassword(s: { tenantId: string; userId: string; sessionId: string }, current: string, next: string, meta: ClientMeta): Promise<void> {
    await this.inTenant(s.tenantId, s.userId, meta, async (trx) => {
      const user = await trx.selectFrom('staff_user').selectAll().where('id', '=', s.userId).executeTakeFirstOrThrow();
      if (!user.password_hash || !(await this.passwords.verify(user.password_hash, current))) throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect' });
      const problems = this.passwords.violations(next, { email: user.email, fullName: user.full_name });
      if (problems.length) throw new BadRequestException({ code: 'WEAK_PASSWORD', message: problems.join('; ') });
      await trx.updateTable('staff_user').set({ password_hash: await this.passwords.hash(next), password_changed_at: sql`now()` as never }).where('id', '=', s.userId).execute();
      await this.sessions.revokeAllForUser(trx, s.userId, s.sessionId);
      await this.audit.record(trx, { action: 'auth.password_changed', resourceType: 'staff_user', resourceId: s.userId });
    });
  }

  async logout(s: { tenantId: string; userId: string; sessionId: string }, meta: ClientMeta): Promise<void> {
    await this.inTenant(s.tenantId, s.userId, meta, async (trx) => {
      await this.sessions.revoke(trx, s.sessionId);
      await this.audit.record(trx, { action: 'auth.logout', resourceType: 'user_session', resourceId: s.sessionId });
    });
  }

  async profile(tenantId: string, userId: string) {
    return withTenant(this.db, tenantId, (trx) => trx.selectFrom('staff_user').select(['id', 'email', 'full_name', 'preferred_locale', 'mfa_enabled']).where('id', '=', userId).executeTakeFirstOrThrow());
  }

  async setLocale(s: { tenantId: string; userId: string }, locale: 'en' | 'ur', meta: ClientMeta): Promise<void> {
    await this.inTenant(s.tenantId, s.userId, meta, (trx) => trx.updateTable('staff_user').set({ preferred_locale: locale }).where('id', '=', s.userId).execute().then(() => undefined));
  }
}

