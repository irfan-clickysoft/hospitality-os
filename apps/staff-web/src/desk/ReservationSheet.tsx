import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { isNegative, money, shortDate, whatsappNumber } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { Badge, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import { ChargeSheet } from './ChargeSheet.js';
import { CheckInSheet } from './CheckInSheet.js';
import { CheckOutSheet } from './CheckOutSheet.js';
import { PaymentSheet } from './PaymentSheet.js';
import { RoomPicker } from './RoomPicker.js';
import { ComplianceNotes, type Hit } from './ComplianceBits.js';
import { AccountPicker } from './AccountPicker.js';
import { OtaClaimPanel } from './OtaClaims.js';
import { CompanyBillings } from './BillToCompany.js';
import { InvoicePanel } from './Invoices.js';
import { STATUS_TONE, type FolioView, type Line, type ReservationDetail } from './types.js';

type Dialog = null | { kind: 'checkin' | 'checkout' | 'assign' | 'cancel' | 'noshow' | 'move' | 'pay' | 'deposit' | 'charge' | 'void' | 'refund'; line?: Line; paymentId?: string };

export function ReservationSheet({ reservationId, businessDate, onChanged, onClose }: { reservationId: string; businessDate: string; onChanged?: () => void; onClose: () => void }) {
  const { t, locale } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const res = useLive<ReservationDetail>(`${base}/reservations/${reservationId}`, 20_000);
  const folio = useLive<FolioView>(can('folio.view') ? `${base}/reservations/${reservationId}/folio` : null, 20_000);
  const [dialog, setDialog] = useState<Dialog>(null); const [tab, setTab] = useState<'stay' | 'folio' | 'history'>('stay');
  const comp = useLive<{ hits: Array<Hit & { rule: string; stage: string; approved: boolean; message: string }>; tasks: Array<{ id: string; title: string; status: string }> }>(can('compliance.view') ? `${base}/reservations/${reservationId}/compliance` : null, 60_000);
  const refresh = () => { res.reload(); folio.reload(); onChanged?.(); };
  const r = res.data;

  const wa = r ? whatsappNumber(r.guest.phone) : null;
  const waText = r ? encodeURIComponent(t('wa.confirm', { name: r.guest.fullName, no: r.confirmationNo, from: r.lines[0]?.arrival ?? '', to: r.lines[0]?.departure ?? '', property: property!.name })) : '';
  return (
    <Sheet title={r ? `${r.guest.fullName}${r.guest.vip ? ' ★' : ''}` : t('common.loading')} onClose={onClose}>
      {!r ? <Spinner /> : (<>
        <div className="row"><strong>{r.confirmationNo}</strong><Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{t(`rs.${r.status}` as Key)}</Badge><Badge tone="neutral">{t(`src.${r.source}` as Key)}</Badge>{r.externalRef && <span className="muted small" dir="ltr">{r.externalRef}</span>}</div>
        <div className="row small">
          {r.guest.phone && <a href={`tel:${r.guest.phone}`} dir="ltr">{r.guest.phone}</a>}
          {wa && <a href={`https://wa.me/${wa}?text=${waText}`} target="_blank" rel="noreferrer">{t('wa.open')}</a>}
        </div>
        {r.guarantee.atRisk && <p className="warnbox">⚠ {t('rs.atRisk')}{r.guarantee.deadline ? ` — ${t('rs.deadline')}: ${new Date(r.guarantee.deadline).toLocaleString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB')}` : ''} · {t('rs.depositNeeded')}: {money(r.guarantee.depositRequired)}</p>}
        {r.optionExpiresAt && <p className="warnbox">{t('rs.optionUntil')}: {new Date(r.optionExpiresAt).toLocaleString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB')}</p>}
        {r.penalty.amount.amount !== '0.00' && <p className="warnbox">{t('rs.penalty')}: {money(r.penalty.amount)}{r.penalty.waived ? ` (${t('rs.waived')})` : ''}</p>}
        <div className="chips" role="tablist">{(['stay', 'folio', 'history'] as const).filter((x) => x !== 'folio' || can('folio.view')).map((x) => <button key={x} role="tab" aria-selected={tab === x} className={`chip${tab === x ? ' on' : ''}`} onClick={() => setTab(x)}>{t(`rs.tab.${x}` as Key)}</button>)}</div>

        {tab === 'stay' && comp.data && <ComplianceNotes hits={comp.data.hits.map((h) => ({ name: h.rule, action: h.action, message: h.message, approved: h.approved }))} />}
        {tab === 'stay' && comp.data && comp.data.tasks.filter((x) => x.status === 'OPEN').map((x) => <p key={x.id} className="warnbox">☐ {x.title}</p>)}
        {tab === 'stay' && r.lines.map((l) => <LineCard key={l.id} r={r} l={l} businessDate={businessDate} open={(kind) => setDialog({ kind, line: l })} />)}
        {tab === 'stay' && (r.notes.specialRequests || r.notes.internal || r.notes.guest) && (
          <div className="card inner small">{[r.notes.specialRequests, r.notes.guest, r.notes.internal].filter(Boolean).map((n, i) => <p key={i}>{n}</p>)}</div>
        )}
        {tab === 'stay' && r.status === 'OPTION' && can('reservation.modify') && <Quick label={t('rs.confirmOption')} run={() => api('POST', `${base}/reservations/${r.id}/confirm`, {})} done={refresh} />}

        {tab === 'folio' && <FolioPanel f={folio.data} r={r} open={(kind, paymentId) => setDialog({ kind, paymentId })} onChanged={refresh} />}
        {tab === 'history' && <ul className="plain small">{[...r.history].reverse().map((h, i) => <li key={i} className="row between"><span>{t(`hist.${h.action}` as Key) === `hist.${h.action}` ? h.action : t(`hist.${h.action}` as Key)}{h.to ? ` → ${t(`rs.${h.to}` as Key)}` : ''}{h.reason ? ` · ${h.reason}` : ''}</span><span className="muted">{new Date(h.at).toLocaleString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })}</span></li>)}</ul>}
        <ErrorLine code={res.error?.code} />
      </>)}

      {r && dialog?.kind === 'checkin' && dialog.line && <CheckInSheet res={r} line={dialog.line} onDone={refresh} onClose={() => setDialog(null)} />}
      {r && dialog?.kind === 'checkout' && dialog.line && <CheckOutSheet res={r} line={dialog.line} businessDate={businessDate} onDone={refresh} onClose={() => setDialog(null)} />}
      {r && dialog?.kind === 'assign' && dialog.line && <AssignSheet r={r} l={dialog.line} mode="assign" onDone={refresh} onClose={() => setDialog(null)} />}
      {r && dialog?.kind === 'move' && dialog.line && <AssignSheet r={r} l={dialog.line} mode="move" onDone={refresh} onClose={() => setDialog(null)} />}
      {r && (dialog?.kind === 'cancel' || dialog?.kind === 'noshow') && <CancelSheet r={r} line={dialog.line} noShow={dialog.kind === 'noshow'} onDone={refresh} onClose={() => setDialog(null)} />}
      {r && (dialog?.kind === 'pay' || dialog?.kind === 'deposit') && <PaymentSheet reservationId={r.id} balance={folio.data?.folio?.balance ?? null} defaultKind={dialog.kind === 'deposit' ? 'DEPOSIT' : 'PAYMENT'} onDone={refresh} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'charge' && folio.data?.folio && <ChargeSheet folioId={folio.data.folio.id} onDone={refresh} onClose={() => setDialog(null)} />}
      {dialog && (dialog.kind === 'void' || dialog.kind === 'refund') && dialog.paymentId && folio.data && <PaymentFixSheet kind={dialog.kind} payment={folio.data.payments.find((p) => p.id === dialog.paymentId)!} onDone={refresh} onClose={() => setDialog(null)} />}
    </Sheet>
  );
}

function Quick({ label, run, done }: { label: string; run: () => Promise<unknown>; done: () => void }) {
  const a = useAction(); const withStepUp = useStepUp();
  return (<><div className="actions"><button className="primary" disabled={a.busy} onClick={async () => { if (await a.run(() => withStepUp(run)) !== undefined) done(); }}>{label}</button></div><ErrorLine code={a.problem?.code} detail={a.problem?.detail} /></>);
}

function LineCard({ r, l, businessDate, open }: { r: ReservationDetail; l: Line; businessDate: string; open: (k: 'checkin' | 'checkout' | 'assign' | 'cancel' | 'noshow' | 'move') => void }) {
  const { t, locale } = useT();
  const { can } = useAuth();
  const a = l.allowedActions;
  const canArrive = a.includes('CHECK_IN') && l.arrival <= businessDate && businessDate < l.departure && can('frontdesk.check_in');
  return (
    <div className="card inner stack">
      <div className="row between"><strong>{l.roomType.name} {l.assignedRoom ? `· ${t('d.room')} ${l.assignedRoom.number}` : ''}</strong><Badge tone={STATUS_TONE[l.status] ?? 'neutral'}>{t(`rs.${l.status}` as Key)}</Badge></div>
      <p className="small">{shortDate(l.arrival, locale)} → {shortDate(l.departure, locale)} · {t('d.nights', { n: l.nights })} · {l.adults} {t('d.adults')}{l.children ? `, ${l.children} ${t('d.children')}` : ''} · {l.ratePlan.name} · <strong>{money(l.total)}</strong> <span className="muted">{t('d.exTax')}</span></p>
      <div className="actions">
        {canArrive && <button className="primary" onClick={() => open('checkin')}>{t('ci.title')}</button>}
        {a.includes('CHECK_OUT') && can('frontdesk.check_out') && <button className="primary" onClick={() => open('checkout')}>{t('co.title')}</button>}
        {(l.status === 'CONFIRMED' || l.status === 'OPTION') && can('reservation.modify') && <button onClick={() => open('assign')}>{l.assignedRoom ? t('d.changeRoom') : t('d.assignRoom')}</button>}
        {l.status === 'CHECKED_IN' && can('frontdesk.check_in') && <button onClick={() => open('move')}>{t('d.moveRoom')}</button>}
        {a.includes('CANCEL') && can('reservation.cancel') && <button onClick={() => open('cancel')}>{t('d.cancel')}</button>}
        {a.includes('NO_SHOW') && l.arrival <= businessDate && can('reservation.cancel') && <button onClick={() => open('noshow')}>{t('d.noShow')}</button>}
      </div>
      {r.status === 'NO_SHOW' || r.status === 'CANCELLED' ? null : null}
    </div>
  );
}

function AssignSheet({ r, l, mode, onDone, onClose }: { r: ReservationDetail; l: Line; mode: 'assign' | 'move'; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const withStepUp = useStepUp();
  const [room, setRoom] = useState<{ id: string; hk: string } | null>(null); const [reason, setReason] = useState(''); const [override, setOverride] = useState(false);
  const { busy, problem, run } = useAction();
  const notReady = room && (room.hk === 'DIRTY' || room.hk === 'CLEANING');
  const go = async () => {
    const base = `/v1/properties/${property!.id}/reservations/${r.id}/rooms/${l.id}`;
    const x = await run(() => withStepUp(() => mode === 'assign' ? api('PUT', `${base}/assignment`, { roomId: room!.id }) : api('POST', `${base}/move`, { roomId: room!.id, reason: reason.trim(), allowNotReady: override })));
    if (x) { onDone(); onClose(); }
  };
  return (
    <Sheet title={mode === 'assign' ? t('d.assignRoom') : t('d.moveRoom')} onClose={onClose}>
      <RoomPicker roomTypeId={l.roomType.id} arrival={mode === 'move' ? l.arrival : l.arrival} departure={l.departure} value={room?.id ?? null} onChange={(id, hk) => { setRoom({ id, hk }); setOverride(false); }} />
      {mode === 'move' && <label>{t('common.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
      {mode === 'move' && notReady && <label className="check warnbox"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> {t('ci.notReady')}</label>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || !room || (mode === 'move' && (reason.trim().length < 3 || (!!notReady && !override)))} onClick={go}>{t('act.confirm')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function CancelSheet({ r, line, noShow, onDone, onClose }: { r: ReservationDetail; line?: Line; noShow: boolean; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property, can } = useAuth();
  const withStepUp = useStepUp();
  const [reason, setReason] = useState(noShow ? t('d.noShowDefault') : ''); const [waive, setWaive] = useState(false);
  const { busy, problem, run } = useAction();
  const go = async () => {
    const base = `/v1/properties/${property!.id}/reservations/${r.id}`;
    const x = await run(() => withStepUp(() => noShow ? api('POST', `${base}/no-show`, { reason: reason.trim(), waiveFee: waive }) : api('POST', `${base}/cancel`, { reason: reason.trim(), waiveFee: waive, ...(line ? { lineIds: [line.id] } : {}) })));
    if (x) { onDone(); onClose(); }
  };
  return (
    <Sheet title={noShow ? t('d.noShow') : t('d.cancel')} onClose={onClose}>
      <p className="muted">{t('d.cancelNote')}</p>
      <label>{t('common.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></label>
      {can('reservation.waive_fee') && <label className="check"><input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} /> {t('d.waive')}</label>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || reason.trim().length < 3} onClick={go}>{t('act.confirm')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function FolioPanel({ f, r, open, onChanged }: { f: FolioView | null; r: ReservationDetail; open: (k: 'pay' | 'deposit' | 'charge' | 'void' | 'refund', paymentId?: string) => void; onChanged: () => void }) {
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
      {f.payments.length > 0 && <>
        <h3>{t('fo.payments')}</h3>
        <ul className="plain">{f.payments.map((p) => (
          <li key={p.id} className="card inner small"><div className="row between"><span>{t(`pay.k.${p.kind === 'REFUND' ? 'REFUND' : p.kind}` as Key)} · {t(`pay.m.${p.method}` as Key)}{p.reference ? ` · ${p.reference}` : ''}</span><strong>{money(p.amount)}</strong></div>
            <div className="row between"><Badge tone={p.status === 'CAPTURED' ? 'clean' : p.status === 'PENDING_VERIFICATION' ? 'warn' : 'neutral'}>{t(`pay.s.${p.status}` as Key)}</Badge>
              <span className="row">{p.status === 'CAPTURED' && p.kind !== 'REFUND' && can('folio.adjust') && <button className="link" onClick={() => open('void', p.id)}>{t('fo.void')}</button>}
                {p.status === 'CAPTURED' && p.kind !== 'REFUND' && can('payment.refund') && <button className="link" onClick={() => open('refund', p.id)}>{t('fo.refund')}</button>}</span></div></li>))}</ul></>}
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
function PaymentFixSheet({ kind, payment, onDone, onClose }: { kind: 'void' | 'refund'; payment: { id: string; amount: { amount: string; currency: string }; method: string }; onDone: () => void; onClose: () => void }) {
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
