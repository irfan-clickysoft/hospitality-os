import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money, newKey } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { Badge, ErrorLine, Sheet } from '../ui/kit.js';
import type { Amount } from './types.js';

export interface CompanyLite { id: string; name: string; status: string; creditLimit: Amount; owed?: Amount; available?: Amount; termsDays: number }
export interface Billing { id: string; companyId: string; companyName: string; amount: Amount; open: Amount; billedOn: string; dueOn: string; status: string; overdue: boolean; overrideReason: string | null }
const tone = (s: string) => (s === 'PAID' ? 'clean' : s === 'CANCELLED' ? 'neutral' : s === 'PART_PAID' ? 'warn' : 'cleaning') as 'clean' | 'neutral' | 'warn' | 'cleaning';

/** What has been put on a company’s account for this stay, and the buttons to bill more or take it back. */
export function CompanyBillings({ reservationId, companyId, balance, folioOpen, onChanged }: { reservationId: string; companyId: string | null; balance: Amount | null; folioOpen: boolean; onChanged: () => void }) {
  const { t } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const list = useLive<{ items: Billing[] }>(`${base}/reservations/${reservationId}/company-billings`, 30_000);
  const [dialog, setDialog] = useState<'bill' | Billing | null>(null);
  const items = list.data?.items ?? [];
  const owing = !!balance && !balance.amount.startsWith('-') && balance.amount !== '0.00';
  if (!can('ar.bill') && items.length === 0) return null;
  const done = () => { list.reload(); onChanged(); setDialog(null); };
  return (
    <div className="stack">
      <h3>{t('ar.onAccount')}</h3>
      {items.length === 0 && <p className="muted small">{t('common.none')}</p>}
      <ul className="plain">{items.map((i) => (
        <li key={i.id} className="card inner small stack">
          <div className="row between"><strong>{i.companyName}</strong><strong>{money(i.amount)}</strong></div>
          <div className="row between"><span className="muted">{i.billedOn} → {t('ar.due', { date: i.dueOn })}</span><Badge tone={i.overdue ? 'dirty' : tone(i.status)}>{i.overdue ? t('ar.overdue') : t(`ar.s.${i.status}` as Key)}</Badge></div>
          {i.overrideReason && <span className="muted">{t('ar.overrideNote')}: {i.overrideReason}</span>}
          {i.status === 'OPEN' && can('folio.adjust') && <button className="link" onClick={() => setDialog(i)}>{t('ar.cancelBilling')}</button>}
        </li>))}</ul>
      {can('ar.bill') && folioOpen && owing && <div className="actions"><button onClick={() => setDialog('bill')}>{t('ar.bill')}</button></div>}
      {dialog === 'bill' && <BillSheet reservationId={reservationId} companyId={companyId} balance={balance!} onDone={done} onClose={() => setDialog(null)} />}
      {dialog && dialog !== 'bill' && <VoidSheet item={dialog} onDone={done} onClose={() => setDialog(null)} />}
    </div>
  );
}

function BillSheet({ reservationId, companyId, balance, onDone, onClose }: { reservationId: string; companyId: string | null; balance: Amount; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property, can } = useAuth();
  const withStepUp = useStepUp();
  const cos = useLive<{ items: CompanyLite[] }>(can('company.view') ? '/v1/companies' : null, 120_000);
  const [pick, setPick] = useState(companyId ?? ''); const [amount, setAmount] = useState(''); const [note, setNote] = useState(''); const [why, setWhy] = useState('');
  const key = useState(newKey)[0];
  const { busy, problem, run, clear } = useAction();
  const choices = (cos.data?.items ?? []).filter((c) => c.status !== 'ARCHIVED');
  const chosen = choices.find((c) => c.id === pick);
  const needsOverride = problem?.code === 'CREDIT_LIMIT_EXCEEDED' || problem?.code === 'COMPANY_ON_HOLD';
  const go = async (override: boolean) => {
    const body = { ...(pick ? { companyId: pick } : {}), ...(amount.trim() ? { amount: amount.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}), ...(override ? { override: { reason: why.trim() } } : {}) };
    const call = () => api('POST', `/v1/properties/${property!.id}/reservations/${reservationId}/bill-to-company`, body, { 'idempotency-key': key });
    if (await run(() => override ? withStepUp(call) : call())) onDone();
  };
  return (
    <Sheet title={t('ar.bill')} onClose={onClose}>
      <p className="muted small">{t('ar.billHelp', { balance: money(balance) })}</p>
      <label>{t('ar.company')}<select value={pick} onChange={(e) => { setPick(e.target.value); clear(); }}><option value="">{t('ar.choose')}</option>{choices.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === 'ON_HOLD' ? ` (${t('co.s.ON_HOLD')})` : ''}</option>)}</select></label>
      {chosen?.available && <p className="muted small">{t('ar.available', { amount: money(chosen.available) })} · {t('ar.terms', { n: chosen.termsDays })}</p>}
      <label>{t('ar.amount')}<input inputMode="decimal" value={amount} placeholder={balance.amount} onChange={(e) => setAmount(e.target.value)} dir="ltr" /></label>
      <label>{t('common.note')}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {needsOverride && (can('ar.override_credit')
        ? <div className="card inner stack"><label>{t('ar.overrideReason')}<input value={why} onChange={(e) => setWhy(e.target.value)} /></label><button disabled={busy || why.trim().length < 3} onClick={() => go(true)}>{t('ar.override')}</button></div>
        : <p className="warnbox">{t('ar.askManager')}</p>)}
      <div className="actions"><button className="primary" disabled={busy || !pick} onClick={() => go(false)}>{t('ar.bill')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function VoidSheet({ item, onDone, onClose }: { item: Billing; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const withStepUp = useStepUp();
  const [reason, setReason] = useState('');
  const { busy, problem, run } = useAction();
  const go = async () => { if (await run(() => withStepUp(() => api('POST', `/v1/properties/${property!.id}/ar-items/${item.id}/void`, { reason: reason.trim() })))) onDone(); };
  return (
    <Sheet title={`${t('ar.cancelBilling')} · ${item.companyName}`} onClose={onClose}>
      <p className="warnbox">{t('ar.cancelHelp', { amount: money(item.amount) })}</p>
      <label>{t('common.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || reason.trim().length < 3} onClick={go}>{t('ar.cancelBilling')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}
