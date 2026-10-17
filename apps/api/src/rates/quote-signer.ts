import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { HttpException, Injectable } from '@nestjs/common';
import { currentTenant } from '../tenancy/tenant-context.js';

export interface QuoteClaims {
  tenantId: string; propertyId: string; planId: string; roomTypeId: string; arrival: string; departure: string; adults: number; children: number; extraBeds: number;
  channel: string; residency: string; companyId: string | null; currency: string; subtotalMinor: string; discountPct: number; discountApproved: boolean;
  depositDueMinor: string; nightsHash: string; exp: number;
}

/** HMAC-signed, short-lived price quote. Booking must present it so a client can never choose its own price. */
@Injectable()
export class QuoteSigner {
  private readonly key: Buffer = Buffer.from(hkdfSync('sha256', Buffer.from(process.env.APP_ENCRYPTION_KEY ?? '', 'base64'), Buffer.alloc(0), 'hos-quote-signing-v1', 32));
  private mac(body: string) { return createHmac('sha256', this.key).update(body).digest(); }

  sign(c: Omit<QuoteClaims, 'tenantId' | 'exp'>, ttlSeconds = 900, now = Date.now()): string {
    const body = Buffer.from(JSON.stringify({ ...c, tenantId: currentTenant().tenantId, exp: Math.floor(now / 1000) + ttlSeconds })).toString('base64url');
    return `${body}.${this.mac(body).toString('base64url')}`;
  }
  verify(token: string, now = Date.now()): QuoteClaims {
    const bad = () => new HttpException({ code: 'QUOTE_INVALID', message: 'This quote is invalid or has expired. Search again.' }, 422);
    const [body, sig] = token.split('.');
    if (!body || !sig) throw bad();
    const want = this.mac(body), got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw bad();
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as QuoteClaims;
    if (c.exp * 1000 < now || c.tenantId !== currentTenant().tenantId) throw bad();
    return c;
  }
}
