import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { Badge, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';

const TXN = ['ROOM', 'ROOM_EXTRAS', 'FNB', 'LAUNDRY', 'TRANSPORT', 'MINIBAR', 'MISC', 'CANCEL_FEE', 'NOSHOW_FEE'] as const;
interface Version { id: string; versionNo: number; status: string; rateBp: number; ratePercent: number; appliesTo: string[]; residency: string | null; effectiveFrom: string; effectiveTo: string | null; legalBasis: string | null; advisorRef: string | null; createdBy: string; approvedBy: string | null; note: string | null }
interface Code { id: string; code: string; name: string; jurisdiction: string; versions: Version[] }
interface Codes { items: Code[]; properties: Array<{ id: string; code: string; name: string; taxJurisdiction: string | null }> }
interface Liability { from: string; to: string; items: Array<{ code: string; name: string | null; ratePercent: number; postings: number; taxable: Amount; tax: Amount }>; total: Amount }
interface Entity { id: string; name: string; ntn: string | null; strn: string | null; address: string | null; fiscalYearStartMonth: number }
const tone = (s: string) => (s === 'ACTIVE' ? 'clean' : s === 'DRAFT' ? 'warn' : 'neutral') as 'clean' | 'warn' | 'neutral';

/** Tax rates are entered here, never built in. A draft goes live only when a second person approves it with the advisor’s reference. */
export function Tax() {
  const { t } = useT();
  const { property, can, me } = useAuth();
  const codes = useLive<Codes>('/v1/tax/codes', 60_000);
  const [dialog, setDialog] = useState<{ kind: 'new' } | { kind: 'version'; code: Code } | { kind: 'decide'; v: Version; mode: 'approve' | 'reject' } | null>(null);
  const d = codes.data;
  if (!d) return <Spinner />;
  const done = () => { codes.reload(); setDialog(null); };
  return (
    <section className="stack">
      <h2>{t('nav.tax')}</h2>
      <p className="muted small">{t('tax.help')}</p>
      {d.items.length === 0 && <p className="warnbox">{t('tax.noneConfigured')}</p>}
      {d.items.map((c) => (
        <div key={c.id} className="card stack">
          <div className="row between"><strong>{c.name}</strong><span className="muted small" dir="ltr">{c.code} · {c.jurisdiction}</span></div>
          <ul className="plain">{c.versions.map((v) => (
            <li key={v.id} className="card inner small stack">
              <div className="row between"><strong>{v.ratePercent}% · v{v.versionNo}</strong><Badge tone={tone(v.status)}>{t(`tax.s.${v.status}` as Key)}</Badge></div>
              <span className="muted">{v.effectiveFrom} → {v.effectiveTo ?? t('tax.openEnded')} · {v.residency ? t(`tax.res.${v.residency}` as Key) : t('tax.res.ANY')}</span>
              <span className="muted">{v.appliesTo.map((x) => t(`tax.txn.${x}` as Key)).join(', ')}</span>
              {v.advisorRef && <span className="muted">{t('tax.advisorRef')}: {v.advisorRef}</span>}{v.legalBasis && <span className="muted">{v.legalBasis}</span>}{v.note && <span className="muted">{v.note}</span>}
              {v.status === 'DRAFT' && <div className="row">
                {can('tax.approve') && v.createdBy !== me?.user.id && <button className="primary" onClick={() => setDialog({ kind: 'decide', v, mode: 'approve' })}>{t('tax.approve')}</button>}
                {can('tax.approve') && <button className="link" onClick={() => setDialog({ kind: 'decide', v, mode: 'reject' })}>{t('tax.reject')}</button>}
                {can('tax.approve') && v.createdBy === me?.user.id && <span className="muted">{t('tax.otherMustApprove')}</span>}</div>}
              {v.status === 'ACTIVE' && can('tax.approve') && <button className="link" onClick={() => setDialog({ kind: 'decide', v, mode: 'reject' })}>{t('tax.retire')}</button>}
            </li>))}</ul>
          {can('tax.configure') && <div className="actions"><button onClick={() => setDialog({ kind: 'version', code: c })}>{t('tax.newVersion')}</button></div>}
        </div>))}
      {can('tax.configure') && <div className="actions"><button className="primary" onClick={() => setDialog({ kind: 'new' })}>{t('tax.newCode')}</button></div>}
      {can('tax.configure') && <Jurisdictions d={d} onDone={codes.reload} />}
      {can('report.view') && property && <LiabilityCard propertyId={property.id} />}
      {can('tenant.manage') && <Entities />}
      {dialog?.kind === 'new' && <VersionSheet onDone={done} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'version' && <VersionSheet code={dialog.code} onDone={done} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'decide' && <DecideSheet v={dialog.v} mode={dialog.mode} onDone={done} onClose={() => setDialog(null)} />}
    </section>
  );
}

function VersionSheet({ code, onDone, onClose }: { code?: Code; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const [f, setF] = useState({ code: '', name: '', jurisdiction: '', percent: '', from: '', to: '', residency: '', basis: '', advisor: '' });
  const [applies, setApplies] = useState<string[]>(['ROOM']);
  const { busy, problem, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const pct = Number(f.percent); const valid = f.percent !== '' && pct >= 0 && pct <= 100 && /^\d{4}-\d{2}-\d{2}$/.test(f.from) && applies.length > 0 && (code || (f.code.trim().length >= 2 && f.name.trim().length >= 2 && f.jurisdiction.trim().length >= 2));
  const go = async () => {
    const version = { rateBp: Math.round(pct * 100), appliesTo: applies, effectiveFrom: f.from, ...(f.to ? { effectiveTo: f.to } : {}), ...(f.residency ? { residency: f.residency } : {}), ...(f.basis.trim() ? { legalBasis: f.basis.trim() } : {}), ...(f.advisor.trim() ? { advisorRef: f.advisor.trim() } : {}) };
    const r = await run(() => code ? api('POST', `/v1/tax/codes/${code.id}/versions`, version) : api('POST', '/v1/tax/codes', { code: f.code, name: f.name.trim(), jurisdiction: f.jurisdiction, version }));
    if (r) onDone();
  };
  return (
    <Sheet title={code ? `${t('tax.newVersion')} · ${code.code}` : t('tax.newCode')} onClose={onClose}>
      {!code && (<><label>{t('tax.code')}<input value={f.code} onChange={set('code')} dir="ltr" /></label><label>{t('tax.name')}<input value={f.name} onChange={set('name')} /></label><label>{t('tax.jurisdiction')}<input value={f.jurisdiction} onChange={set('jurisdiction')} dir="ltr" /></label></>)}
      <label>{t('tax.ratePercent')}<input inputMode="decimal" value={f.percent} onChange={set('percent')} dir="ltr" /></label>
      <label>{t('tax.from')}<input type="date" value={f.from} onChange={set('from')} dir="ltr" /></label>
      <label>{t('tax.to')}<input type="date" value={f.to} onChange={set('to')} dir="ltr" /></label>
      <label>{t('tax.residency')}<select value={f.residency} onChange={set('residency')}><option value="">{t('tax.res.ANY')}</option><option value="RESIDENT">{t('tax.res.RESIDENT')}</option><option value="NON_RESIDENT">{t('tax.res.NON_RESIDENT')}</option></select></label>
      <fieldset className="chips">{TXN.map((x) => <label key={x} className={`chip${applies.includes(x) ? ' on' : ''}`}><input type="checkbox" hidden checked={applies.includes(x)} onChange={() => setApplies(applies.includes(x) ? applies.filter((y) => y !== x) : [...applies, x])} />{t(`tax.txn.${x}` as Key)}</label>)}</fieldset>
      <label>{t('tax.advisorRef')}<input value={f.advisor} onChange={set('advisor')} /></label>
      <label>{t('tax.legalBasis')}<input value={f.basis} onChange={set('basis')} /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || !valid} onClick={go}>{t('common.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function DecideSheet({ v, mode, onDone, onClose }: { v: Version; mode: 'approve' | 'reject'; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const withStepUp = useStepUp();
  const retire = mode === 'reject' && v.status === 'ACTIVE';
  const [advisor, setAdvisor] = useState(v.advisorRef ?? ''); const [basis, setBasis] = useState(v.legalBasis ?? ''); const [reason, setReason] = useState('');
  const { busy, problem, run } = useAction();
  const go = async () => {
    const path = `/v1/tax/versions/${v.id}/${retire ? 'retire' : mode}`;
    const body = mode === 'approve' ? { advisorRef: advisor.trim(), legalBasis: basis.trim() } : { reason: reason.trim() };
    if (await run(() => withStepUp(() => api('POST', path, body)))) onDone();
  };
  return (
    <Sheet title={`${retire ? t('tax.retire') : t(`tax.${mode}` as Key)} · ${v.ratePercent}%`} onClose={onClose}>
      {mode === 'approve' ? (<><p className="muted small">{t('tax.approveHelp')}</p><label>{t('tax.advisorRef')}<input value={advisor} onChange={(e) => setAdvisor(e.target.value)} /></label><label>{t('tax.legalBasis')}<input value={basis} onChange={(e) => setBasis(e.target.value)} /></label></>)
        : <label>{t('common.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || (mode === 'approve' ? advisor.trim().length < 3 || basis.trim().length < 3 : reason.trim().length < 3)} onClick={go}>{retire ? t('tax.retire') : t(`tax.${mode}` as Key)}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function Jurisdictions({ d, onDone }: { d: Codes; onDone: () => void }) {
  const { t } = useT();
  const known = [...new Set(d.items.map((c) => c.jurisdiction))];
  const { problem, run } = useAction();
  return (
    <div className="card stack">
      <h3>{t('tax.propJurisdiction')}</h3><p className="muted small">{t('tax.propJurisdictionHelp')}</p>
      {d.properties.map((p) => (
        <label key={p.id}>{p.name}
          <select value={p.taxJurisdiction ?? ''} onChange={(e) => void run(async () => { await api('PUT', `/v1/properties/${p.id}/tax-jurisdiction`, { jurisdiction: e.target.value || null }); onDone(); })}>
            <option value="">{t('tax.noTax')}</option>{known.map((j) => <option key={j} value={j}>{j}</option>)}
          </select></label>))}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </div>
  );
}

function LiabilityCard({ propertyId }: { propertyId: string }) {
  const { t } = useT();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`); const [to, setTo] = useState(today);
  const q = useLive<Liability>(/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) ? `/v1/properties/${propertyId}/tax/liability?from=${from}&to=${to}` : null, 120_000);
  return (
    <div className="card stack">
      <h3>{t('tax.liability')}</h3>
      <div className="row"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} dir="ltr" /><input type="date" value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" /></div>
      {q.data && (q.data.items.length === 0 ? <p className="muted small">{t('common.none')}</p> : (<>
        {q.data.items.map((r) => <div key={r.code + r.ratePercent} className="row between small"><span>{r.code} {r.ratePercent}% · {t('tax.taxableOn', { amount: money(r.taxable) })}</span><strong>{money(r.tax)}</strong></div>)}
        <div className="row between"><strong>{t('tax.total')}</strong><strong>{money(q.data.total)}</strong></div></>))}
    </div>
  );
}

function Entities() {
  const { t } = useT();
  const withStepUp = useStepUp();
  const ents = useLive<{ items: Entity[] }>('/v1/legal-entities', 300_000);
  const [edit, setEdit] = useState<Entity | null>(null);
  const [f, setF] = useState({ ntn: '', strn: '', address: '', month: '1' });
  const { busy, problem, run } = useAction();
  const open = (e: Entity) => { setEdit(e); setF({ ntn: e.ntn ?? '', strn: e.strn ?? '', address: e.address ?? '', month: String(e.fiscalYearStartMonth) }); };
  const save = async () => { if (await run(() => withStepUp(() => api('PUT', `/v1/legal-entities/${edit!.id}`, { ntn: f.ntn.trim() || null, strn: f.strn.trim() || null, address: f.address.trim() || null, fiscalYearStartMonth: Number(f.month) })))) { setEdit(null); ents.reload(); } };
  return (
    <div className="card stack">
      <h3>{t('tax.entities')}</h3>
      {ents.data?.items.map((e) => <div key={e.id} className="row between small"><span>{e.name}<br /><span className="muted" dir="ltr">NTN {e.ntn ?? '—'} · STRN {e.strn ?? '—'}</span></span><button className="link" onClick={() => open(e)}>{t('common.edit')}</button></div>)}
      {edit && (
        <Sheet title={edit.name} onClose={() => setEdit(null)}>
          <label>{t('inv.ntn')}<input value={f.ntn} onChange={(e) => setF({ ...f, ntn: e.target.value })} dir="ltr" /></label>
          <label>{t('inv.strn')}<input value={f.strn} onChange={(e) => setF({ ...f, strn: e.target.value })} dir="ltr" /></label>
          <label>{t('inv.address')}<input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
          <label>{t('tax.fyStart')}<select value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })}>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Date(2000, i, 1).toLocaleString('en-GB', { month: 'long' })}</option>)}</select></label>
          <ErrorLine code={problem?.code} detail={problem?.detail} />
          <div className="actions"><button className="primary" disabled={busy} onClick={save}>{t('common.save')}</button><button onClick={() => setEdit(null)}>{t('common.cancel')}</button></div>
        </Sheet>)}
    </div>
  );
}
