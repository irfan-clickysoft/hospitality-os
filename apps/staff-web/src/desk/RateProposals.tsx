import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { whatsappNumber } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import { EmailSend } from './EmailSend.js';

interface Row { id?: string; label: string; roomTypeId: string | null; p1: string | null; p2: string | null; p3: string | null; p4: string | null }
interface Billing { contactName?: string | null; phone?: string | null; email?: string | null; steps: string[] }
interface Proposal { id: string; number: string; reference: string | null; status: string; companyId: string | null; companyName: string; attnName: string | null; attnTitle: string | null; issuedOn: string; validFrom: string; validTo: string; title: string | null; intro: string | null;
  notes: string[]; facilities: string[]; terms: string[]; billing: Billing; signatory: string | null; withPhotos: boolean; rows: Row[]; version: number; sentAt: string | null; views: number }
interface Item { id: string; number: string; reference: string | null; status: string; companyName: string; validFrom: string; validTo: string; views: number }
interface Defaults { validFrom: string; validTo: string; title: string; intro: string; notes: string[]; facilities: string[]; terms: string[]; billing: { steps: string[] } }
const TONE: Record<string, 'neutral' | 'cleaning' | 'clean'> = { DRAFT: 'neutral', SENT: 'cleaning', ARCHIVED: 'neutral' };
const lines = (v: string) => v.split('\n').map((x) => x.trim()).filter(Boolean);

/** Corporate rate proposals: the letter a company receives with the hotel's rates by room category and number of guests, facilities, terms, how to book and bill, and room photos. */
export function RateProposals() {
  const { t } = useT(); const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/rate-proposals`;
  const [status, setStatus] = useState<'OPEN' | 'ARCHIVED' | 'ALL'>('OPEN'); const [q, setQ] = useState('');
  const list = useLive<{ items: Item[] }>(`${base}?status=${status}${q.trim().length >= 2 ? `&q=${encodeURIComponent(q.trim())}` : ''}`, 30_000);
  const [open, setOpen] = useState<string | null>(null); const [edit, setEdit] = useState<Proposal | 'new' | null>(null);
  const canWrite = can('company.manage');
  return (
    <section className="stack">
      <div className="page-head"><h2>{t('rpr.title')}</h2>{canWrite && <button className="primary" onClick={() => setEdit('new')}>{t('rpr.new')}</button>}</div>
      <p className="muted small">{t('rpr.intro')}</p>
      <div className="toolbar"><div className="chips" role="group" aria-label={t('rpr.title')}>{(['OPEN', 'ARCHIVED', 'ALL'] as const).map((s) => <Chip key={s} active={status === s} onClick={() => setStatus(s)}>{t(`rpr.f.${s}` as Key)}</Chip>)}</div>
        <input type="search" className="filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('rpr.search')} aria-label={t('rpr.search')} /></div>
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('rpr.none')} /> : (
        <ul className="plain queue">{list.data.items.map((x) => (
          <li key={x.id}><button className="qrow" onClick={() => setOpen(x.id)}>
            <span className="avatar" aria-hidden="true">{x.companyName.slice(0, 2).toUpperCase()}</span>
            <span className="q-main"><strong>{x.companyName}</strong><span className="muted small">{x.number}{x.reference ? ` · ${x.reference}` : ''} · {x.validFrom} → {x.validTo}</span></span>
            <span className="q-badges"><Badge tone={TONE[x.status] ?? 'neutral'}>{t(`rpr.s.${x.status}` as Key)}</Badge></span>
          </button></li>))}</ul>)}
      {open && <ProposalView id={open} base={base} canWrite={canWrite} onClose={() => { setOpen(null); list.reload(); }} onEdit={(p) => { setOpen(null); setEdit(p); }} onOpen={(id) => setOpen(id)} />}
      {edit && <ProposalEditor base={base} initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={(id) => { setEdit(null); list.reload(); setOpen(id); }} />}
    </section>
  );
}

function ProposalEditor({ base, initial, onClose, onSaved }: { base: string; initial: Proposal | null; onClose: () => void; onSaved: (id: string) => void }) {
  const { t } = useT(); const { property, can } = useAuth(); const { busy, problem, run } = useAction();
  const pb = `/v1/properties/${property!.id}`;
  const defs = useLive<Defaults>(initial ? null : `${base}/defaults`, 600_000);
  const types = useLive<{ items: Array<{ id: string; name: string; status: string }> }>(`${pb}/room-types`, 300_000);
  const companies = useLive<{ items: Array<{ id: string; name: string; status: string }> }>(can('company.view') ? '/v1/companies' : null, 300_000);
  const [f, setF] = useState<null | { reference: string; companyId: string; companyName: string; attnName: string; attnTitle: string; validFrom: string; validTo: string; title: string; intro: string; notes: string; facilities: string; terms: string; steps: string; contactName: string; phone: string; email: string; signatory: string; withPhotos: boolean }>(null);
  const [rows, setRows] = useState<Row[]>(initial?.rows ?? [{ label: '', roomTypeId: null, p1: '', p2: '', p3: null, p4: null }]);
  useEffect(() => {
    if (f) return;
    if (initial) setF({ reference: initial.reference ?? '', companyId: initial.companyId ?? '', companyName: initial.companyName, attnName: initial.attnName ?? '', attnTitle: initial.attnTitle ?? '', validFrom: initial.validFrom, validTo: initial.validTo, title: initial.title ?? '', intro: initial.intro ?? '', notes: initial.notes.join('\n'), facilities: initial.facilities.join('\n'),
      terms: initial.terms.join('\n'), steps: initial.billing.steps.join('\n'), contactName: initial.billing.contactName ?? '', phone: initial.billing.phone ?? '', email: initial.billing.email ?? '', signatory: initial.signatory ?? '', withPhotos: initial.withPhotos });
    else if (defs.data) setF({ reference: '', companyId: '', companyName: '', attnName: '', attnTitle: '', validFrom: defs.data.validFrom, validTo: defs.data.validTo, title: defs.data.title, intro: defs.data.intro, notes: defs.data.notes.join('\n'), facilities: defs.data.facilities.join('\n'), terms: defs.data.terms.join('\n'),
      steps: defs.data.billing.steps.join('\n'), contactName: '', phone: '', email: '', signatory: '', withPhotos: true });
  }, [initial, defs.data, f]);
  const body = useMemo(() => f && ({ reference: f.reference.trim() || null, companyId: f.companyId || null, companyName: f.companyName.trim(), attnName: f.attnName.trim() || null, attnTitle: f.attnTitle.trim() || null, validFrom: f.validFrom, validTo: f.validTo, title: f.title.trim() || null, intro: f.intro.trim() || null,
    notes: lines(f.notes), facilities: lines(f.facilities), terms: lines(f.terms), billing: { contactName: f.contactName.trim() || null, phone: f.phone.trim() || null, email: f.email.trim() || null, steps: lines(f.steps) }, signatory: f.signatory.trim() || null, withPhotos: f.withPhotos,
    rows: rows.filter((r) => r.label.trim()).map((r) => ({ label: r.label.trim(), roomTypeId: r.roomTypeId || null, p1: r.p1 || null, p2: r.p2 || null, p3: r.p3 || null, p4: r.p4 || null })) }), [f, rows]);
  if (!f || !body) return <Sheet title={t('rpr.new')} onClose={onClose} wide><Spinner /></Sheet>;
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const setRow = (k: number, p: Partial<Row>) => setRows((rs) => rs.map((r, i) => (i === k ? { ...r, ...p } : r)));
  const ok = body.companyName.length >= 2 && body.rows.length > 0 && body.rows.every((r) => r.p1 || r.p2 || r.p3 || r.p4) && body.validTo >= body.validFrom;
  const save = async () => { const r = await run(() => (initial ? api<Proposal>('PUT', `${base}/${initial.id}`, { ...body, version: initial.version }) : api<Proposal>('POST', base, body))); if (r) onSaved(r.id); };
  return (
    <Sheet title={initial ? `${t('rpr.edit')} ${initial.number}` : t('rpr.new')} onClose={onClose} wide>
      <div className="stack">
        <fieldset className="guestcard"><legend>{t('rpr.for')}</legend><div className="grid2">
          <label>{t('qt.company')}<select value={f.companyId} onChange={(e) => { const c = companies.data?.items.find((x) => x.id === e.target.value); set({ companyId: e.target.value, companyName: f.companyName || c?.name || '' }); }}><option value="">—</option>{(companies.data?.items ?? []).filter((c) => c.status === 'ACTIVE').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>{t('rpr.companyName')}<input value={f.companyName} onChange={(e) => set({ companyName: e.target.value })} maxLength={160} /></label>
          <label>{t('rpr.attn')}<input value={f.attnName} onChange={(e) => set({ attnName: e.target.value })} maxLength={160} /></label>
          <label>{t('rpr.attnTitle')}<input value={f.attnTitle} onChange={(e) => set({ attnTitle: e.target.value })} maxLength={160} /></label>
          <label>{t('rpr.reference')}<input value={f.reference} onChange={(e) => set({ reference: e.target.value })} maxLength={60} dir="ltr" /></label>
          <label>{t('rpr.title2')}<input value={f.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} /></label>
          <label>{t('rpr.from')}<input type="date" value={f.validFrom} onChange={(e) => set({ validFrom: e.target.value })} dir="ltr" /></label>
          <label>{t('rpr.to')}<input type="date" min={f.validFrom} value={f.validTo} onChange={(e) => set({ validTo: e.target.value })} dir="ltr" /></label>
        </div><label>{t('rpr.intro2')}<textarea rows={5} value={f.intro} onChange={(e) => set({ intro: e.target.value })} maxLength={3000} /></label></fieldset>
        <fieldset className="guestcard"><legend>{t('rpr.rates')}</legend>
          <p className="muted small">{t('rpr.ratesHint')}</p>
          {rows.map((r, k) => (
            <div key={k} className="card inner stack">
              <div className="grid2"><label className="span2">{t('rpr.category')}<input value={r.label} onChange={(e) => setRow(k, { label: e.target.value })} maxLength={160} placeholder={t('rpr.categoryHint')} /></label>
                <label>{t('rpr.photosOf')}<select value={r.roomTypeId ?? ''} onChange={(e) => setRow(k, { roomTypeId: e.target.value || null })}><option value="">{t('rpr.noPhotos')}</option>{(types.data?.items ?? []).filter((x) => x.status === 'ACTIVE').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label></div>
              <div className="grid4">{(['p1', 'p2', 'p3', 'p4'] as const).map((p, i) => <label key={p}>{t(`rpr.g${i + 1}` as Key)}<input value={r[p] ?? ''} onChange={(e) => setRow(k, { [p]: e.target.value })} inputMode="decimal" dir="ltr" /></label>)}</div>
              {rows.length > 1 && <button className="link" onClick={() => setRows((rs) => rs.filter((_, i) => i !== k))}>{t('qt.removeLine')}</button>}
            </div>))}
          <button onClick={() => setRows((rs) => [...rs, { label: '', roomTypeId: null, p1: '', p2: '', p3: null, p4: null }])}>{t('rpr.addRow')}</button>
          <label className="check"><input type="checkbox" checked={f.withPhotos} onChange={(e) => set({ withPhotos: e.target.checked })} /> {t('rpr.withPhotos')}</label>
        </fieldset>
        <fieldset className="guestcard"><legend>{t('rpr.words')}</legend><p className="muted small">{t('rpr.oneLine')}</p>
          <label>{t('rpr.notes')}<textarea rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
          <label>{t('rpr.facilities')}<textarea rows={6} value={f.facilities} onChange={(e) => set({ facilities: e.target.value })} /></label>
          <label>{t('rpr.terms')}<textarea rows={8} value={f.terms} onChange={(e) => set({ terms: e.target.value })} /></label>
        </fieldset>
        <fieldset className="guestcard"><legend>{t('rpr.billing')}</legend><div className="grid2">
          <label>{t('rpr.contactName')}<input value={f.contactName} onChange={(e) => set({ contactName: e.target.value })} maxLength={120} /></label>
          <label>{t('bk.phone')}<input value={f.phone} onChange={(e) => set({ phone: e.target.value })} dir="ltr" /></label>
          <label>{t('qt.email')}<input value={f.email} onChange={(e) => set({ email: e.target.value })} dir="ltr" /></label>
          <label>{t('rpr.signatory')}<textarea rows={2} value={f.signatory} onChange={(e) => set({ signatory: e.target.value })} maxLength={300} /></label>
        </div><label>{t('rpr.steps')}<textarea rows={5} value={f.steps} onChange={(e) => set({ steps: e.target.value })} /></label></fieldset>
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        <div className="actions"><button className="primary" disabled={busy || !ok} onClick={save}>{t('rpr.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
      </div>
    </Sheet>
  );
}

function ProposalView({ id, base, canWrite, onClose, onEdit, onOpen }: { id: string; base: string; canWrite: boolean; onClose: () => void; onEdit: (p: Proposal) => void; onOpen: (id: string) => void }) {
  const { t } = useT(); const { property } = useAuth(); const { busy, problem, run } = useAction();
  const d = useLive<Proposal>(`${base}/${id}`, 20_000); const [sending, setSending] = useState(false);
  const p = d.data;
  return (
    <Sheet title={p ? `${p.number} · ${p.companyName}` : '…'} onClose={onClose}>
      {!p ? <Spinner /> : (
        <div className="stack">
          <div className="row"><Badge tone={TONE[p.status] ?? 'neutral'}>{t(`rpr.s.${p.status}` as Key)}</Badge><span className="muted small">{p.validFrom} → {p.validTo}{p.views ? ` · ${t('qt.viewed', { n: p.views })}` : ''}{p.reference ? ` · ${p.reference}` : ''}</span></div>
          <ul className="plain small">{p.rows.map((r, k) => <li key={k} className="row between"><span>{r.label}</span><span className="muted" dir="ltr">{[r.p1, r.p2, r.p3, r.p4].map((x) => x ?? '—').join(' / ')}</span></li>)}</ul>
          <ErrorLine code={problem?.code} detail={problem?.detail} />
          <div className="actions">
            <a className="button" href={`/v1/properties/${property!.id}/rate-proposals/${p.id}/page`} target="_blank" rel="noreferrer">{t('qt.preview')}</a>
            {canWrite && p.status !== 'ARCHIVED' && <button className="primary" onClick={() => setSending(true)}>{p.status === 'DRAFT' ? t('qt.send') : t('qt.sendAgain')}</button>}
            {canWrite && <button onClick={() => onEdit(p)}>{t('qt.edit')}</button>}
            {canWrite && <button disabled={busy} onClick={async () => { const r = await run(() => api<Proposal>('POST', `${base}/${p.id}/duplicate`, {})); if (r) onOpen(r.id); }}>{t('rpr.copy')}</button>}
            {canWrite && p.status !== 'ARCHIVED' && <button className="link" disabled={busy} onClick={async () => { if (window.confirm(t('rpr.archiveConfirm')) && (await run(() => api('POST', `${base}/${p.id}/archive`, {})))) d.reload(); }}>{t('rpr.archive')}</button>}
          </div>
          {sending && <SendProposal p={p} base={base} onClose={() => { setSending(false); d.reload(); }} />}
        </div>)}
    </Sheet>
  );
}

function SendProposal({ p, base, onClose }: { p: Proposal; base: string; onClose: () => void }) {
  const { t } = useT(); const { property } = useAuth();
  const [m, setM] = useState<{ text: string; phone: string | null } | null>(null); const [text, setText] = useState(''); const [phone, setPhone] = useState(''); const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { let dead = false; api<{ text: string; phone: string | null }>('POST', `${base}/${p.id}/message`).then((r) => { if (!dead) { setM(r); setText(r.text); setPhone(r.phone ?? ''); } }).catch((e) => { if (!dead) setFailed(e?.message ?? 'error'); }); return () => { dead = true; }; }, [p.id, base]);
  const wa = whatsappNumber(phone);
  return (
    <Sheet title={t('rpr.sendTitle')} onClose={onClose}>
      {failed ? <p className="warnbox small">{failed}</p> : !m ? <Spinner /> : (
        <div className="stack">
          <p className="muted small">{t('rpr.sendNote')}</p>
          <label>{t('wa.message')}<textarea dir="ltr" rows={12} value={text} onChange={(e) => setText(e.target.value)} /></label>
          {!m.phone && <label>{t('mw.theirPhone')}<input value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" inputMode="tel" /></label>}
          <div className="actions">{wa ? <a className="primary button" href={`https://wa.me/${wa}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">{t('wa.send')}</a> : <p className="warnbox small">{t('mw.noPhone')}</p>}<button onClick={() => void navigator.clipboard?.writeText(text)}>{t('wa.copy')}</button></div>
          <EmailSend compose={() => api<{ text: string; subject: string | null; email: string | null }>('POST', `${base}/${p.id}/message?channel=EMAIL`)} send={(v) => api('POST', `/v1/properties/${property!.id}/email/proposal/${p.id}`, v)} />
        </div>)}
    </Sheet>
  );
}
