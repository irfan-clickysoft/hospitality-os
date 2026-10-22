import { createHmac, hkdfSync } from 'node:crypto';
import { UnprocessableEntityException } from '@nestjs/common';

export type IdType = 'CNIC' | 'NICOP' | 'PASSPORT' | 'DRIVING_LICENSE' | 'OTHER';

const bad = (message: string) => new UnprocessableEntityException({ code: 'ID_INVALID', message });

/** Normalises and validates a document number as typed at the desk. Returns the canonical form that is stored (encrypted). */
export function normaliseIdNumber(type: IdType, raw: string): string {
  const s = raw.trim();
  switch (type) {
    case 'CNIC':
    case 'NICOP': {
      const digits = s.replace(/[\s-]/g, '');
      if (!/^\d{13}$/.test(digits)) throw bad(`A ${type} number has 13 digits (like 35202-1234567-1)`);
      return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
    }
    case 'PASSPORT': {
      const v = s.replace(/\s/g, '').toUpperCase();
      if (!/^[A-Z0-9]{5,15}$/.test(v)) throw bad('A passport number has 5–15 letters and digits');
      return v;
    }
    default: {
      const v = s.replace(/\s+/g, ' ');
      if (!/^[A-Za-z0-9][A-Za-z0-9 /.-]{3,29}$/.test(v)) throw bad('Enter the document number as printed on it (4–30 characters)');
      return v.toUpperCase();
    }
  }
}

export const last4 = (canonical: string): string => canonical.replace(/[^A-Za-z0-9]/g, '').slice(-4);
export const maskId = (type: IdType, l4: string): string => (type === 'CNIC' || type === 'NICOP' ? `*****-*******-${l4.slice(-1)}` : `*****${l4}`);

const indexKey = () => Buffer.from(hkdfSync('sha256', Buffer.from(process.env.APP_ENCRYPTION_KEY ?? '', 'base64'), Buffer.alloc(0), 'hos-id-index-v1', 32));
const klass = (t: IdType) => (t === 'CNIC' || t === 'NICOP' ? 'NATIONAL' : t === 'PASSPORT' ? 'PASSPORT' : 'OTHER');
/** A keyed hash of a document, so the desk can ask "who has this ID" without the number being stored readable. A CNIC and a NICOP number are the same kind of number. */
export const idHash = (type: IdType, canonical: string): string => createHmac('sha256', indexKey()).update(`${klass(type)}:${canonical}`).digest('hex');

/** Every document a typed search could mean, as hashes to look up: nothing is returned for text that cannot be an ID number. */
export function idSearchHashes(raw: string): string[] {
  const out: string[] = [];
  for (const type of ['CNIC', 'PASSPORT', 'OTHER'] as const) {
    try { out.push(idHash(type, normaliseIdNumber(type, raw))); } catch { /* not that kind of number */ }
  }
  return [...new Set(out)];
}
