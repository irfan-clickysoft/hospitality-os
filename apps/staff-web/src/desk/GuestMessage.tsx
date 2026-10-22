import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { whatsappNumber } from '../lib/format.js';
import { useAuth } from '../state.js';

export const EVENTS = ['RESERVATION_CONFIRMED', 'CHECK_IN', 'PAYMENT_RECEIVED', 'SERVICE_ORDER', 'CHECK_OUT', 'REFUND', 'DOCUMENT'] as const;
export type MessageEvent = (typeof EVENTS)[number];

/** A message for the guest, written by the server from the booking (and payment) in the hotel's own wording. Staff can change any word before sending on WhatsApp. */
export function GuestMessage({ reservationId, event, paymentId, extra }: { reservationId: string; event: MessageEvent; paymentId?: string; extra?: Record<string, string> }) {
  const { t } = useT();
  const { property } = useAuth();
  const [salutation, setSalutation] = useState<'' | 'Mr.' | 'Mrs.'>('');
  const [loaded, setLoaded] = useState<{ text: string; phone: string | null } | null>(null); const [failed, setFailed] = useState(false);
  const [text, setText] = useState(''); const [edited, setEdited] = useState(false); const [copied, setCopied] = useState(false);
  const extraKey = JSON.stringify(extra ?? {});
  useEffect(() => {
    let dead = false; setFailed(false);
    api<{ text: string; phone: string | null }>('POST', `/v1/properties/${property!.id}/messages/compose`, { event, reservationId, ...(paymentId ? { paymentId } : {}), ...(salutation ? { salutation } : {}), origin: window.location.origin, extra: extra ?? {} })
      .then((r) => { if (!dead) { setLoaded(r); if (!edited) setText(r.text); } }).catch(() => { if (!dead) setFailed(true); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [property, reservationId, event, paymentId, salutation, extraKey]);
  const wa = whatsappNumber(loaded?.phone);
  if (failed) return <p className="warnbox small">{t('gm.failed')}</p>;
  if (!loaded) return <p className="muted small">{t('common.loading')}</p>;
  return (
    <div className="stack">
      <label>{t('wa.greeting')}<select value={salutation} onChange={(e) => { setSalutation(e.target.value as typeof salutation); setEdited(false); }}><option value="">{t('wa.noTitle')}</option><option value="Mr.">Mr.</option><option value="Mrs.">Mrs.</option></select></label>
      <label>{t('wa.message')}<textarea dir="ltr" rows={14} value={text} onChange={(e) => { setText(e.target.value); setEdited(true); }} /></label>
      {event === 'RESERVATION_CONFIRMED' && !property?.mapsUrl && <p className="muted small">{t('wa.noMap')}</p>}
      <div className="actions">
        {wa ? <a className="primary button" href={`https://wa.me/${wa}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">{t('wa.send')}</a> : <p className="warnbox small">{t('ws.noPhone')}</p>}
        <button onClick={() => { void navigator.clipboard?.writeText(text); setCopied(true); }}>{copied ? t('wa.copied') : t('wa.copy')}</button>
      </div>
    </div>
  );
}

/** Which message to send, then the message. */
export function GuestMessagePicker({ reservationId, paymentId }: { reservationId: string; paymentId?: string }) {
  const { t } = useT();
  const [event, setEvent] = useState<MessageEvent>(paymentId ? 'PAYMENT_RECEIVED' : 'RESERVATION_CONFIRMED');
  return (
    <div className="stack">
      <label>{t('gm.which')}<select value={event} onChange={(e) => setEvent(e.target.value as MessageEvent)}>{EVENTS.filter((x) => x !== 'SERVICE_ORDER' && x !== 'DOCUMENT').map((x) => <option key={x} value={x}>{t(`gmt.e.${x}` as Key)}</option>)}</select></label>
      <GuestMessage key={event} reservationId={reservationId} event={event} paymentId={event === 'PAYMENT_RECEIVED' || event === 'REFUND' ? paymentId : undefined} />
    </div>
  );
}
