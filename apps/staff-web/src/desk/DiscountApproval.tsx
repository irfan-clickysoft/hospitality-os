import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { useAuth } from '../state.js';
import { ErrorLine } from '../ui/kit.js';
import { Field } from '../ui/ds.js';

export const DISCOUNT_CODES = ['NEGOTIATED', 'CORPORATE', 'LONG_STAY', 'LOYALTY', 'PROMOTION', 'LAST_MINUTE', 'SERVICE_RECOVERY', 'STAFF_FRIENDS', 'MANAGER_DISCRETION', 'COMPLIMENTARY', 'HOUSE_USE', 'OTHER'] as const;
export interface DiscountWhy { code: string; note: string }
export const noWhy: DiscountWhy = { code: '', note: '' };
export const whyBody = (w: DiscountWhy) => (w.code ? { code: w.code, ...(w.note.trim() ? { note: w.note.trim() } : {}) } : undefined);

/** Why this discount is being given: a standard reason, and the desk's own words. */
export function DiscountReasonField({ value, onChange }: { value: DiscountWhy; onChange: (w: DiscountWhy) => void }) {
  const { t } = useT();
  return (
    <div className="grid2">
      <Field label={t('dr.why')} required>{(p) => <select {...p} value={value.code} onChange={(e) => onChange({ ...value, code: e.target.value })}><option value="">—</option>{DISCOUNT_CODES.map((c) => <option key={c} value={c}>{t(`dr.c.${c}` as Key)}</option>)}</select>}</Field>
      <Field label={`${t('dr.note')} (${t('common.optional')})`}>{(p) => <input {...p} value={value.note} maxLength={300} onChange={(e) => onChange({ ...value, note: e.target.value })} />}</Field>
    </div>
  );
}

export interface Approval { id: string; status: string }

/**
 * A discount above what the person at the desk may give: ask a manager. The request is the exact price being asked for; once approved it is used once, for that price only.
 * While waiting the desk can carry on with other work; the state is checked every few seconds.
 */
export function ApprovalAsk({ quote, roomTypeId, planId, rooms, why, approval, onChange }: { quote: Record<string, unknown>; roomTypeId: string; planId: string; rooms: number; why: DiscountWhy; approval: Approval | null; onChange: (a: Approval | null) => void }) {
  const { t } = useT(); const { property } = useAuth(); const { busy, problem, run } = useAction();
  const base = `/v1/properties/${property!.id}/discount-approvals`;
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!approval || !['PENDING'].includes(approval.status)) return;
    const h = setInterval(() => { api<{ status: string; decisionNote: string | null }>('GET', `${base}/${approval.id}`).then((r) => { if (r.status !== approval.status) { setNote(r.decisionNote ?? ''); onChange({ id: approval.id, status: r.status }); } }).catch(() => undefined); }, 8000);
    return () => clearInterval(h);
  }, [approval, base, onChange]);
  const send = async () => { const r = await run(() => api<{ id: string; status: string }>('POST', base, { quote, roomTypeId, planId, rooms, reason: whyBody(why) })); if (r) onChange({ id: r.id, status: r.status }); };
  if (approval?.status === 'APPROVED') return <p className="ok small" role="status">✓ {t('dr.approved')}</p>;
  return (
    <div className="warnbox stack" role="group" aria-label={t('dr.askTitle')}>
      <strong>{t('dr.askTitle')}</strong>
      {!approval && <><p className="small">{t('dr.askHelp')}</p><button className="primary" disabled={busy || !why.code} onClick={send}>{t('dr.ask')}</button>{!why.code && <p className="muted small">{t('dr.chooseReasonFirst')}</p>}</>}
      {approval?.status === 'PENDING' && <><p className="small" role="status">{t('dr.waiting')}</p><button className="link" onClick={async () => { if (await run(() => api('POST', `${base}/${approval.id}/withdraw`, {}))) onChange(null); }}>{t('dr.withdraw')}</button></>}
      {approval && ['REJECTED', 'CANCELLED', 'EXPIRED'].includes(approval.status) && <><p className="small" role="status">{approval.status === 'REJECTED' ? `${t('dr.rejected')}${note ? `: ${note}` : ''}` : t('dr.expired')}</p><button onClick={() => onChange(null)}>{t('dr.askAgain')}</button></>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </div>
  );
}
