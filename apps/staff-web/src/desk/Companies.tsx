import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import { AccountPicker } from './AccountPicker.js';
import type { Billing, CompanyLite } from './BillToCompany.js';
import type { Amount } from './types.js';

interface Company extends CompanyLite { ntn: string | null; strn: string | null; address: string | null; contactName: string | null; contactPhone: string | null; contactEmail: string | null; holdReason: string | null; notes: string | null; overdue: Amount }
interface Receipt { id: string; companyId: string; companyName?: string; method: string; amount: Amount; withheld: Amount; total: Amount; reference: string; receivedOn: string; status: string; withholdingRef: string | null; createdBy: string }
interface Aging { asOf: string; totals: Record<string, Amount>; totalOpen: Amount; items: Array<{ companyId: string; company: string; totalOpen: Amount }> }
const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
const zero = (a?: Amount) => !a || /^-?0+(\.0+)?$/.test(a.amount);
const statusTone = (s: string) => (s === 'ACTIVE' ? 'clean' : s === 'ON_HOLD' ? 'warn' : 'neutral') as 'clean' | 'warn' | 'neutral';

/** Corporate accounts: who owes what, how late it is, money received and waiting to be checked. */
export function Companies() {
  const { t } = useT();
  const { can } = useAuth();
  const [q, setQ] = useState(''); const [open, setOpen] = useState<string | null>(null); const [creating, setCreating] = useState(false);
  const list = useLive<{ items: Company[] }>(`/v1/companies${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`, 60_000);
  const aging = useLive<Aging>('/v1/ar/aging', 120_000);
  const pending = useLive<{ items: Receipt[] }>(can('ar.verify') ? '/v1/ar/receipts?status=PENDING_VERIFICATION' : null, 60_000);
  const reload = () => { list.reload(); aging.reload(); pending.reload(); };
  return (
    <section className="stack">
      <h2>{t('nav.companies')}</h2>
      {aging.data && !zero(aging.data.totalOpen) && (
        <div className="card stack small">
          <div className="row between"><strong>{t('ar.receivable')}</strong><strong>{money(aging.data.totalOpen)}</strong></div>
          {BUCKETS.map((b) => !zero(aging.data!.totals[b]) && <div key={b} className="row between"><span className="muted">{t(`ar.b.${b}` as Key)}</span><span dir="ltr">{money(aging.data!.totals[b]!)}</span></div>)}
        </div>)}
      {pending.data && pending.data.items.length > 0 && <PendingReceipts items={pending.data.items} onDone={reload} />}
      <div className="row"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('ar.search')} aria-label={t('ar.search')} />{can('company.manage') && <button className="primary" onClick={() => setCreating(true)}>{t('ar.newCompany')}</button>}</div>
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('common.none')} /> : (
        <ul className="plain rows">{list.data.items.map((c) => (
          <li key={c.id}><button className="row-card" onClick={() => setOpen(c.id)}>
            <span className="rc-main"><strong>{c.name}</strong><span className="muted small">{t('ar.limit', { amount: money(c.creditLimit) })} · {t('ar.terms', { n: c.termsDays })}</span></span>
            <span className="rc-side"><strong>{c.owed ? money(c.owed) : ''}</strong>{c.overdue && !zero(c.overdue) ? <Badge tone="dirty">{t('ar.overdueAmount', { amount: money(c.overdue) })}</Badge> : c.status !== 'ACTIVE' ? <Badge tone={statusTone(c.status)}>{t(`co.s.${c.status}` as Key)}</Badge> : null}</span>
          </button></li>))}</ul>)}
      {creating && <CompanyForm onDone={(id) => { setCreating(false); reload(); setOpen(id); }} onClose={() => setCreating(false)} />}
      {open && <CompanySheet id={open} onChanged={reload} onClose={() => setOpen(null)} />}
    </section>
  );
}

function PendingReceipts({ items, onDone }: { items: Receipt[]; onDone: () => void }) {
  const { t } = useT();
  const [note, setNote] = useState<Record<string, string>>({});
  const { busy, problem, run } = useAction();
  const decide = async (r: Receipt, approve: boolean) => { if (await run(() => api('POST', `/v1/ar/receipts/${r.id}/verify`, { approve, ...(note[r.id]?.trim() ? { note: note[r.id]!.trim() } : {}) }))) onDone(); };
  return (
    <div className="card stack">
      <h3>{t('ar.toVerify')}</h3>
      {items.map((r) => (
        <div key={r.id} className="card inner small stack">
          <div className="row between"><strong>{r.companyName}</strong><strong>{money(r.amount)}</strong></div>
          <span className="muted">{t(`ar.m.${r.method}` as Key)} · {r.reference} · {r.receivedOn}{!zero(r.withheld) ? ` · ${t('ar.withheldAmount', { amount: money(r.withheld) })}` : ''}</span>
          <input value={note[r.id] ?? ''} placeholder={t('ar.rejectNote')} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} />
          <div className="row"><button className="primary" disabled={busy} onClick={() => decide(r, true)}>{t('ar.verify')}</button><button disabled={busy || (note[r.id] ?? '').trim().length < 3} onClick={() => decide(r, false)}>{t('ar.reject')}</button></div>
        </div>))}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </div>
  );
}

function CompanyForm({ company, onDone, onClose }: { company?: Company; onDone: (id: string) => void; onClose: () => void }) {
  const { t } = useT();
  const withStepUp = useStepUp();
  const [f, setF] = useState({ name: company?.name ?? '', ntn: company?.ntn ?? '', strn: company?.strn ?? '', address: company?.address ?? '', contactName: company?.contactName ?? '', contactPhone: company?.contactPhone ?? '', contactEmail: company?.contactEmail ?? '',
    creditLimit: company ? company.creditLimit.amount.replace(/\.00$/, '') : '0', termsDays: String(company?.termsDays ?? 30), notes: company?.notes ?? '' });
  const { busy, problem, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const go = async () => {
    const body = { name: f.name.trim(), ntn: f.ntn.trim() || null, strn: f.strn.trim() || null, address: f.address.trim() || null, contactName: f.contactName.trim() || null, contactPhone: f.contactPhone.trim() || null, contactEmail: f.contactEmail.trim() || null,
      creditLimit: f.creditLimit.trim() || '0', termsDays: Number(f.termsDays), notes: f.notes.trim() || null };
    const r = await run(() => withStepUp(() => company ? api<{ id: string }>('PATCH', `/v1/companies/${company.id}`, body) : api<{ id: string }>('POST', '/v1/companies', body)));
    if (r) onDone(r.id);
  };
  return (
    <Sheet title={company ? company.name : t('ar.newCompany')} onClose={onClose}>
      <label>{t('ar.name')}<input value={f.name} onChange={set('name')} /></label>
      <div className="grid2"><label>{t('inv.ntn')}<input value={f.ntn} onChange={set('ntn')} dir="ltr" /></label><label>{t('inv.strn')}<input value={f.strn} onChange={set('strn')} dir="ltr" /></label></div>
      <label>{t('inv.address')}<input value={f.address} onChange={set('address')} /></label>
      <label>{t('ar.contactName')}<input value={f.contactName} onChange={set('contactName')} /></label>
      <div className="grid2"><label>{t('ar.contactPhone')}<input value={f.contactPhone} onChange={set('contactPhone')} dir="ltr" /></label><label>{t('ar.contactEmail')}<input value={f.contactEmail} onChange={set('contactEmail')} dir="ltr" /></label></div>
      <div className="grid2"><label>{t('ar.creditLimit')}<input inputMode="decimal" value={f.creditLimit} onChange={set('creditLimit')} dir="ltr" /></label><label>{t('ar.termsDays')}<input inputMode="numeric" value={f.termsDays} onChange={set('termsDays')} dir="ltr" /></label></div>
      <p className="muted small">{t('ar.limitHelp')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || f.name.trim().length < 2} onClick={go}>{t('common.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function CompanySheet({ id, onChanged, onClose }: { id: string; onChanged: () => void; onClose: () => void }) {
  const { t } = useT();
  const { can } = useAuth();
  const co = useLive<Company>(`/v1/companies/${id}`, 30_000);
  const items = useLive<{ items: Array<Billing & { confirmationNo: string | null; guest: string | null; invoices: string[] }> }>(`/v1/companies/${id}/items?open=true`, 30_000);
  const [dialog, setDialog] = useState<'edit' | 'receipt' | 'status' | null>(null);
  const c = co.data;
  const done = () => { co.reload(); items.reload(); onChanged(); setDialog(null); };
  return (
    <Sheet title={c?.name ?? '…'} onClose={onClose}>
      {!c ? <Spinner /> : (<>
        <div className="card inner stack small">
          <div className="row between"><span>{t('ar.owes')}</span><strong className={!zero(c.owed) ? 'error' : ''}>{c.owed ? money(c.owed) : ''}</strong></div>
          <div className="row between"><span className="muted">{t('ar.creditLimit')}</span><span dir="ltr">{money(c.creditLimit)}</span></div>
          {c.available && <div className="row between"><span className="muted">{t('ar.availableLabel')}</span><span dir="ltr">{money(c.available)}</span></div>}
          <div className="row between"><span className="muted">{t('ar.termsDays')}</span><span>{c.termsDays}</span></div>
          <div className="row between"><span className="muted">{t('co.status')}</span><Badge tone={statusTone(c.status)}>{t(`co.s.${c.status}` as Key)}</Badge></div>
          {c.holdReason && <p className="warnbox">{c.holdReason}</p>}
          <span className="muted" dir="ltr">{[c.ntn && `NTN ${c.ntn}`, c.strn && `STRN ${c.strn}`].filter(Boolean).join(' · ')}</span>
          <span className="muted">{[c.contactName, c.contactPhone, c.contactEmail].filter(Boolean).join(' · ')}</span>
        </div>
        <div className="actions">
          {can('ar.receipt') && c.status !== 'ARCHIVED' && <button className="primary" onClick={() => setDialog('receipt')}>{t('ar.recordReceipt')}</button>}
          <a className="button" href={`/v1/companies/${c.id}/statement/print`} target="_blank" rel="noreferrer">{t('ar.statement')}</a>
          {can('company.manage') && <button onClick={() => setDialog('edit')}>{t('common.edit')}</button>}
          {can('company.manage') && <button onClick={() => setDialog('status')}>{t('co.status')}</button>}
        </div>
        <h3>{t('ar.openItems')}</h3>
        {!items.data ? <Spinner /> : items.data.items.length === 0 ? <p className="muted small">{t('common.none')}</p> : (
          <ul className="plain small">{items.data.items.map((i) => (
            <li key={i.id} className="card inner stack">
              <div className="row between"><span>{i.confirmationNo} · {i.guest}</span><strong>{money(i.open)}</strong></div>
              <div className="row between"><span className="muted">{i.billedOn} → {t('ar.due', { date: i.dueOn })}{i.invoices.length ? ` · ${i.invoices.join(', ')}` : ''}</span>{i.overdue && <Badge tone="dirty">{t('ar.overdue')}</Badge>}</div>
            </li>))}</ul>)}
        {dialog === 'edit' && <CompanyForm company={c} onDone={done} onClose={() => setDialog(null)} />}
        {dialog === 'receipt' && <ReceiptSheet company={c} onDone={done} onClose={() => setDialog(null)} />}
        {dialog === 'status' && <StatusSheet company={c} onDone={done} onClose={() => setDialog(null)} />}
      </>)}
    </Sheet>
  );
}

function ReceiptSheet({ company, onDone, onClose }: { company: Company; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const today = property!.businessDate;
  const [f, setF] = useState({ method: 'BANK_TRANSFER', amount: '', reference: '', counterparty: '', receivedOn: today, withheld: '', withholdingRef: '', account: '' });
  const { busy, problem, run } = useAction(); const [sent, setSent] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const go = async () => {
    const body = { method: f.method, amount: f.amount.trim(), reference: f.reference.trim(), receivedOn: f.receivedOn, ...(f.counterparty.trim() ? { counterparty: f.counterparty.trim() } : {}), ...(f.account ? { paymentAccountId: f.account } : {}), ...(f.withheld.trim() ? { withheld: f.withheld.trim(), withholdingRef: f.withholdingRef.trim() } : {}) };
    if (await run(() => api('POST', `/v1/companies/${company.id}/receipts`, body))) setSent(true);
  };
  if (sent) return (<Sheet title={t('ar.recordReceipt')} onClose={onDone}><p className="ok">✓ {t('ar.receiptSent')}</p><div className="actions"><button className="primary" onClick={onDone}>{t('common.close')}</button></div></Sheet>);
  return (
    <Sheet title={`${t('ar.recordReceipt')} · ${company.name}`} onClose={onClose}>
      <label>{t('ar.method')}<select value={f.method} onChange={set('method')}>{['BANK_TRANSFER', 'CHEQUE', 'WALLET'].map((m) => <option key={m} value={m}>{t(`ar.m.${m}` as Key)}</option>)}</select></label>
      <div className="grid2"><label>{t('ar.amount')}<input inputMode="decimal" value={f.amount} onChange={set('amount')} dir="ltr" /></label><label>{t('ar.receivedOn')}<input type="date" value={f.receivedOn} onChange={set('receivedOn')} dir="ltr" /></label></div>
      <AccountPicker method={f.method} value={f.account} onChange={(id) => setF((x) => ({ ...x, account: id }))} />
      <label>{t('ar.reference')}<input value={f.reference} onChange={set('reference')} dir="ltr" /></label>
      <label>{t('ar.counterparty')}<input value={f.counterparty} onChange={set('counterparty')} /></label>
      <div className="grid2"><label>{t('ar.withheld')}<input inputMode="decimal" value={f.withheld} onChange={set('withheld')} dir="ltr" /></label><label>{t('ar.withholdingRef')}<input value={f.withholdingRef} onChange={set('withholdingRef')} dir="ltr" /></label></div>
      <p className="muted small">{t('ar.receiptHelp')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || !f.amount.trim() || f.reference.trim().length < 3 || (!!f.withheld.trim() && f.withholdingRef.trim().length < 1)} onClick={go}>{t('common.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function StatusSheet({ company, onDone, onClose }: { company: Company; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const [status, setStatus] = useState<'ACTIVE' | 'ON_HOLD' | 'ARCHIVED'>(company.status === 'ACTIVE' ? 'ON_HOLD' : 'ACTIVE'); const [reason, setReason] = useState('');
  const { busy, problem, run } = useAction();
  const go = async () => { if (await run(() => api('PUT', `/v1/companies/${company.id}/status`, { status, ...(reason.trim() ? { reason: reason.trim() } : {}) }))) onDone(); };
  return (
    <Sheet title={`${t('co.status')} · ${company.name}`} onClose={onClose}>
      <label>{t('co.status')}<select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>{(['ACTIVE', 'ON_HOLD', 'ARCHIVED'] as const).filter((s) => s !== company.status).map((s) => <option key={s} value={s}>{t(`co.s.${s}` as Key)}</option>)}</select></label>
      {status !== 'ACTIVE' && <label>{t('common.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || (status !== 'ACTIVE' && reason.trim().length < 3)} onClick={go}>{t('common.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}
