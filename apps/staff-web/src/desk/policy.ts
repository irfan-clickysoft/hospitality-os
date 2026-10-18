import type { Key } from '../i18n/en.js';
import { money } from '../lib/format.js';

type T = (k: Key, v?: Record<string, string | number>) => string;
interface Rule { feeType?: string; feeValue?: number; type?: string; value?: number; freeUntilHoursBefore?: number; dueWithinHours?: number }
const fee = (t: T, type: string | undefined, value: number | undefined): string => (type === 'NIGHTS' ? t('pol.nights', { n: value ?? 0 }) : type === 'PERCENT' ? `${(value ?? 0) / 100}%` : money(((value ?? 0) / 100).toFixed(2)));

/** One plain sentence per rule, from the policy snapshot the quote carries. */
export function policyLines(t: T, p: { cancellationRule?: Rule | null; noShowRule?: Rule | null; depositRule?: Rule | null } | undefined): string[] {
  const out: string[] = [];
  if (p?.cancellationRule) out.push(t('pol.cancel', { h: p.cancellationRule.freeUntilHoursBefore ?? 0, fee: fee(t, p.cancellationRule.feeType, p.cancellationRule.feeValue) }));
  if (p?.noShowRule) out.push(t('pol.noshow', { fee: fee(t, p.noShowRule.feeType, p.noShowRule.feeValue) }));
  if (p?.depositRule) out.push(t('pol.deposit', { fee: fee(t, p.depositRule.type, p.depositRule.value) }));
  return out;
}
