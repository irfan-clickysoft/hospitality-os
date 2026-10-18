import { useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money, newKey } from '../lib/format.js';
import { useAuth } from '../state.js';
import { AccountPicker } from './AccountPicker.js';
import { ErrorLine, Sheet } from '../ui/kit.js';
import type { Amount } from './types.js';

const METHODS = ['CASH', 'CARD_SLIP', 'WALLET', 'BANK_TRANSFER'] as const;

/** Takes a payment or deposit. The key is made once per opening of the sheet, so a double tap or a retry can never take the money twice. */
export function PaymentSheet({ reservationId, folioId, balance, defaultKind = 'PAYMENT', onDone, onClose }: { reservationId?: string; folioId?: string; balance: Amount | null; defaultKind?: 'PAYMENT' | 'DEPOSIT'; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const key = useMemo(newKey, []);
  const owes = balance && !balance.amount.startsWith('-') && balance.amount !== '0.00' ? balance.amount : '';
  const [method, setMethod] = useState<(typeof METHODS)[number]>('CASH'); const [kind, setKind] = useState(defaultKind); const [amount, setAmount] = useState(defaultKind === 'PAYMENT' ? owes : '');
  const [reference, setReference] = useState(''); const [approval, setApproval] = useState(''); const [last4, setLast4] = useState(''); const [counterparty, setCounterparty] = useState(''); const [note, setNote] = useState('');
  const { busy, problem, run } = useAction();
  const [pending, setPending] = useState(false); const [account, setAccount] = useState('');

  const submit = async () => {
    const body: Record<string, unknown> = { kind, method, amount: amount.trim() };
    if (reference.trim()) body.reference = reference.trim();
    if (method === 'CARD_SLIP') { if (approval.trim()) body.approvalCode = approval.trim(); if (last4.trim()) body.cardLast4 = last4.trim(); }
    if (method === 'BANK_TRANSFER' && counterparty.trim()) body.counterparty = counterparty.trim();
    if (note.trim()) body.note = note.trim();
    if (account && method !== 'CASH') body.paymentAccountId = account;
    const r = await run(() => api<{ payment: { status: string } }>('POST', folioId ? `/v1/properties/${property!.id}/folios/${folioId}/payments` : `/v1/properties/${property!.id}/reservations/${reservationId}/payments`, body, { 'idempotency-key': key }));
    if (r) { if (r.payment.status === 'PENDING_VERIFICATION') setPending(true); else { onDone(); onClose(); } }
  };
  return (
    <Sheet title={t('pay.title')} onClose={onClose}>
      {balance && <p className="muted">{t('pay.balance')}: <strong>{money(balance)}</strong></p>}
      {pending ? (<><p className="ok" role="status">{t('pay.pendingNote')}</p><div className="actions"><button className="primary" onClick={() => { onDone(); onClose(); }}>{t('common.close')}</button></div></>) : (<>
        <div className="chips" role="group">{METHODS.map((m) => <button key={m} type="button" className={`chip${m === method ? ' on' : ''}`} aria-pressed={m === method} onClick={() => setMethod(m)}>{t(`pay.m.${m}` as Key)}</button>)}</div>
        <div className="chips" role="group">{(['PAYMENT', 'DEPOSIT'] as const).map((k) => <button key={k} type="button" className={`chip${k === kind ? ' on' : ''}`} aria-pressed={k === kind} onClick={() => setKind(k)}>{t(`pay.k.${k}` as Key)}</button>)}</div>
        <label>{t('pay.amount')}<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} dir="ltr" autoFocus /></label>
        {method !== 'CASH' && <AccountPicker method={method} value={account} onChange={setAccount} />}
        {method !== 'CASH' && <label>{method === 'CARD_SLIP' ? t('pay.rrn') : method === 'WALLET' ? t('pay.walletRef') : t('pay.bankRef')}<input value={reference} onChange={(e) => setReference(e.target.value)} dir="ltr" /></label>}
        {method === 'CARD_SLIP' && <div className="grid2"><label>{t('pay.approval')}<input value={approval} onChange={(e) => setApproval(e.target.value)} dir="ltr" /></label><label>{t('pay.last4')}<input inputMode="numeric" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value)} dir="ltr" /></label></div>}
        {method === 'BANK_TRANSFER' && <><label>{t('pay.bank')}<input value={counterparty} onChange={(e) => setCounterparty(e.target.value)} /></label><p className="muted small">{t('pay.bankNote')}</p></>}
        <label>{t('common.note')} ({t('common.optional')})<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        <div className="actions"><button className="primary" disabled={busy || !amount.trim()} onClick={submit}>{t('pay.take')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
      </>)}
    </Sheet>
  );
}
