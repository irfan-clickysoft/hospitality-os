import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { isZero, money } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useWork } from '../state.js';
import { CompanyBillings } from '../desk/BillToCompany.js';
import { PaymentSheet } from '../desk/PaymentSheet.js';
import { PaymentFixSheet } from '../desk/ReservationParts.js';
import type { Amount, ReservationDetail } from '../desk/types.js';
import { Banner, Field, InlineConfirm, StatusBadge } from '../ui/ds.js';
import { Icon } from '../ui/icons.js';
import { ErrorLine } from '../ui/kit.js';
import { Link, navigate } from '../shell/router.js';
import type { Stay } from './useStay.js';

const minor = (a: Amount) => Math.round(parseFloat(a.amount) * 100);
const asAmount = (m: number, cur: string): Amount => ({ amount: (m / 100).toFixed(2), currency: cur });

/** Settle the bill, then check out — one page, the guest's room, stay and balance always in view on the right. */
export function CheckOut({ stay }: { stay: Stay }) {
  const { t } = useT();
  const { property, can } = useAuth();
  const work = useWork(); const withStepUp = useStepUp();
  const { r, line, folio, businessDate } = stay;
  const res = r!, ln = line!;
  const f = folio.data;
  const early = businessDate < ln.departure;
  const current = f?.folio?.balance;
  // what the bill will be once the nights stayed are posted at check-out (the server posts them, so the balance shown now is not the final one)
  const final: Amount | undefined = f ? (early ? f.projection.balanceAfterDue : f.projection.balanceAtEndOfStay) : undefined;
  const cur = current?.currency ?? 'PKR';
  const [paying, setPaying] = useState(false); const [refunding, setRefunding] = useState(false); const [reason, setReason] = useState('');
  const [changed, setChanged] = useState<{ delta: number } | null>(null); const [lock, setLock] = useState(false);
  const last = useRef<number | null>(null); const mine = useRef(false);
  const { busy, problem, run, clear } = useAction();
  const offline = !work.online;

  // the bill moved while this page was open (the kitchen posted a charge, the night audit ran): say so, and do not let a stale total be confirmed by reflex
  useEffect(() => {
    if (!final) return; const now = minor(final);
    if (last.current !== null && last.current !== now) {
      if (mine.current) mine.current = false;
      else { setChanged({ delta: now - last.current }); setLock(true); window.setTimeout(() => setLock(false), 1000); }
    }
    last.current = now;
  }, [final]);

  const finalMinor = final ? minor(final) : null;
  const owes = finalMinor !== null && finalMinor > 0; const credit = finalMinor !== null && finalMinor < 0; const settled = finalMinor === 0;
  const pending = (f?.payments ?? []).filter((p) => p.status === 'PENDING_VERIFICATION');
  const pendingTotal = pending.reduce((s, p) => s + minor(p.amount), 0);
  const captured = (f?.payments ?? []).filter((p) => p.status === 'CAPTURED' && p.kind !== 'REFUND');
  const lines = (f?.postings ?? []).filter((p) => !p.reversed && p.type !== 'PAYMENT');
  const needReason = early && reason.trim().length < 3;
  const closedBy = ln.status === 'CHECKED_OUT';

  const finish = async (balanceReason?: string) => {
    clear();
    const body: Record<string, string> = {};
    if (reason.trim()) body.reason = reason.trim();
    if (balanceReason) body.balanceReason = balanceReason;
    const out = await run(() => withStepUp(() => api<ReservationDetail>('POST', `/v1/properties/${property!.id}/reservations/${res.id}/rooms/${ln.id}/check-out`, body)));
    if (out) { stay.settle(out); navigate(`/reservations/${res.id}?done=checkout${res.lines.length > 1 ? `&line=${ln.id}` : ''}`, { replace: true }); }
    else stay.refresh();
  };
  const primaryIsPay = owes && can('payment.take');
  const canOut = can('frontdesk.check_out') && !offline && !busy && !lock && !needReason && !closedBy && settled;

  if (closedBy) return <Banner level="INFO" title={t('co.already')} action={<Link className="button" to={`/reservations/${res.id}`}>{t('common.back')}</Link>}>{t('co.alreadyText')}</Banner>;
  return (
    <div className="flow">
      <div className="flow-head"><h2>{t('co.title')}</h2>{folio.updatedAt && <span className="muted small" role="status">{t('co.billAge', { s: Math.max(0, Math.round((Date.now() - folio.updatedAt) / 1000)) })}</span>}</div>
      {offline && <Banner level="ACTION" title={t('sys.offlineShort')}>{t('co.offline')}</Banner>}
      {!can('frontdesk.check_out') && <Banner level="INFO" title={t('perm.needFrontDesk')}>{t('perm.askColleague')}</Banner>}
      {changed && <Banner level="ACTION" title={t('co.changed', { delta: `${changed.delta > 0 ? '+' : '−'}${money(asAmount(Math.abs(changed.delta), cur))}` })} action={<button onClick={() => setChanged(null)}>{t('co.reviewed')}</button>}>{t('co.changedText')}</Banner>}
      {folio.error && !f && <Banner level="BLOCKER" title={t('state.errorTitle')} action={<button onClick={folio.reload}>{t('common.retry')}</button>}>{t('err.generic')}</Banner>}
      {!can('folio.view') && <Banner level="INFO" title={t('perm.noBill')}>{t('perm.noBillText')}</Banner>}

      {f && (<>
        <section className="step" aria-labelledby="s-bill"><h3 id="s-bill"><span className="stepno">1</span> {t('co.bill')}</h3>
          {lines.length === 0 ? <p className="muted">{t('common.none')}</p> : (
            <table className="bill"><caption className="sr-only">{t('co.bill')}</caption>
              <thead><tr><th scope="col">{t('co.col.item')}</th><th scope="col" className="num">{t('co.col.amount')}</th></tr></thead>
              <tbody>{lines.map((p) => <tr key={p.id} className={p.type === 'TAX' ? 'tax' : ''}><th scope="row"><span className="muted small">{p.businessDate}</span> {p.description ?? p.txnCode}{p.type === 'TAX' && <span className="muted small"> · {t('co.tax')}</span>}</th><td className="num" dir="ltr">{money(p.amount)}</td></tr>)}</tbody>
              <tfoot><tr><th scope="row">{t('co.balanceNow')}</th><td className="num" dir="ltr">{current ? money(current) : '—'}</td></tr>
                {!isZero(f.projection.unpostedDue) && <tr><th scope="row">{t('co.remaining')}</th><td className="num" dir="ltr">{money(f.projection.unpostedDue)}</td></tr>}
                <tr className="final"><th scope="row">{t('co.balanceAfter')}</th><td className="num" dir="ltr">{final ? money(final) : '—'}</td></tr></tfoot>
            </table>)}
          {early && <p className="muted small">{t('co.early', { date: ln.departure })}</p>}
        </section>

        <section className="step" aria-labelledby="s-settle"><h3 id="s-settle"><span className="stepno">2</span> {t('co.settle')}</h3>
          <div className="settle" role="status" aria-live="polite">
            {owes && <StatusBadge tone="warn" icon="alert">{t('ws.owes', { amount: final ? money(final) : '' })}</StatusBadge>}
            {settled && <StatusBadge tone="ok" icon="check">{t('ws.paid')}</StatusBadge>}
            {credit && final && <StatusBadge tone="info" icon="info">{t('ws.credit', { amount: money(asAmount(Math.abs(finalMinor!), cur)) })}</StatusBadge>}
          </div>
          {pending.length > 0 && <Banner level="ACTION" title={t('co.pendingTitle', { amount: money(asAmount(pendingTotal, cur)) })}>{t('co.pendingText')}</Banner>}
          {early && <Field label={t('co.earlyReason')} required hint={t('co.earlyHint')}>{(p) => <input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>}
          {owes && !can('payment.take') && <Banner level="INFO" title={t('co.askCashier')}>{t('co.askCashierText')}</Banner>}
          {credit && (<Banner level="INFO" title={t('co.creditTitle', { amount: money(asAmount(Math.abs(finalMinor!), cur)) })}>
            <p>{t('co.creditText')}</p>
            <div className="actions">{can('payment.refund') && captured.length > 0 && <button disabled={offline} onClick={() => setRefunding(true)}>{t('fo.refund')}</button>}</div></Banner>)}
          {(owes || credit) && (
            <details className="alt"><summary>{t('co.other')}</summary>
              <div className="stack">
                {res.companyId && owes && <CompanyBillings reservationId={res.id} companyId={res.companyId} balance={current ?? null} folioOpen={f.folio?.status === 'OPEN'} onChanged={stay.refresh} />}
                {can('folio.checkout_with_balance')
                  ? <InlineConfirm trigger={t('co.leaveWithBalance')} consequence={t('co.leaveText')} confirmLabel={t('co.leaveConfirm')} needReason busy={busy} tone="danger" onConfirm={(why) => void finish(why)} error={<ErrorLine code={problem?.code} detail={problem?.detail} />} />
                  : <p className="muted small"><Icon name="lock" size={14} /> {t('co.needsManager')}</p>}
              </div>
            </details>)}
        </section>
        {problem && (problem.code === 'BALANCE_DUE' || problem.code === 'REASON_REQUIRED') && <Banner level="BLOCKER" title={t(`err.${problem.code}` as Key)} />}
        {problem && !['BALANCE_DUE', 'REASON_REQUIRED'].includes(problem.code) && <ErrorLine code={problem.code} detail={problem.detail} />}
        {(problem?.code === 'network' || problem?.code === 'SERVER_ERROR') && <Banner level="BLOCKER" title={t('ci.outageTitle')} action={<button onClick={() => void finish()}>{t('common.retry')}</button>}>{t('co.outageText')}</Banner>}
      </>)}

      <div className="actionbar" role="region" aria-label={t('co.title')}>
        <div className="ab-msg" role="status" aria-live="polite">
          {!f ? t('common.loading') : owes ? <><Icon name="alert" size={16} /> <span>{t('co.msg.owes')}</span></> : credit ? <><Icon name="info" size={16} /> <span>{t('co.msg.credit')}</span></> : needReason ? <><Icon name="alert" size={16} /> <span>{t('co.msg.reason')}</span></> : <><Icon name="check" size={16} /> <span>{t('co.msg.ready')}</span></>}
        </div>
        <Link className="button" to={`/reservations/${res.id}`}>{t('common.cancel')}</Link>
        {primaryIsPay ? (<>
          <button disabled aria-disabled="true" title={t('co.msg.owes')}>{t('co.confirm')}</button>
          <button className="primary" disabled={offline || lock} onClick={() => setPaying(true)}>{t('co.settleAndOut', { amount: final ? money(final) : '' })}</button>
        </>) : (
          <button className={`primary${canOut ? '' : ' is-disabled'}`} aria-disabled={!canOut} disabled={busy} onClick={() => { if (canOut) void finish(); }}>{busy ? t('common.loading') : t('co.confirm')}</button>)}
      </div>
      {paying && <PaymentSheet asPanel reservationId={res.id} balance={final ?? null} onDone={() => { mine.current = true; stay.refresh(); }} onClose={() => setPaying(false)} />}
      {refunding && captured[0] && <PaymentFixSheet kind="refund" payment={captured[0]} onDone={() => { mine.current = true; stay.refresh(); }} onClose={() => setRefunding(false)} />}
    </div>
  );
}
