import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException, HttpException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse } from '../common/validate.js';
import { AllowPendingMfa, Authenticated, Public } from '../authz/decorators.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { IdentityService, type ClientMeta } from './identity.service.js';
import { loadIdentityConfig } from './identity.config.js';
import { RateLimiter } from './rate-limiter.js';

const Login = z.object({ tenant: z.string().min(2).max(63), email: z.string().email().max(254), password: z.string().min(1).max(256) });
const AcceptInvite = z.object({ tenant: z.string().min(2).max(63), token: z.string().min(40).max(200), password: z.string().min(1).max(256) });
const Code = z.object({ code: z.string().min(6).max(20) });
const ChangePassword = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) });
const Locale = z.object({ locale: z.enum(['en', 'ur']) });

@Controller('v1/auth')
export class AuthController {
  private readonly cfg = loadIdentityConfig();
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  private meta(req: FastifyRequest, reply: FastifyReply): ClientMeta {
    return { ip: req.ip, userAgent: req.headers['user-agent'], requestId: reply.getHeader('x-correlation-id') as string | undefined };
  }
  private setCookie(reply: FastifyReply, value: string, maxAgeSeconds: number): void {
    reply.header('set-cookie', `${this.cfg.cookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${this.cfg.cookieSecure ? '; Secure' : ''}; Max-Age=${maxAgeSeconds}`);
  }

  @Public() @Post('login') @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const b = parse(Login, body);
    if (!this.limiter.allow(`login:ip:${req.ip}`, 60, 600_000) || !this.limiter.allow(`login:acct:${b.tenant}:${b.email.toLowerCase()}`, 15, 600_000)) {
      throw new HttpException({ code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' }, 429);
    }
    const r = await this.identity.login({ tenant: b.tenant, email: b.email, password: b.password }, this.meta(req, reply));
    this.setCookie(reply, r.token, this.cfg.absoluteHours * 3600);
    return { state: r.state, csrfToken: r.csrfToken, user: r.user };
  }

  @Public() @Post('accept-invite') @HttpCode(204)
  async acceptInvite(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const b = parse(AcceptInvite, body);
    if (!this.limiter.allow(`invite:ip:${req.ip}`, 20, 600_000)) throw new HttpException({ code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' }, 429);
    await this.identity.acceptInvite(b, this.meta(req, reply));
  }

  @Authenticated() @AllowPendingMfa() @Post('logout') @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const c = currentTenant();
    await this.identity.logout({ tenantId: c.tenantId, userId: c.actorId!, sessionId: c.sessionId! }, this.meta(req, reply));
    this.setCookie(reply, '', 0);
  }

  @Authenticated() @Get('me')
  async me() {
    const c = currentTenant();
    const [profile, grants] = await Promise.all([this.identity.profile(c.tenantId, c.actorId!), this.authz.loadGrants(c.actorId!)]);
    return {
      user: { id: profile.id, email: profile.email, fullName: profile.full_name, locale: profile.preferred_locale, mfaEnabled: profile.mfa_enabled },
      session: { state: c.sessionState, mfaVerifiedAt: c.mfaVerifiedAt ?? null },
      csrfToken: c.csrfToken ?? null,          // lets a reloaded app resume with the same session; the cookie itself stays HttpOnly
      // UI hints only — the server re-checks every request.
      grants: grants.map((g) => ({ permission: g.permission, scopeType: g.scopeType, scopeId: g.scopeId })),
    };
  }

  /** Completes login (pending MFA) or performs step-up for sensitive actions. TOTP or a recovery code. */
  @Authenticated() @AllowPendingMfa() @Post('mfa/verify') @HttpCode(200)
  async verify(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const c = currentTenant();
    const { code } = parse(Code, body);
    const ok = await this.identity.verifyMfa({ tenantId: c.tenantId, userId: c.actorId!, sessionId: c.sessionId! }, code, this.meta(req, reply));
    if (!ok) throw new UnauthorizedException({ code: 'INVALID_CODE', message: 'Invalid or expired code' });
    return { verified: true };
  }

  @Authenticated() @Post('mfa/enroll') @HttpCode(200)
  async enroll(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const c = currentTenant();
    const profile = await this.identity.profile(c.tenantId, c.actorId!);
    return this.identity.enrollMfa({ tenantId: c.tenantId, userId: c.actorId!, email: profile.email }, this.meta(req, reply));
  }

  @Authenticated() @Post('mfa/confirm') @HttpCode(200)
  async confirm(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const c = currentTenant();
    const { code } = parse(Code, body);
    const r = await this.identity.confirmMfa({ tenantId: c.tenantId, userId: c.actorId!, sessionId: c.sessionId! }, code, this.meta(req, reply));
    if (!r) throw new UnauthorizedException({ code: 'INVALID_CODE', message: 'Invalid or expired code' });
    return r; // recovery codes are shown exactly once
  }

  @Authenticated() @Post('password/change') @HttpCode(204)
  async changePassword(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const c = currentTenant();
    const b = parse(ChangePassword, body);
    await this.identity.changePassword({ tenantId: c.tenantId, userId: c.actorId!, sessionId: c.sessionId! }, b.currentPassword, b.newPassword, this.meta(req, reply));
  }

  /** Staff language preference (English / Urdu). */
  @Authenticated() @Post('locale') @HttpCode(204)
  async locale(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const c = currentTenant();
    await this.identity.setLocale({ tenantId: c.tenantId, userId: c.actorId! }, parse(Locale, body).locale, this.meta(req, reply));
  }
}
