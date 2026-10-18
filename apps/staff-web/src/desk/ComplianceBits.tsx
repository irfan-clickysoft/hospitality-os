import { useState } from 'react';
import { useT } from '../i18n/index.js';
import { useAuth } from '../state.js';
import type { Problem } from '../ui/kit.js';

export interface Hit { name: string; action: string; message: string; messageUr?: string | null; approved?: boolean }

/** What a rule says, in the staff member’s language where the rule has Urdu wording. */
export function ComplianceNotes({ hits }: { hits: Hit[] }) {
  const { t, locale } = useT();
  if (!hits.length) return null;
  return (
    <div className="stack" role="status">
      {hits.map((h) => (
        <p key={h.name + h.action} className={h.action === 'INFO' ? 'muted small' : 'warnbox'}>
          <strong>{t(`cmp.a.${h.action}` as never) as string}</strong> · {locale === 'ur' && h.messageUr ? h.messageUr : h.message}{h.approved ? ` ✓ ${t('cmp.approved')}` : ''}
        </p>))}
    </div>
  );
}

/** Shown when a rule holds a booking or check-in for a manager’s approval: the manager gives a reason and approves (second factor asked on the spot). */
export function ApprovalBox({ problem, busy, onApprove }: { problem: Problem | null; busy: boolean; onApprove: (reason: string) => void }) {
  const { t } = useT();
  const { can } = useAuth();
  const [reason, setReason] = useState('');
  if (problem?.code !== 'COMPLIANCE_APPROVAL_REQUIRED') return null;
  return can('compliance.approve')
    ? <div className="card inner stack"><label>{t('cmp.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label><button disabled={busy || reason.trim().length < 3} onClick={() => onApprove(reason.trim())}>{t('cmp.approve')}</button></div>
    : <p className="warnbox">{t('cmp.askManager')}</p>;
}
