import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money, newKey } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';

interface Claim {
  id: string; reservationId: string; confirmationNo: string; otaRef: string | null; source: string; guest: string | null; kind: string; status: string;
  amount: Amount; received: Amount; writtenOff: Amount; remaining: Amount; claimRef: string | null; claimedOn: string | null; incurredOn: string; ageDays: number | null; note: string | null;
}
interface History { claim: Claim; events: Array<{ action: string; amount: Amount | null; reference: string | null; note: string | null; businessDate: string; at: string }> }
const tone = (s: string) => (s === 'RECEIVED' ? 'clean' : s === 'DISPUTED' ? 'dirty' : s === 'WRITTEN_OFF' || s === 'VOID' ? 'neutral' : s === 'CLAIMED' ? 'cleaning' : 'warn') as 'clean' | 'dirty' | 'neutral' | 'cleaning' | 'warn';

/** On an OTA booking’s bill: move a no-show or late-cancellation fee the OTA owes onto an OTA claim. */
export function OtaClaimPanel({ reservationId, source, balance, folioOpen, onChanged }: { reservationId: string; source: string; balance: Amount | null; folioOpen: boolean; onChanged: () => void }) {
  const { t } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const isOta = source.startsWith('OTA_');
  const list = useLive<{ items: Claim[] }>(isOta ? `${base}/reservations/${reservationId}/ota-claims` : null, 30_000);
  const [open, setOpen] = useState(false);
  if (!isOta) return null;
  const items = list.data?.items ?? [];
  const owing = !!balance && !balance.amount.startsWith('-') && balance.amount !== '0.00';
  if (!can('ota.claim') && items.length === 0) return null;
  return (
    <div className="stack">
      <h3>{t('ota.title')}</h3>
      {items.length === 0 && <p className="muted small">{t('common.none')}</p>}
      <ul className="plain">{items.map((c) => (
        <li key={c.id} className="card inner small row between"><span>{t(`ota.k.${c.kind}` as Key)}</span><span className="row"><strong>{money(c.amount)}</strong><Badge tone={tone(c.status)}>{t(`ota.s.${c.status}` as Key)}</Badge></span></li>))}</ul>
      {can('ota.claim') && folioOpen && owing && <div className="actions"><button onClick={() => setOpen(true)}>{t('ota.claimFee')}</button></div>}
      {open && <ClaimSheet reservationId={reservationId} balance={balance!} onDone={() => { list.reload(); onChanged(); setOpen(false); }} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ClaimSheet({ reservationId, balance, onDone, onClose }: { reservationId: string; balance: Amount; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const [kind, setKind] = useState('NO_SHOW'); const [amount, setAmount] = useState(''); const [note, setNote] = useState('');
  const key = useState(newKey)[0];
  const { busy, problem, run } = useAction();
  const go = async () => {
    const body = { kind, ...(amount.trim() ? { amount: amount.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) };
    if (await run(() => api('POST', `/v1/properties/${property!.id}/reservations/${reservationId}/ota-claim`, body, { 'idempotency-key': key }))) onDone();
  };
  return (
    <Sheet title={t('ota.claimFee')} onClose={onClose}>
      <p className="muted small">{t('ota.claimHelp', { balance: money(balance) })}</p>
      <label>{t('ota.kind')}<select value={kind} onChange={(e) => setKind(e.target.value)}>{['NO_SHOW', 'LATE_CANCELLATION', 'OTHER'].map((k) => <option key={k} value={k}>{t(`ota.k.${k}` as Key)}</option>)}</select></label>
      <label>{t('ar.amount')}<input inputMode="decimal" value={amount} placeholder={balance.amount} onChange={(e) => setAmount(e.target.value)} dir="ltr" /></label>
      <label>{t('common.note')}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy} onClick={go}>{t('ota.claimFee')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

/** What the OTAs owe the property: chase it, record what arrives, dispute it, or write it off. */
export function OtaTab() {
  const { t } = useT();
  const { property } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const [filter, setFilter] = useState<'OPEN' | 'ALL'>('OPEN'); const [open, setOpen] = useState<string | null>(null);
  const list = useLive<{ items: Claim[]; openTotal: Amount }>(`${base}/ota-receivables${filter === 'OPEN' ? '?status=OPEN' : ''}`, 60_000);
  const ageing = useLive<{ buckets: Record<string, Amount>; total: Amount }>(`${base}/ota-receivables/ageing`, 120_000);
  return (
    <section className="stack">
      <h2>{t('nav.ota')}</h2>
      {ageing.data && ageing.data.total.amount !== '0.00' && (
        <div className="card stack small"><div className="row between"><strong>{t('ota.owed')}</strong><strong>{money(ageing.data.total)}</strong></div>
          {(['d0_30', 'd31_60', 'd61_90', 'd90plus'] as const).map((b) => ageing.data!.buckets[b]!.amount !== '0.00' && <div key={b} className="row between"><span className="muted">{t(`ota.b.${b}` as Key)}</span><span dir="ltr">{money(ageing.data!.buckets[b]!)}</span></div>)}</div>)}
      <div className="chips"><Chip active={filter === 'OPEN'} onClick={() => setFilter('OPEN')}>{t('ota.f.open')}</Chip><Chip active={filter === 'ALL'} onClick={() => setFilter('ALL')}>{t('ota.f.all')}</Chip></div>
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('common.none')} /> : (
        <ul className="plain rows">{list.data.items.map((c) => (
          <li key={c.id}><button className="row-card" onClick={() => setOpen(c.id)}>
            <span className="rc-main"><strong>{c.guest}</strong><span className="muted small">{c.confirmationNo}{c.otaRef ? ` · ${c.otaRef}` : ''} · {t(`ota.k.${c.kind}` as Key)} · {t('ota.age', { n: c.ageDays ?? 0 })}</span></span>
            <span className="rc-side"><strong>{money(c.remaining.amount === '0.00' ? c.amount : c.remaining)}</strong><Badge tone={tone(c.status)}>{t(`ota.s.${c.status}` as Key)}</Badge></span>
          </button></li>))}</ul>)}
      {open && <ClaimSheetView id={open} onChanged={() => { list.reload(); ageing.reload(); }} onClose={() => setOpen(null)} />}
    </section>
  );
}

function ClaimSheetView({ id, onChanged, onClose }: { id: string; onChanged: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property, can } = useAuth();
  const withStepUp = useStepUp();
  const base = `/v1/properties/${property!.id}/ota-receivables/${id}`;
  const h = useLive<History>(base, 30_000);
  const [f, setF] = useState({ claimRef: '', amount: '', reference: '', reason: '' });
  const { busy, problem, run } = useAction();
  const c = h.data?.claim;
  const act = async (tail: string, body: unknown, stepUp = false) => { if (await run(() => (stepUp ? withStepUp : (fn: () => Promise<unknown>) => fn())(() => api('POST', `${base}/${tail}`, body)))) { h.reload(); onChanged(); setF({ claimRef: '', amount: '', reference: '', reason: '' }); } };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Sheet title={c ? `${c.guest} · ${c.confirmationNo}` : '…'} onClose={onClose}>
      {!c ? <Spinner /> : (<>
        <div className="card inner stack small">
          <div className="row between"><span>{t(`ota.k.${c.kind}` as Key)}</span><Badge tone={tone(c.status)}>{t(`ota.s.${c.status}` as Key)}</Badge></div>
          <div className="row between"><span className="muted">{t('ar.amount')}</span><strong>{money(c.amount)}</strong></div>
          <div className="row between"><span className="muted">{t('ota.received')}</span><span dir="ltr">{money(c.received)}</span></div>
          {c.writtenOff.amount !== '0.00' && <div className="row between"><span className="muted">{t('ota.writtenOff')}</span><span dir="ltr">{money(c.writtenOff)}</span></div>}
          <div className="row between"><span className="muted">{t('ota.stillOwed')}</span><strong>{money(c.remaining)}</strong></div>
          {c.claimRef && <span className="muted">{t('ota.claimRef')}: {c.claimRef}</span>}
        </div>
        {can('ota.claim') && c.status === 'CLAIMABLE' && <div className="card inner stack"><label>{t('ota.claimRef')}<input value={f.claimRef} onChange={set('claimRef')} dir="ltr" /></label><button className="primary" disabled={busy} onClick={() => act('claimed', f.claimRef.trim() ? { claimRef: f.claimRef.trim() } : {})}>{t('ota.markSent')}</button></div>}
        {can('ota.claim') && (c.status === 'CLAIMED' || c.status === 'DISPUTED') && (
          <div className="card inner stack"><div className="grid2"><label>{t('ar.amount')}<input inputMode="decimal" value={f.amount} placeholder={c.remaining.amount} onChange={set('amount')} dir="ltr" /></label><label>{t('ar.reference')}<input value={f.reference} onChange={set('reference')} dir="ltr" /></label></div>
            <button className="primary" disabled={busy || f.reference.trim().length < 3} onClick={() => act('receive', { amount: f.amount.trim() || c.remaining.amount, reference: f.reference.trim() })}>{t('ota.recordReceived')}</button></div>)}
        {can('ota.claim') && ['CLAIMED', 'DISPUTED'].includes(c.status) && (
          <div className="card inner stack"><label>{t('common.reason')}<input value={f.reason} onChange={set('reason')} /></label>
            <div className="row">{c.status === 'CLAIMED' && <button disabled={busy || f.reason.trim().length < 3} onClick={() => act('dispute', { reason: f.reason.trim() })}>{t('ota.dispute')}</button>}
              {c.status === 'DISPUTED' && <button disabled={busy || f.reason.trim().length < 3} onClick={() => act('resolve', { note: f.reason.trim() })}>{t('ota.resolve')}</button>}
              {can('ota.writeoff') && <button disabled={busy || f.reason.trim().length < 3} onClick={() => act('write-off', { reason: f.reason.trim() }, true)}>{t('ota.writeOff')}</button>}</div></div>)}
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        <h3>{t('rs.tab.history')}</h3>
        <ul className="plain small">{h.data!.events.map((e, i) => <li key={i} className="row between"><span>{t(`ota.e.${e.action}` as Key)}{e.amount ? ` · ${money(e.amount)}` : ''}{e.reference ? ` · ${e.reference}` : ''}{e.note ? ` · ${e.note}` : ''}</span><span className="muted">{e.businessDate}</span></li>)}</ul>
      </>)}
    </Sheet>
  );
}
