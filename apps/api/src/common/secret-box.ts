import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for secrets stored in the database (e.g., TOTP seeds). Format: v1:<iv>:<tag>:<ciphertext> (base64url).
 * The key comes from APP_ENCRYPTION_KEY (32 random bytes, base64) — in production injected from AWS Secrets Manager / KMS.
 */
export class SecretBox {
  private readonly key: Buffer;
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  }
  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretBox {
    if (!env.APP_ENCRYPTION_KEY) throw new Error('APP_ENCRYPTION_KEY is required');
    return new SecretBox(env.APP_ENCRYPTION_KEY);
  }
  seal(plain: string, aad = ''): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
  }
  open(sealed: string, aad = ''): string {
    const [v, iv, tag, ct] = sealed.split(':');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported secret envelope');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }
}
