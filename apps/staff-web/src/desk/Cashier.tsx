import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { Badge, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';

interface Session {
  id: string; registerName: string; userId: string; status: 'OPEN' | 'CLOSED' | 'REVIEWED'; openedAt: string; openingFloat: Amount; closedAt: string | null; counted?: Amount | null; expected?: Amount | null; variance?: Amount | null;
  tenders?: Array<{ method: string; kind: string; count: number; total?: Amount }>; cash?: { receipts: Amount; refunds: Amount; drops: Amount }; dropCount?: number; reviewNote: string | null;
}
interface Pending { id: string; kind: string; method: string; amount: Amount; reference: string | null; counterparty: string | null; folioNo: string; confirmationNo: string | null }

/** The drawer. Cash is counted blind: you see what moved, never the total you are supposed to be counting against. */
export function Cashier() {
  const { t, locale } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const cur = useLive<{ session: Session | null }>(`${base}/cashier/sessions/current`, 15_000);
  const list = useLive<{ items: Session[] }>(`${base}/cashier/sessions?limit=20`, 30_000);
  const pending = useLive<{ items: Pending[] }>(can('payment.verify') ? `${base}/payments/pending` : null, 20_000);
  const [dlg, setDlg] = useState<null | 'open' | 'drop' | 'close'>(null); const [review, setReview] = useState<Session | null>(null); const [shown, setShown] = useState<Session | null>(null);
  const s = cur.data?.session;
  const reload = () => { cur.reload(); list.reload(); pending.reload(); };
  if (!cur.data) return <Spinner />;
  return (
    <section>
      <h2>{t('nav.cashier')}</h2>
      {!s ? (
        <div className="card stack"><p>{t('cash.none')}</p><div className="actions"><button className="primary" onClick={() => setDlg('open')}>{t('cash.open')}</button></div></div>
      ) : (
        <div className="card stack">
          <div className="row between"><strong>{s.registerName}</strong><Badge tone="clean">{t('cash.open.badge')}</Badge></div>
          <p className="muted small">{t('cash.since')} {new Date(s.openedAt).toLocaleTimeString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' })} · {t('cash.float')}: {money(s.openingFloat)}</p>
          <ul className="plain small">{(s.tenders ?? []).map((x) => <li key={`${x.method}${x.kind}`} className="row between"><span>{t(`pay.m.${x.method}` as Key)} · {t(`pay.k.${x.kind}` as Key)}</span><span>{x.count}{x.total ? ` · ${money(x.total)}` : ''}</span></li>)}</ul>
          <p className="muted small">{t('cash.blind')}</p>
          <div className="actions"><button onClick={() => setDlg('drop')}>{t('cash.drop')}</button><button className="primary" onClick={() => setDlg('close')}>{t('cash.close')}</button></div>
        </div>
      )}
      {pending.data && pending.data.items.length > 0 && (
        <div className="card stack"><h3>{t('cash.pending')}</h3>
          <ul className="plain">{pending.data.items.map((p) => <PendingRow key={p.id} p={p} onDone={reload} />)}</ul></div>
      )}
      <h3>{t('cash.sessions')}</h3>
      <ul className="plain rows">{(list.data?.items ?? []).map((x) => (
        <li key={x.id}><button className="row-card" onClick={() => setShown(x)}><span className="rc-main"><strong>{x.registerName}</strong><span className="muted small">{new Date(x.openedAt).toLocaleString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })}</span></span>
          <span className="rc-side"><Badge tone={x.status === 'OPEN' ? 'clean' : x.status === 'CLOSED' ? 'warn' : 'neutral'}>{t(`cash.s.${x.status}` as Key)}</Badge>{x.variance && x.variance.amount !== '0.00' && <span className="error small">{money(x.variance)}</span>}</span></button></li>))}</ul>
      {dlg === 'open' && <OpenSheet onDone={reload} onClose={() => setDlg(null)} />}
      {dlg === 'drop' && s && <DropSheet id={s.id} onDone={reload} onClose={() => setDlg(null)} />}
      {dlg === 'close' && s && <CloseSheet id={s.id} onDone={(closed) => { reload(); setShown(closed); }} onClose={() => setDlg(null)} />}
      {shown && <SessionSheet id={shown.id} onReview={can('cashier.review') ? () => { setReview(shown); setShown(null); } : undefined} onClose={() => setShown(null)} />}
      {review && <ReviewSheet s={review} onDone={reload} onClose={() => setReview(null)} />}
    </section>
  );
}

function PendingRow({ p, onDone }: { p: Pending; onDone: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const a = useAction(); const [note, setNote] = useState('');
  const act = async (approve: boolean) => { const r = await a.run(() => api('POST', `/v1/properties/${property!.id}/payments/${p.id}/verify`, { approve, note: note.trim() || undefined })); if (r) onDone(); };
  return (
    <li className="card inner stack small">
      <div className="row between"><span>{p.kind === 'REFUND' ? t('pay.k.REFUND') : t('pay.k.PAYMENT')} · {p.counterparty} · <span dir="ltr">{p.reference}</span></span><strong>{money(p.amount)}</strong></div>
      <span className="muted">{p.confirmationNo ?? p.folioNo}</span>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('cash.verifyNote')} />
      <ErrorLine code={a.problem?.code} detail={a.problem?.detail} />
      <div className="actions"><button className="primary" disabled={a.busy} onClick={() => act(true)}>{t('cash.approve')}</button><button disabled={a.busy || note.trim().length < 3} onClick={() => act(false)}>{t('cash.reject')}</button></div>
    </li>
  );
}
function OpenSheet({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const { t } = useT(); const { property } = useAuth();
  const [float, setFloat] = useState('0'); const [name, setName] = useState(t('cash.defaultRegister')); const a = useAction();
  const go = async () => { const r = await a.run(() => api('POST', `/v1/properties/${property!.id}/cashier/sessions`, { openingFloat: float.trim() || '0', registerName: name.trim() || t('cash.defaultRegister') })); if (r) { onDone(); onClose(); } };
  return (<Sheet title={t('cash.open')} onClose={onClose}>
    <label>{t('cash.register')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
    <label>{t('cash.floatCounted')}<input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} dir="ltr" autoFocus /></label>
    <ErrorLine code={a.problem?.code} detail={a.problem?.detail} />
    <div className="actions"><button className="primary" disabled={a.busy} onClick={go}>{t('cash.open')}</button><button onClick={onClose}>{t('common.cancel')}</button></div></Sheet>);
}
function DropSheet({ id, onDone, onClose }: { id: string; onDone: () => void; onClose: () => void }) {
  const { t } = useT(); const { property } = useAuth();
  const [amount, setAmount] = useState(''); const [note, setNote] = useState(''); const a = useAction();
  const go = async () => { const r = await a.run(() => api('POST', `/v1/properties/${property!.id}/cashier/sessions/${id}/drops`, { amount: amount.trim(), ...(note.trim() ? { note: note.trim() } : {}) })); if (r) { onDone(); onClose(); } };
  return (<Sheet title={t('cash.drop')} onClose={onClose}>
    <label>{t('pay.amount')}<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} dir="ltr" autoFocus /></label>
    <label>{t('common.note')} ({t('common.optional')})<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
    <ErrorLine code={a.problem?.code} detail={a.problem?.detail} />
    <div className="actions"><button className="primary" disabled={a.busy || !amount.trim()} onClick={go}>{t('act.confirm')}</button><button onClick={onClose}>{t('common.cancel')}</button></div></Sheet>);
}
function CloseSheet({ id, onDone, onClose }: { id: string; onDone: (s: Session) => void; onClose: () => void }) {
  const { t } = useT(); const { property } = useAuth();
  const [counted, setCounted] = useState(''); const [note, setNote] = useState(''); const a = useAction(); const [res, setRes] = useState<Session | null>(null);
  const go = async () => { const r = await a.run(() => api<Session>('POST', `/v1/properties/${property!.id}/cashier/sessions/${id}/close`, { counted: counted.trim(), ...(note.trim() ? { note: note.trim() } : {}) })); if (r) { setRes(r); onDone(r); } };
  return (<Sheet title={t('cash.close')} onClose={onClose}>
    {res ? (<><div className="card inner stack"><div className="row between"><span>{t('cash.counted')}</span><strong>{res.counted ? money(res.counted) : ''}</strong></div><div className="row between"><span>{t('cash.expected')}</span><strong>{res.expected ? money(res.expected) : ''}</strong></div>
      <div className="row between"><span>{t('cash.variance')}</span><strong className={res.variance && res.variance.amount !== '0.00' ? 'error' : 'ok'}>{res.variance ? money(res.variance) : ''}</strong></div></div>
      {res.variance && res.variance.amount !== '0.00' && <p className="warnbox">{t('cash.varianceNote')}</p>}
      <div className="actions"><button className="primary" onClick={onClose}>{t('common.close')}</button></div></>) : (<>
      <p className="muted">{t('cash.countHint')}</p>
      <label>{t('cash.cashCounted')}<input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} dir="ltr" autoFocus /></label>
      <label>{t('common.note')} ({t('common.optional')})<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <ErrorLine code={a.problem?.code} detail={a.problem?.detail} />
      <div className="actions"><button className="primary" disabled={a.busy || !counted.trim()} onClick={go}>{t('cash.close')}</button><button onClick={onClose}>{t('common.cancel')}</button></div></>)}
  </Sheet>);
}
function SessionSheet({ id, onReview, onClose }: { id: string; onReview?: () => void; onClose: () => void }) {
  const { t } = useT(); const { property } = useAuth();
  const s = useLive<Session>(`/v1/properties/${property!.id}/cashier/sessions/${id}`, 60_000);
  const d = s.data;
  return (<Sheet title={d?.registerName ?? t('common.loading')} onClose={onClose}>
    {!d ? <Spinner /> : (<>
      <div className="row"><Badge tone={d.status === 'OPEN' ? 'clean' : d.status === 'CLOSED' ? 'warn' : 'neutral'}>{t(`cash.s.${d.status}` as Key)}</Badge></div>
      <div className="card inner stack small">
        <div className="row between"><span>{t('cash.float')}</span><span>{money(d.openingFloat)}</span></div>
        {d.cash && <><div className="row between"><span>{t('cash.receipts')}</span><span>{money(d.cash.receipts)}</span></div><div className="row between"><span>{t('cash.refunds')}</span><span>{money(d.cash.refunds)}</span></div><div className="row between"><span>{t('cash.drops')}</span><span>{money(d.cash.drops)}</span></div></>}
        {d.expected && <div className="row between"><span>{t('cash.expected')}</span><strong>{money(d.expected)}</strong></div>}
        {d.counted && <div className="row between"><span>{t('cash.counted')}</span><strong>{money(d.counted)}</strong></div>}
        {d.variance && <div className="row between"><span>{t('cash.variance')}</span><strong className={d.variance.amount !== '0.00' ? 'error' : 'ok'}>{money(d.variance)}</strong></div>}
      </div>
      <ul className="plain small">{(d.tenders ?? []).map((x) => <li key={`${x.method}${x.kind}`} className="row between"><span>{t(`pay.m.${x.method}` as Key)} · {t(`pay.k.${x.kind}` as Key)}</span><span>{x.count}{x.total ? ` · ${money(x.total)}` : ''}</span></li>)}</ul>
      {d.reviewNote && <p className="small">{d.reviewNote}</p>}
      {onReview && d.status === 'CLOSED' && <div className="actions"><button className="primary" onClick={onReview}>{t('cash.review')}</button></div>}
    </>)}
  </Sheet>);
}
function ReviewSheet({ s, onDone, onClose }: { s: Session; onDone: () => void; onClose: () => void }) {
  const { t } = useT(); const { property } = useAuth(); const withStepUp = useStepUp();
  const [note, setNote] = useState(''); const a = useAction();
  const go = async () => { const r = await a.run(() => withStepUp(() => api('POST', `/v1/properties/${property!.id}/cashier/sessions/${s.id}/review`, { note: note.trim() || undefined }))); if (r) { onDone(); onClose(); } };
  return (<Sheet title={t('cash.review')} onClose={onClose}>
    <p className="muted">{s.registerName}</p>
    <label>{t('cash.reviewNote')}<input value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></label>
    <ErrorLine code={a.problem?.code} detail={a.problem?.detail} />
    <div className="actions"><button className="primary" disabled={a.busy} onClick={go}>{t('cash.review')}</button><button onClick={onClose}>{t('common.cancel')}</button></div></Sheet>);
}
