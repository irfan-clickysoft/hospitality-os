import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { Badge, ErrorLine, Sheet } from '../ui/kit.js';
import type { Amount } from './types.js';
import { DocButtons } from './Documents.js';

interface Invoice {
  id: string; docType: 'TAX_INVOICE' | 'CREDIT_NOTE'; number: string; issueDate: string; total: Amount; net: Amount; tax: Amount; reason: string | null;
  taxSummary: Array<{ code: string; ratePercent: number; taxable: Amount; tax: Amount }>; creditedBy: { id: string; number: string } | null; billTo: { name?: string } | null;
}

/** The tax invoices and credit notes of one stay, and the buttons to issue them once the guest has left. */
export function InvoicePanel({ reservationId, finished }: { reservationId: string; finished: boolean }) {
  const { t } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const list = useLive<{ items: Invoice[] }>(`${base}/reservations/${reservationId}/invoices`, 30_000);
  const [dialog, setDialog] = useState<'issue' | Invoice | null>(null);
  const items = list.data?.items ?? [];
  if (!can('invoice.issue') && items.length === 0) return null;
  return (
    <div className="stack">
      <h3>{t('inv.title')}</h3>
      {items.length === 0 && <p className="muted small">{finished ? t('inv.none') : t('inv.afterStay')}</p>}
      <ul className="plain">{items.map((i) => (
        <li key={i.id} className="card inner small stack">
          <div className="row between"><strong dir="ltr">{i.number}</strong><strong>{money(i.total)}</strong></div>
          <div className="row between"><span className="muted">{i.issueDate}{i.billTo?.name ? ` · ${i.billTo.name}` : ''}</span>{i.docType === 'CREDIT_NOTE' ? <Badge tone="warn">{t('inv.creditNote')}</Badge> : i.creditedBy ? <Badge tone="neutral">{t('inv.creditedBy', { no: i.creditedBy.number })}</Badge> : null}</div>
          {i.taxSummary.map((s) => <div key={s.code + s.ratePercent} className="row between muted"><span>{s.code} {s.ratePercent}%</span><span dir="ltr">{money(s.tax)}</span></div>)}
          <DocButtons kind="invoice" refId={i.id} labels={{ open: 'inv.print', link: 'doc.copyInvoiceLink' }} />
          <div className="row">
            {i.docType === 'TAX_INVOICE' && !i.creditedBy && can('invoice.credit') && <button className="link" onClick={() => setDialog(i)}>{t('inv.credit')}</button>}</div>
        </li>))}</ul>
      {finished && can('invoice.issue') && <div className="actions"><button onClick={() => setDialog('issue')}>{t('inv.issue')}</button></div>}
      {dialog === 'issue' && <IssueSheet reservationId={reservationId} onDone={() => { list.reload(); setDialog(null); }} onClose={() => setDialog(null)} />}
      {dialog && dialog !== 'issue' && <CreditSheet invoice={dialog} onDone={() => { list.reload(); setDialog(null); }} onClose={() => setDialog(null)} />}
    </div>
  );
}

function IssueSheet({ reservationId, onDone, onClose }: { reservationId: string; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const [co, setCo] = useState(false); const [f, setF] = useState({ name: '', ntn: '', strn: '', address: '' });
  const [warn, setWarn] = useState<string[]>([]);
  const { busy, problem, run } = useAction();
  const go = async () => {
    const billTo = co ? { name: f.name.trim(), ...(f.ntn.trim() ? { ntn: f.ntn.trim() } : {}), ...(f.strn.trim() ? { strn: f.strn.trim() } : {}), ...(f.address.trim() ? { address: f.address.trim() } : {}) } : undefined;
    const r = await run(() => api<{ warnings?: Array<{ code: string }> }>('POST', `/v1/properties/${property!.id}/reservations/${reservationId}/invoices`, billTo ? { billTo } : {}));
    if (!r) return;
    if (r.warnings?.length) setWarn(r.warnings.map((w) => w.code)); else onDone();
  };
  if (warn.length) return (<Sheet title={t('inv.issued')} onClose={onDone}>{warn.map((w) => <p key={w} className="warnbox">{t(`inv.w.${w}` as Key) === `inv.w.${w}` ? w : t(`inv.w.${w}` as Key)}</p>)}<div className="actions"><button className="primary" onClick={onDone}>{t('common.close')}</button></div></Sheet>);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Sheet title={t('inv.issue')} onClose={onClose}>
      <p className="muted small">{t('inv.issueHelp')}</p>
      <label className="row"><input type="checkbox" checked={co} onChange={(e) => setCo(e.target.checked)} /> {t('inv.toCompany')}</label>
      {co && (<>
        <label>{t('inv.company')}<input value={f.name} onChange={set('name')} /></label>
        <label>{t('inv.ntn')}<input value={f.ntn} onChange={set('ntn')} dir="ltr" /></label>
        <label>{t('inv.strn')}<input value={f.strn} onChange={set('strn')} dir="ltr" /></label>
        <label>{t('inv.address')}<input value={f.address} onChange={set('address')} /></label>
      </>)}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || (co && f.name.trim().length < 2)} onClick={go}>{t('inv.issue')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function CreditSheet({ invoice, onDone, onClose }: { invoice: Invoice; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const withStepUp = useStepUp();
  const [reason, setReason] = useState('');
  const { busy, problem, run } = useAction();
  const go = async () => { if (await run(() => withStepUp(() => api('POST', `/v1/properties/${property!.id}/invoices/${invoice.id}/credit`, { reason: reason.trim() })))) onDone(); };
  return (
    <Sheet title={`${t('inv.credit')} · ${invoice.number}`} onClose={onClose}>
      <p className="warnbox">{t('inv.creditHelp', { total: money(invoice.total) })}</p>
      <label>{t('common.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || reason.trim().length < 3} onClick={go}>{t('inv.credit')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}
