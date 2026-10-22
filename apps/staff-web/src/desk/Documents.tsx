import { useRef, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';
import { AccountPicker } from './AccountPicker.js';

type Kind = 'payment' | 'statement' | 'order' | 'invoice';

/** Open the branded page to print or save as PDF, and copy the private link to send to the guest. */
export function DocButtons({ kind, refId, labels }: { kind: Kind; refId: string; labels?: { open?: Key; link?: Key } }) {
  const { t } = useT(); const { property } = useAuth(); const { busy, problem, run } = useAction(); const [copied, setCopied] = useState<string | null>(null);
  const b = `/v1/properties/${property!.id}`;
  const copy = async () => {
    const r = await run(() => api<{ url: string }>('POST', `${b}/documents/links`, { kind: kind.toUpperCase(), refId }));
    if (!r) return;
    try { await navigator.clipboard.writeText(r.url); } catch { /* the link is shown below to copy by hand */ }
    setCopied(r.url);
  };
  return (
    <div className="stack">
      <div className="row">
        <a className="button" href={`${b}/documents/${kind}/${refId}`} target="_blank" rel="noreferrer">{t(labels?.open ?? 'doc.print')}</a>
        {kind !== 'order' && <button type="button" disabled={busy} onClick={copy}>{t(labels?.link ?? 'doc.copyLink')}</button>}
      </div>
      {copied && <p className="muted small" role="status" dir="ltr">{t('doc.copied')} {copied}</p>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </div>
  );
}

interface Slip { id: string; reservationId: string | null; paymentId: string | null; source: string; claimed: Amount | null; reference: string | null; bank: string | null; note: string | null; status: 'SUBMITTED' | 'LINKED' | 'REJECTED'; rejectReason: string | null; submittedAt: string; confirmationNo: string | null; guest: string | null; receiptNo: string | null }

/** Slips of bank transfers that guests sent from their booking page: look at the picture, record the money from it, or say it does not match. */
export function PaymentSlips() {
  const { t, locale } = useT(); const { property, can } = useAuth();
  const b = `/v1/properties/${property!.id}`;
  const [all, setAll] = useState(false); const [recording, setRecording] = useState<Slip | null>(null);
  const list = useLive<{ items: Slip[] }>(can('folio.view') ? `${b}/payment-slips?status=${all ? 'ALL' : 'SUBMITTED'}` : null, 20_000);
  const { busy, problem, run } = useAction();
  if (!can('folio.view')) return null;
  const reject = async (s: Slip) => { const r = window.prompt(t('doc.rejectWhy')); if (r && r.trim().length >= 3 && (await run(() => api('POST', `${b}/payment-slips/${s.id}/reject`, { reason: r.trim() })))) list.reload(); };
  return (
    <div className="stack">
      <h3>{t('doc.slips')}</h3>
      <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t('gr.showAll')}</label>
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('doc.noSlips')} /> : (
        <ul className="plain">{list.data.items.map((s) => (
          <li key={s.id} className="card inner stack small">
            <div className="row between"><strong>{s.confirmationNo} · {s.guest}</strong><Badge tone={s.status === 'LINKED' ? 'clean' : s.status === 'REJECTED' ? 'neutral' : 'warn'}>{t(`doc.s.${s.status}` as Key)}</Badge></div>
            <span>{[s.claimed && money(s.claimed), s.bank, s.reference].filter(Boolean).join(' · ')}</span>
            {s.note && <span className="muted">{s.note}</span>}
            <span className="muted">{new Date(s.submittedAt).toLocaleString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })}{s.receiptNo ? ` · ${s.receiptNo}` : ''}{s.rejectReason ? ` · ${s.rejectReason}` : ''}</span>
            <div className="row"><a className="button" href={`${b}/payment-slips/${s.id}/file`} target="_blank" rel="noreferrer">{t('doc.viewSlip')}</a>
              {s.status === 'SUBMITTED' && can('payment.take') && <button className="primary" disabled={busy} onClick={() => setRecording(s)}>{t('doc.record')}</button>}
              {s.status === 'SUBMITTED' && can('payment.take') && <button disabled={busy} onClick={() => reject(s)}>{t('doc.notMatching')}</button>}</div>
          </li>))}</ul>)}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {recording && <RecordSheet b={b} s={recording} onDone={() => { setRecording(null); list.reload(); }} onClose={() => setRecording(null)} />}
    </div>
  );
}

function RecordSheet({ b, s, onDone, onClose }: { b: string; s: Slip; onDone: () => void; onClose: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction();
  const [f, setF] = useState({ kind: 'DEPOSIT', amount: s.claimed?.amount ?? '', reference: s.reference ?? '', bank: s.bank ?? '' }); const [account, setAccount] = useState('');
  const go = async () => { if (await run(() => api('POST', `${b}/payment-slips/${s.id}/record`, { kind: f.kind, amount: f.amount.trim(), reference: f.reference.trim(), counterparty: f.bank.trim(), ...(account ? { paymentAccountId: account } : {}) }))) onDone(); };
  return (
    <Sheet title={t('doc.record')} onClose={onClose}>
      <p className="muted small">{s.confirmationNo} · {s.guest}</p>
      <a className="button" href={`${b}/payment-slips/${s.id}/file`} target="_blank" rel="noreferrer">{t('doc.viewSlip')}</a>
      <p className="muted small">{t('doc.recordHelp')}</p>
      <div className="chips" role="group">{(['DEPOSIT', 'PAYMENT'] as const).map((k) => <button key={k} type="button" className={`chip${f.kind === k ? ' on' : ''}`} aria-pressed={f.kind === k} onClick={() => setF({ ...f, kind: k })}>{t(`pay.k.${k}` as Key)}</button>)}</div>
      <label>{t('pay.amount')}<input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} dir="ltr" /></label>
      <AccountPicker method="BANK_TRANSFER" value={account} onChange={setAccount} />
      <label>{t('pay.bankRef')}<input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} dir="ltr" /></label>
      <label>{t('pay.bank')}<input value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || !f.amount.trim() || f.reference.trim().length < 3 || f.bank.trim().length < 2} onClick={go}>{t('common.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

/** For the desk: attach the picture of a transfer it has just recorded, so the person verifying the money can see what was sent. */
export function AttachSlip({ paymentId, onDone }: { paymentId: string; onDone?: () => void }) {
  const { t } = useT(); const { property } = useAuth(); const { busy, problem, run } = useAction(); const pick = useRef<HTMLInputElement>(null); const [n, setN] = useState(0);
  const send = async (files: FileList | null) => { const file = files?.[0]; if (!file) return; const fd = new FormData(); fd.append('file', file); if (await run(() => api('POST', `/v1/properties/${property!.id}/payments/${paymentId}/slip`, fd))) { setN((x) => x + 1); onDone?.(); } };
  return (
    <div className="stack">
      <input ref={pick} type="file" hidden accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => { void send(e.target.files); e.target.value = ''; }} />
      <button type="button" disabled={busy} onClick={() => pick.current?.click()}>{busy ? t('ps.uploading') : t('doc.attachSlip')}</button>
      {n > 0 && <p className="ok small" role="status">✓ {t('doc.attached', { n })}</p>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </div>
  );
}

/** For whoever verifies: the pictures that came with a transfer. */
export function SlipLinks({ paymentId, count }: { paymentId: string; count: number }) {
  const { t } = useT(); const { property } = useAuth();
  const l = useLive<{ items: Array<{ id: string; source: string }> }>(count > 0 ? `/v1/properties/${property!.id}/payments/${paymentId}/slips` : null, 600_000);
  if (!count) return null;
  return <span className="row">{(l.data?.items ?? []).map((s, i) => <a key={s.id} className="button" href={`/v1/properties/${property!.id}/payment-slips/${s.id}/file`} target="_blank" rel="noreferrer">{t('doc.viewSlip')}{count > 1 ? ` ${i + 1}` : ''}</a>)}</span>;
}

/** On the guest's booking page: send the picture or PDF of the transfer, and see what the hotel did with it. */
export function GuestSlipUpload({ token, onSent }: { token: string; onSent: () => void }) {
  const { t } = useT(); const pick = useRef<HTMLInputElement>(null);
  const [f, setF] = useState({ amount: '', reference: '', bank: '' }); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [sent, setSent] = useState(false);
  const send = async (files: FileList | null) => {
    const file = files?.[0]; if (!file) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      for (const [k, v] of Object.entries(f)) if (v.trim()) fd.append(k, v.trim());                 // the details go first, so the server has them when the file arrives
      fd.append('file', file);
      await api('POST', `/v1/guest/booking/${token}/slips`, fd); setSent(true); setF({ amount: '', reference: '', bank: '' }); onSent();
    } catch (e) { setErr(e instanceof ApiError ? e.code : 'ERROR'); } finally { setBusy(false); }
  };
  return (
    <div className="card inner stack">
      <p className="muted small">{t('doc.guestHelp')}</p>
      <div className="grid2"><label>{t('doc.guestAmount')}<input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} dir="ltr" /></label><label>{t('doc.guestBank')}<input value={f.bank} maxLength={80} onChange={(e) => setF({ ...f, bank: e.target.value })} /></label></div>
      <label>{t('doc.guestRef')}<input value={f.reference} maxLength={80} onChange={(e) => setF({ ...f, reference: e.target.value })} dir="ltr" /></label>
      <input ref={pick} type="file" hidden accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => { void send(e.target.files); e.target.value = ''; }} />
      <button className="primary" type="button" disabled={busy} onClick={() => pick.current?.click()}>{busy ? t('ps.uploading') : t('doc.guestChoose')}</button>
      {sent && <p className="okbox" role="status">{t('doc.guestSent')}</p>}
      {err && <p className="warnbox" role="alert">{t(`err.${err}` as Key) === `err.${err}` ? t('err.generic') : t(`err.${err}` as Key)}</p>}
    </div>
  );
}
