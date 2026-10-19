import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// Argon2id parameters (OWASP-aligned minimum: m=19 MiB, t=2, p=1). Tune upward on production hardware.
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1, algorithm: 2 /* Argon2id */ } as const;

const COMMON = new Set(['password1234', 'passwordpassword', '123456789012', 'qwertyuiop12', 'welcome12345', 'sunset123456', 'hospitality123', 'letmein123456', 'admin1234567']);

export interface PasswordPolicyContext { email?: string; fullName?: string }

@Injectable()
export class PasswordService {
  /** A valid hash of a random string, verified on unknown-user logins so response time doesn't reveal which accounts exist. */
  private dummy: Promise<string> = hash(`dummy-${Math.random()}-${Date.now()}`, OPTS);

  hash(password: string): Promise<string> { return hash(password, OPTS); }

  async verify(storedHash: string, password: string): Promise<boolean> {
    try { return await verify(storedHash, password); } catch { return false; }
  }

  async burn(password: string): Promise<void> { await this.verify(await this.dummy, password); }

  /** Returns a list of policy violations (empty = acceptable). Length-first policy per NIST 800-63B; no composition rules. */
  violations(password: string, ctx: PasswordPolicyContext = {}): string[] {
    const v: string[] = [];
    if (password.length < 12) v.push('Use at least 12 characters');
    if (password.length > 128) v.push('Use at most 128 characters');
    const lower = password.toLowerCase();
    if (COMMON.has(lower)) v.push('This password is too common');
    if (/^(.)\1+$/.test(password)) v.push('Password cannot be a single repeated character');
    const local = ctx.email?.split('@')[0]?.toLowerCase();
    if (local && local.length >= 4 && lower.includes(local)) v.push('Password must not contain your email name');
    return v;
  }
}
