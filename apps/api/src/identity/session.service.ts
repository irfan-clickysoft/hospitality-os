import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { withTenant, type DB } from '@hos/db';
import { DB_APP } from '../db/db.module.js';
import { loadIdentityConfig } from './identity.config.js';
import { newToken, parseToken, randomUrlToken } from './tokens.js';

export interface SessionInfo {
  sessionId: string; tenantId: string; userId: string; state: 'PENDING_MFA' | 'ACTIVE'; mfaVerifiedAt: Date | null; csrfToken: string;
}

@Injectable()
export class SessionService {
  private readonly cfg = loadIdentityConfig();
  constructor(@Inject(DB_APP) private readonly db: Kysely<DB>) {}

  async create(trx: Transaction<DB>, tenantId: string, userId: string, state: 'PENDING_MFA' | 'ACTIVE', meta: { ip?: string; userAgent?: string }) {
    const { token, hash } = newToken(tenantId);
    const csrf = randomUrlToken(24);
    const now = Date.now();
    const row = await trx.insertInto('user_session').values({
      tenant_id: tenantId, user_id: userId, token_hash: hash, csrf_token: csrf, state,
      idle_expires_at: new Date(now + this.cfg.idleMinutes * 60_000), absolute_expires_at: new Date(now + this.cfg.absoluteHours * 3_600_000),
      mfa_verified_at: null, revoked_at: null, ip: meta.ip ?? null, user_agent: meta.userAgent?.slice(0, 300) ?? null,
    }).returning('id').executeTakeFirstOrThrow();
    return { token, csrfToken: csrf, sessionId: row.id };
  }

  /** Validates an opaque token; extends the idle window (at most once a minute). Returns null for anything invalid, expired or revoked. */
  async validate(token: string | undefined): Promise<SessionInfo | null> {
    const parsed = parseToken(token);
    if (!parsed) return null;
    return withTenant(this.db, parsed.tenantId, async (trx) => {
      const row = await trx.selectFrom('user_session as s').innerJoin('staff_user as u', (j) => j.onRef('u.tenant_id', '=', 's.tenant_id').onRef('u.id', '=', 's.user_id'))
        .select(['s.id', 's.user_id', 's.state', 's.mfa_verified_at', 's.csrf_token', 's.idle_expires_at', 's.absolute_expires_at', 's.revoked_at', 's.last_seen_at', 'u.status as user_status'])
        .where('s.token_hash', '=', parsed.hash).executeTakeFirst();
      if (!row || row.revoked_at || row.user_status !== 'ACTIVE') return null;
      const now = Date.now();
      if (new Date(row.idle_expires_at).getTime() <= now || new Date(row.absolute_expires_at).getTime() <= now) return null;
      if (now - new Date(row.last_seen_at).getTime() > 60_000) {
        const idle = Math.min(now + this.cfg.idleMinutes * 60_000, new Date(row.absolute_expires_at).getTime());
        await trx.updateTable('user_session').set({ last_seen_at: new Date(now), idle_expires_at: new Date(idle) }).where('id', '=', row.id).execute();
      }
      return { sessionId: row.id, tenantId: parsed.tenantId, userId: row.user_id, state: row.state, mfaVerifiedAt: row.mfa_verified_at ? new Date(row.mfa_verified_at) : null, csrfToken: row.csrf_token };
    });
  }

  revoke(trx: Transaction<DB>, sessionId: string) {
    return trx.updateTable('user_session').set({ revoked_at: sql`now()` as never }).where('id', '=', sessionId).where('revoked_at', 'is', null).execute();
  }

  revokeAllForUser(trx: Transaction<DB>, userId: string, exceptSessionId?: string) {
    let q = trx.updateTable('user_session').set({ revoked_at: sql`now()` as never }).where('user_id', '=', userId).where('revoked_at', 'is', null);
    if (exceptSessionId) q = q.where('id', '!=', exceptSessionId);
    return q.execute();
  }
}
