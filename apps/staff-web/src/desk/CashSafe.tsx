import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';

interface Safe {
  balance: Amount; collected: Amount; handedOver: Amount;
  envelopes: Array<{ date: string; register: string; sessions: number; amount: Amount; variance: Amount }>;
  handovers: Array<{ id: string; date: string; amount: Amount; difference: Amount; receivedBy: string; receivedByTitle: string | null; note: string | null }>;
}

/** The property's safe: daily envelopes from the closed registers, what is still in it, and the weekly handover to head office. */
export function CashSafe() {
  const { t } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/cash-safe`;
  const safe = useLive<Safe>(can('cashier.review') ? base : null, 60_000);
  const [dlg, setDlg] = useState(false);
  if (!can('cashier.review')) return null;
  if (!safe.data) return <Spinner />;
  const s = safe.data;
  return (
    <div className="card stack">
      <div className="row between"><strong>{t('safe.title')}</strong><strong>{money(s.balance)}</strong></div>
      <p className="muted small">{t('safe.help')}</p>
      {can('cashier.handover') && <div className="actions"><button disabled={s.balance.amount === '0.00'} onClick={() => setDlg(true)}>{t('safe.handover')}</button></div>}
      <h3>{t('safe.envelopes')}</h3>
      {s.envelopes.length === 0 ? <p className="muted small">{t('common.none')}</p> : (
        <ul className="plain small">{s.envelopes.slice(0, 14).map((e, i) => <li key={`${e.date}${e.register}${i}`} className="row between"><span>{e.date} · {e.register}</span><span>{money(e.amount)}{e.variance.amount !== '0.00' ? <span className="muted"> ({t('safe.variance')} {money(e.variance)})</span> : null}</span></li>)}</ul>)}
      <h3>{t('safe.handovers')}</h3>
      {s.handovers.length === 0 ? <p className="muted small">{t('common.none')}</p> : (
        <ul className="plain small">{s.handovers.map((h) => <li key={h.id} className="stack"><div className="row between"><span>{h.date} · {h.receivedBy}{h.receivedByTitle ? ` (${h.receivedByTitle})` : ''}</span><strong>{money(h.amount)}</strong></div>{h.note && <span className="muted">{h.note}</span>}<a className="link" href={`${base}/handovers/${h.id}/print`} target="_blank" rel="noreferrer">{t('safe.print')}</a></li>)}</ul>)}
      {dlg && <Handover base={base} balance={s.balance} onDone={() => { setDlg(false); safe.reload(); }} onClose={() => setDlg(false)} />}
    </div>
  );
}

function Handover({ base, balance, onDone, onClose }: { base: string; balance: Amount; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const withStepUp = useStepUp();
  const [amount, setAmount] = useState(balance.amount); const [who, setWho] = useState('M Hamza'); const [title, setTitle] = useState('CFO'); const [note, setNote] = useState('');
  const { busy, problem, run } = useAction();
  const partial = amount.trim() !== balance.amount;
  const go = async () => { if (await run(() => withStepUp(() => api('POST', `${base}/handovers`, { amount: amount.trim(), safeBefore: balance.amount, receivedByName: who.trim(), receivedByTitle: title.trim() || null, note: note.trim() || null })))) onDone(); };
  return (
    <Sheet title={t('safe.handover')} onClose={onClose}>
      <p>{t('safe.inSafe')}: <strong>{money(balance)}</strong></p>
      <label>{t('safe.amount')}<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} dir="ltr" /></label>
      <div className="grid2"><label>{t('safe.receivedBy')}<input value={who} onChange={(e) => setWho(e.target.value)} /></label><label>{t('safe.title2')}<input value={title} onChange={(e) => setTitle(e.target.value)} /></label></div>
      {partial && <label>{t('safe.why')}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>}
      <p className="muted small">{t('safe.count')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || who.trim().length < 2 || !/^\d{1,9}(\.\d{1,2})?$/.test(amount.trim()) || (partial && note.trim().length < 3)} onClick={go}>{t('safe.confirm')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}
