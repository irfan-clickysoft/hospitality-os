import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Opaque token `<tenantId>.<256-bit random>`: the tenant prefix lets us set RLS context before the (hashed) lookup; it is not trusted by itself. */
export function newToken(tenantId: string): { token: string; hash: Buffer } {
  const token = `${tenantId}.${randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

export function parseToken(token: string | undefined): { tenantId: string; hash: Buffer } | null {
  if (!token || token.length > 200) return null;
  const dot = token.indexOf('.');
  if (dot !== 36) return null;
  const tenantId = token.slice(0, dot);
  if (!UUID.test(tenantId) || token.length < 60) return null;
  return { tenantId, hash: sha256(token) };
}

export const randomUrlToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
