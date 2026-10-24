import { createVerify, X509Certificate } from 'node:crypto';

/** What Amazon SNS posts to a web address: a signed JSON message. Only messages signed by Amazon, for our own topic, are believed. */
export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation'; MessageId: string; TopicArn: string; Message: string; Timestamp: string; SignatureVersion: string; Signature: string; SigningCertURL: string;
  Subject?: string; Token?: string; SubscribeURL?: string;
}

const HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
export const isAmazonUrl = (u: string): boolean => { try { const x = new URL(u); return x.protocol === 'https:' && HOST.test(x.hostname) && !x.port && !x.username; } catch { return false; } };

/** The exact text Amazon signed (field order is fixed by the SNS specification). */
export function stringToSign(m: SnsMessage): string {
  const keys = m.Type === 'Notification' ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.filter((k) => (m as unknown as Record<string, unknown>)[k] !== undefined).map((k) => `${k}\n${(m as unknown as Record<string, string>)[k]}\n`).join('');
}

export type CertFetcher = (url: string) => Promise<string>;
export const fetchCert: CertFetcher = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!r.ok) throw new Error('certificate not available');
  return r.text();
};

export async function verifySns(m: SnsMessage, get: CertFetcher = fetchCert): Promise<boolean> {
  if (!m || typeof m.Signature !== 'string' || !['1', '2'].includes(m.SignatureVersion) || !isAmazonUrl(m.SigningCertURL) || !m.SigningCertURL.endsWith('.pem')) return false;
  try {
    const pem = await get(m.SigningCertURL);
    const cert = new X509Certificate(pem);
    const v = createVerify(m.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1');
    v.update(stringToSign(m));
    return v.verify(cert.publicKey, m.Signature, 'base64');
  } catch { return false; }
}
