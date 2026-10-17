import { createHmac, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { base32Decode, base32Encode } from './base32.js';

const STEP_SECONDS = 30;
const DIGITS = 6;

/** RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits) — the profile every authenticator app supports. Verified against the RFC test vectors. */
@Injectable()
export class TotpService {
  generateSecret(): string { return base32Encode(randomBytes(20)); }

  uri(account: string, issuer: string, secret: string): string {
    return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
  }

  codeAtStep(secretBase32: string, step: number): string {
    const key = base32Decode(secretBase32);
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(step));
    const h = createHmac('sha1', key).update(msg).digest();
    const off = h[h.length - 1]! & 0x0f;
    const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
    return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
  }

  /** Returns the matched time-step (±1 step tolerance) or null. Callers must reject steps <= the last accepted step (replay). */
  check(secretBase32: string, code: string, nowMs = Date.now()): number | null {
    if (!/^\d{6}$/.test(code)) return null;
    const step = Math.floor(nowMs / 1000 / STEP_SECONDS);
    let matched: number | null = null;
    for (const s of [step, step - 1, step + 1]) { if (this.codeAtStep(secretBase32, s) === code && matched === null) matched = s; }
    return matched;
  }
}
