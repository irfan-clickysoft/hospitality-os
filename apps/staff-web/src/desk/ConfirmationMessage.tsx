import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { confirmationText } from '../lib/confirmation.js';
import { whatsappNumber } from '../lib/format.js';
import { useAuth } from '../state.js';

/** The confirmation message, ready to send on WhatsApp. The sender can change the greeting and any word before sending; the manager's name is the person signed in. */
export function ConfirmationMessage({ reservationId, guestName, phone, confirmationNo, arrival, departure }: { reservationId: string; guestName: string; phone: string | null | undefined; confirmationNo: string; arrival: string; departure: string }) {
  const { t } = useT();
  const { me, property } = useAuth();
  const [salutation, setSalutation] = useState<'' | 'Mr.' | 'Mrs.'>('');
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => { let dead = false; api<{ token: string }>('GET', `/v1/properties/${property!.id}/reservations/${reservationId}/guest-link`).then((r) => { if (!dead) setLink(`${window.location.origin}/#/b/${r.token}`); }).catch(() => undefined); return () => { dead = true; }; }, [property, reservationId]);
  const generated = confirmationText({ guestName, salutation, manager: me?.user.fullName ?? '', propertyName: property?.name ?? '', city: property?.city, confirmationNo, arrival, departure,
    checkInTime: property?.checkInTime, checkOutTime: property?.checkOutTime, mapsUrl: property?.mapsUrl, bookingUrl: link });
  const [text, setText] = useState(generated); const [edited, setEdited] = useState(false); const [copied, setCopied] = useState(false);
  useEffect(() => { if (!edited) setText(generated); }, [generated, edited]);
  const wa = whatsappNumber(phone);
  return (
    <div className="stack">
      <div className="grid2">
        <label>{t('wa.greeting')}<select value={salutation} onChange={(e) => { setSalutation(e.target.value as typeof salutation); setEdited(false); }}><option value="">{t('wa.noTitle')}</option><option value="Mr.">Mr.</option><option value="Mrs.">Mrs.</option></select></label>
      </div>
      <label>{t('wa.message')}<textarea dir="ltr" rows={14} value={text} onChange={(e) => { setText(e.target.value); setEdited(true); }} /></label>
      {!property?.mapsUrl && <p className="muted small">{t('wa.noMap')}</p>}
      <div className="actions">
        {wa ? <a className="primary button" href={`https://wa.me/${wa}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">{t('wa.send')}</a> : <p className="warnbox small">{t('ws.noPhone')}</p>}
        <button onClick={() => { void navigator.clipboard?.writeText(text); setCopied(true); }}>{copied ? t('wa.copied') : t('wa.copy')}</button>
      </div>
    </div>
  );
}
