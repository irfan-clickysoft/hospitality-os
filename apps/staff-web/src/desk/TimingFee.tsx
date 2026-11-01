import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth } from '../state.js';
import { ErrorLine } from './../ui/kit.js';
import type { Amount } from './types.js';

type Kind = 'EARLY_CHECKIN' | 'LATE_CHECKOUT';
interface Info { kind: Kind; applies: boolean; standardTime: string; localTime: string; minutes: number; percent: number; night: Amount; suggested: Amount; requested: { time: string | null; status: string } | null; required: boolean; decided: { action: 'CHARGE' | 'WAIVE'; charged: Amount; waived: Amount; reason: string | null } | null }
const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim() : `${m} min`);

/**
 * Shown when a guest arrives before the standard check-in time or leaves after the standard checkout time. If the property charges for it, the desk charges the suggested fee,
 * a different amount, or waives it with a reason — and that decision is kept and shown in the report. `onState(true)` while a decision is still needed.
 */
export function TimingFeeBox({ kind, reservationId, lineId, onState, onDecided }: { kind: Kind; reservationId: string; lineId: string; onState: (blocked: boolean) => void; onDecided: () => void }) {
  const { t } = useT(); const { property, can } = useAuth(); const withStepUp = useStepUp(); const { busy, problem, run } = useAction();
  const base = `/v1/properties/${property!.id}/reservations/${reservationId}/rooms/${lineId}/timing-fee`;
  const [info, setInfo] = useState<Info | null>(null); const [mode, setMode] = useState<'' | 'other' | 'waive'>(''); const [amount, setAmount] = useState(''); const [why, setWhy] = useState('');
  const load = useCallback(() => api<Info>('GET', `${base}?kind=${kind}`).then((r) => { setInfo(r); onState(r.required); }).catch(() => { setInfo(null); onState(false); }), [base, kind]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  if (!info || (!info.applies && !info.decided)) return null;
  const word = kind === 'EARLY_CHECKIN' ? 'early' : 'late';
  const send = async (body: Record<string, unknown>, sensitive: boolean) => { const r = await run(() => (sensitive ? withStepUp(() => api('POST', base, { kind, ...body })) : api('POST', base, { kind, ...body }))); if (r) { setMode(''); setAmount(''); setWhy(''); await load(); onDecided(); } };
  const suggested = Number(info.suggested.amount) > 0;
  return (
    <div className="card inner stack" role="group" aria-label={t(`tf.title.${kind}` as never)}>
      <strong>{t(`tf.title.${kind}` as never)}</strong>
      <p className="small">{t(`tf.line.${word}` as never, { time: hm(info.minutes), std: info.standardTime })}{info.requested ? ` ${t('tf.asked', { time: info.requested.time ?? '—' })}` : ''}</p>
      {info.decided ? <p className="ok small" role="status">✓ {info.decided.action === 'CHARGE' ? t('tf.charged', { amt: money(info.decided.charged) }) : t('tf.waived', { amt: money(info.decided.waived) })}{info.decided.reason ? ` — ${info.decided.reason}` : ''}</p> : (<>
        <p className="small">{suggested ? t('tf.suggested', { pct: info.percent, amt: money(info.suggested), night: money(info.night) }) : t('tf.noFee')}</p>
        <div className="actions">
          {suggested && <button className="primary" disabled={busy} onClick={() => void send({ action: 'CHARGE' }, false)}>{t('tf.charge', { amt: money(info.suggested) })}</button>}
          {can('reservation.override_rate') && <button disabled={busy} onClick={() => setMode(mode === 'other' ? '' : 'other')}>{t('tf.other')}</button>}
          {suggested && can('reservation.waive_fee') && <button disabled={busy} onClick={() => setMode(mode === 'waive' ? '' : 'waive')}>{t('tf.waive')}</button>}
        </div>
        {suggested && !can('reservation.waive_fee') && <p className="muted small">{t('tf.askManager')}</p>}
        {mode === 'other' && <div className="stack"><label>{t('tf.amount')}<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr" /></label><label>{t('dm.reason')}<input value={why} onChange={(e) => setWhy(e.target.value)} /></label>
          <button className="primary" disabled={busy || !/^\d{1,9}(\.\d{1,2})?$/.test(amount.trim()) || Number(amount) <= 0 || why.trim().length < 3} onClick={() => void send({ action: 'CHARGE', amount: amount.trim(), reason: why.trim() }, true)}>{t('tf.chargeOther')}</button></div>}
        {mode === 'waive' && <div className="stack"><label>{t('dm.reason')}<input value={why} onChange={(e) => setWhy(e.target.value)} /></label><button className="primary" disabled={busy || why.trim().length < 3} onClick={() => void send({ action: 'WAIVE', reason: why.trim() }, true)}>{t('tf.waiveConfirm')}</button></div>}
        {info.required && <p className="warnbox small" role="status">{t('tf.mustDecide')}</p>}
      </>)}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </div>
  );
}
