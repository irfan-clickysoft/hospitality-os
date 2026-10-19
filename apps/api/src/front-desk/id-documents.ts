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
