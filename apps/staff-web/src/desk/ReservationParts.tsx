import { CANCEL_REASONS, INITIATORS, NO_SHOW_REASONS, REASON_INITIATOR, REASON_NOTE, type Initiator, type ReasonCode } from '../lib/cancelReasons.js';
import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { isNegative, money } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth } from '../state.js';
import { Badge, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import { AccountPicker } from './AccountPicker.js';
import { OtaClaimPanel } from './OtaClaims.js';
import { CompanyBillings } from './BillToCompany.js';
import { InvoicePanel } from './Invoices.js';
import type { FolioView, Line, ReservationDetail } from './types.js';
import { DocButtons } from './Documents.js';

/** Pieces of the reservation workspace that are dialogs or panels in their own right: cancel / no-show, the bill, and fixing a payment. */
export function CancelSheet({ r, line, noShow, onDone, onClose }: { r: ReservationDetail; line?: Line; noShow: boolean; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property, can } = useAuth();
  const withStepUp = useStepUp();
  const [code, setCode] = useState<ReasonCode | ''>(noShow ? 'DID_NOT_ARRIVE' : ''); const [initiator, setInitiator] = useState<Initiator>('GUEST'); const [reason, setReason] = useState(''); const [waive, setWaive] = useState(false);
  const pick = (c: ReasonCode | '') => { setCode(c); if (c) setInitiator(REASON_INITIATOR[c]); };
  const { busy, problem, run } = useAction();
  const go = async () => {
    const base = `/v1/properties/${property!.id}/reservations/${r.id}`;
    const note = reason.trim() || (code ? REASON_NOTE[code] : '');
    const body = { reason: note, code, initiator, waiveFee: waive };
    const x = await run(() => withStepUp(() => noShow ? api('POST', `${base}/no-show`, body) : api('POST', `${base}/cancel`, { ...body, ...(line ? { lineIds: [line.id] } : {}) })));
    if (x) { onDone(); onClose(); }
  };
  return (
    <Sheet title={noShow ? t('d.noShow') : t('d.cancel')} onClose={onClose}>
      <p className="muted">{t('d.cancelNote')}</p>
      <label>{t('cr.reason')}<select value={code} onChange={(e) => pick(e.target.value as ReasonCode | '')} autoFocus><option value="">—</option>{(noShow ? NO_SHOW_REASONS : CANCEL_REASONS).map((c) => <option key={c} value={c}>{t(`cr.${c}` as Key)}</option>)}</select></label>
      <label>{t('cr.startedBy')}<select value={initiator} onChange={(e) => setInitiator(e.target.value as Initiator)}>{INITIATORS.map((x) => <option key={x} value={x}>{t(`cr.i.${x}` as Key)}</option>)}</select></label>
      <label>{t('common.note')}{code && code !== 'OTHER' ? ` (${t('common.optional')})` : ''}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {can('reservation.waive_fee') && <label className="check"><input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} /> {t('d.waive')}</label>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || !code || (code === 'OTHER' && reason.trim().length < 3)} onClick={go}>{t('act.confirm')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

export function FolioPanel({ f, r, open, onChanged }: { f: FolioView | null; r: ReservationDetail; open: (k: 'pay' | 'deposit' | 'charge' | 'void' | 'refund', paymentId?: string) => void; onChanged: () => void }) {
  const { t } = useT();
  const { can } = useAuth();
  if (!f) return <Spinner />;
  const bal = f.folio?.balance;
  return (
    <div className="stack">
      <div className="card inner">
        <div className="row between"><span>{t('co.balanceNow')} {f.folio ? <span className="muted small" dir="ltr">{f.folio.folioNo}</span> : ''}</span><strong className={bal && bal.amount !== '0.00' ? (isNegative(bal) ? 'ok' : 'error') : ''}>{bal ? money(bal) : money({ amount: '0.00', currency: 'PKR' })}</strong></div>
        {f.projection.unpostedNights > 0 && <p className="muted small">{t('fo.projection', { due: money(f.projection.unpostedDue), end: money(f.projection.balanceAtEndOfStay) })}</p>}
        {r.guarantee.depositPaid.amount !== '0.00' && <p className="muted small">{t('fo.depositHeld')}: {money(r.guarantee.depositPaid)}</p>}
      </div>
      <div className="actions">
        {can('payment.take') && <button className="primary" onClick={() => open('pay')}>{t('pay.take')}</button>}
        {can('payment.take') && r.status !== 'CHECKED_OUT' && <button onClick={() => open('deposit')}>{t('pay.k.DEPOSIT')}</button>}
        {can('folio.post') && f.folio?.status === 'OPEN' && <button onClick={() => open('charge')}>{t('chg.title')}</button>}
      </div>
      {f.folio && <DocButtons kind="statement" refId={r.id} labels={{ open: 'doc.statement', link: 'doc.statementLink' }} />}
      {f.payments.length > 0 && <>
        <h3>{t('fo.payments')}</h3>
        <ul className="plain">{f.payments.map((p) => (
          <li key={p.id} className="card inner small"><div className="row between"><span>{t(`pay.k.${p.kind === 'REFUND' ? 'REFUND' : p.kind}` as Key)} · {t(`pay.m.${p.method}` as Key)}{p.reference ? ` · ${p.reference}` : ''}</span><strong>{money(p.amount)}</strong></div>
            <div className="row between"><Badge tone={p.status === 'CAPTURED' ? 'clean' : p.status === 'PENDING_VERIFICATION' ? 'warn' : 'neutral'}>{t(`pay.s.${p.status}` as Key)}</Badge>
              <span className="row">{p.status === 'CAPTURED' && p.kind !== 'REFUND' && can('folio.adjust') && <button className="link" onClick={() => open('void', p.id)}>{t('fo.void')}</button>}
                {p.status === 'CAPTURED' && p.kind !== 'REFUND' && can('payment.refund') && <button className="link" onClick={() => open('refund', p.id)}>{t('fo.refund')}</button>}</span></div>
            {['CAPTURED', 'PENDING_VERIFICATION'].includes(p.status) && <DocButtons kind="payment" refId={p.id} />}</li>))}</ul></>}
      <h3>{t('fo.postings')}</h3>
      {f.postings.length === 0 ? <p className="muted small">{t('common.none')}</p> : (
        <ul className="plain small">{f.postings.map((p) => <li key={p.id} className={`row between${p.reversed ? ' struck' : ''}`}><span>{p.businessDate} · {p.description ?? p.txnCode}</span><span dir="ltr">{money(p.amount)}</span></li>)}</ul>)}
      <CompanyBillings reservationId={r.id} companyId={r.companyId} balance={bal ?? null} folioOpen={f.folio?.status === 'OPEN'} onChanged={onChanged} />
      <OtaClaimPanel reservationId={r.id} source={r.source} balance={bal ?? null} folioOpen={f.folio?.status === 'OPEN'} onChanged={onChanged} />
      <InvoicePanel reservationId={r.id} finished={r.status === 'CHECKED_OUT'} />
    </div>
  );
}

/** Void a payment entered by mistake, or refund part of it. Both need a reason; both are manager actions (second factor on request). */
export function PaymentFixSheet({ kind, payment, onDone, onClose }: { kind: 'void' | 'refund'; payment: { id: string; amount: { amount: string; currency: string }; method: string }; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const withStepUp = useStepUp();
  const [reason, setReason] = useState(''); const [amount, setAmount] = useState(payment.amount.amount); const [who, setWho] = useState(''); const [account, setAccount] = useState(''); const key = useState(() => `ui-${crypto.randomUUID()}`)[0];
  const { busy, problem, run } = useAction();
  const go = async () => {
    const base = `/v1/properties/${property!.id}/payments/${payment.id}`;
    const x = await run(() => withStepUp(() => kind === 'void' ? api('POST', `${base}/void`, { reason: reason.trim() }) : api('POST', `${base}/refund`, { amount, reason: reason.trim(), ...(who.trim() ? { counterparty: who.trim() } : {}), ...(account ? { paymentAccountId: account } : {}) }, { 'idempotency-key': key })));
    if (x) { onDone(); onClose(); }
  };
  return (
    <Sheet title={kind === 'void' ? t('fo.void') : t('fo.refund')} onClose={onClose}>
      <p className="muted">{money(payment.amount)} · {t(`pay.m.${payment.method}` as Key)}</p>
      {kind === 'refund' && <><label>{t('pay.amount')}<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} dir="ltr" /></label>{payment.method !== 'CASH' && <AccountPicker method={payment.method} value={account} onChange={setAccount} />}{payment.method !== 'CASH' && <label>{t('fo.beneficiary')}<input value={who} onChange={(e) => setWho(e.target.value)} /></label>}</>}
      <label>{t('common.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || reason.trim().length < 3} onClick={go}>{t('act.confirm')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}
