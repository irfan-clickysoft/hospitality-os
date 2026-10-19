import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAction } from '../lib/action.js';
import { isNegative, isZero, money } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import { PaymentSheet } from './PaymentSheet.js';
import type { FolioView, Line, ReservationDetail } from './types.js';

/** Settles the bill, then checks the guest out. The server refuses a balance; a manager can let the guest leave with one (reason + second factor). */
export function CheckOutSheet({ res, line, businessDate, onDone, onClose }: { res: ReservationDetail; line: Line; businessDate: string; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property, can } = useAuth();
  const withStepUp = useStepUp();
  const folio = useLive<FolioView>(`/v1/properties/${property!.id}/reservations/${res.id}/folio`, 15_000);
  const [paying, setPaying] = useState(false); const [reason, setReason] = useState(''); const [withBalance, setWithBalance] = useState(false); const [balanceReason, setBalanceReason] = useState('');
  const { busy, problem, run } = useAction();
  const early = businessDate < line.departure;
  const due = folio.data?.projection.balanceAfterDue;
  // what the folio will show once the remaining nights are posted at check-out
  const finalBalance = early ? folio.data?.folio?.balance : folio.data?.projection.balanceAtEndOfStay ?? due;

  const submit = async () => {
    const body: Record<string, string> = {};
    if (reason.trim()) body.reason = reason.trim();
    if (withBalance && balanceReason.trim()) body.balanceReason = balanceReason.trim();
    const r = await run(() => withStepUp(() => api('POST', `/v1/properties/${property!.id}/reservations/${res.id}/rooms/${line.id}/check-out`, body)));
    if (r) { onDone(); onClose(); }
  };
  return (
    <Sheet title={`${t('co.title')} · ${res.guest.fullName}`} onClose={onClose}>
      {!folio.data ? <Spinner /> : (<>
        <p className="muted">{res.confirmationNo} · {line.assignedRoom ? `${t('d.room')} ${line.assignedRoom.number}` : ''}</p>
        <div className="card inner">
          <div className="row between"><span>{t('co.balanceNow')}</span><strong>{money(folio.data.folio?.balance ?? { amount: '0.00', currency: 'PKR' })}</strong></div>
          {!early && <div className="row between"><span>{t('co.balanceFinal')}</span><strong className={finalBalance && !isZero(finalBalance) ? 'error' : 'ok'}>{finalBalance ? money(finalBalance) : '—'}</strong></div>}
          {early && <p className="muted small">{t('co.early', { date: line.departure })}</p>}
        </div>
        {early && <label>{t('co.earlyReason')}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
        {(early || (finalBalance && !isZero(finalBalance))) && (
          <>
            {(early || (finalBalance && !isNegative(finalBalance))) && can('payment.take') && <button className="primary" onClick={() => setPaying(true)}>{t('pay.take')}</button>}
            {!early && finalBalance && isNegative(finalBalance) && <p className="error">{t('co.overpaid')}</p>}
            {can('folio.checkout_with_balance') && (
              <label className="check"><input type="checkbox" checked={withBalance} onChange={(e) => setWithBalance(e.target.checked)} /> {t('co.leaveWithBalance')}</label>
            )}
            {withBalance && <label>{t('co.balanceReason')}<input value={balanceReason} onChange={(e) => setBalanceReason(e.target.value)} /></label>}
          </>
        )}
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        <div className="actions"><button className="primary" disabled={busy || (early && reason.trim().length < 3) || (withBalance && balanceReason.trim().length < 3)} onClick={submit}>{t('co.confirm')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
      </>)}
      {paying && <PaymentSheet reservationId={res.id} balance={early ? null : finalBalance ?? null} onDone={folio.reload} onClose={() => setPaying(false)} />}
    </Sheet>
  );
}
