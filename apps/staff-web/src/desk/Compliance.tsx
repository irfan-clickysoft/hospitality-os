import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import { ChargeReviews } from './ChargeReviews.js';

interface Rule { id: string; name: string; description: string | null; status: string; stages: string[]; conditions: { nationalities?: string[]; excludeNationalities?: string[]; residency?: string; minGuests?: number; minNights?: number }; action: string; message: string; messageUr: string | null; documentTypes: string[]; taskTitle: string | null; version: number }
interface Task { id: string; title: string; dueDate: string | null; confirmationNo: string; guest: string; nationality: string | null; arrival: string | null }
const ACTIONS = ['INFO', 'WARN', 'REQUIRE_APPROVAL', 'REQUIRE_TASK', 'REQUIRE_DOCUMENT', 'BLOCK_BOOKING'];
const ID_TYPES = ['CNIC', 'NICOP', 'PASSPORT', 'DRIVING_LICENSE', 'OTHER'];
const tone = (s: string) => (s === 'ACTIVE' ? 'clean' : s === 'DRAFT' ? 'warn' : 'neutral') as 'clean' | 'warn' | 'neutral';
const codes = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);

/** Rules about who may be booked or checked in and what must be done first — set by managers, applied at the desk. */
export function Compliance() {
  const { t } = useT();
  const { property, can } = useAuth();
  const rules = useLive<{ items: Rule[] }>('/v1/compliance/rules', 120_000);
  const tasks = useLive<{ items: Task[] }>(`/v1/properties/${property!.id}/compliance-tasks`, 30_000);
  const [edit, setEdit] = useState<Rule | 'new' | null>(null);
  const { busy, problem, run } = useAction();
  const complete = async (id: string) => { if (await run(() => api('POST', `/v1/properties/${property!.id}/compliance-tasks/${id}/complete`, {}))) tasks.reload(); };
  return (
    <section className="stack">
      <h2>{t('nav.compliance')}</h2>
      <ChargeReviews />
      <h3>{t('cmp.tasks')}</h3>
      {!tasks.data ? <Spinner /> : tasks.data.items.length === 0 ? <p className="ok">✓ {t('cmp.noTasks')}</p> : (
        <ul className="plain">{tasks.data.items.map((x) => (
          <li key={x.id} className="card inner small stack"><div className="row between"><strong>{x.title}</strong><span className="muted">{x.arrival}</span></div>
            <span className="muted">{x.guest} · {x.confirmationNo}{x.nationality ? ` · ${x.nationality}` : ''}</span>
            {can('compliance.task') && <button disabled={busy} onClick={() => complete(x.id)}>{t('cmp.done')}</button>}</li>))}</ul>)}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <h3>{t('cmp.rules')}</h3>
      {can('compliance.manage') && <div className="actions"><button className="primary" onClick={() => setEdit('new')}>{t('cmp.newRule')}</button></div>}
      {!rules.data ? <Spinner /> : rules.data.items.length === 0 ? <Empty text={t('cmp.noRules')} /> : (
        <ul className="plain rows">{rules.data.items.map((r) => (
          <li key={r.id}><button className="row-card" onClick={() => setEdit(r)}>
            <span className="rc-main"><strong>{r.name}</strong><span className="muted small">{t(`cmp.a.${r.action}` as Key)} · {r.stages.map((s) => t(`cmp.st.${s}` as Key)).join(' + ')}{r.conditions.nationalities?.length ? ` · ${r.conditions.nationalities.join(' ')}` : ''}{r.conditions.residency ? ` · ${t(`tax.res.${r.conditions.residency}` as Key)}` : ''}</span></span>
            <span className="rc-side"><Badge tone={tone(r.status)}>{t(`cmp.s.${r.status}` as Key)}</Badge></span></button></li>))}</ul>)}
      {edit && <RuleSheet rule={edit === 'new' ? null : edit} onDone={() => { setEdit(null); rules.reload(); }} onClose={() => setEdit(null)} />}
    </section>
  );
}

function RuleSheet({ rule, onDone, onClose }: { rule: Rule | null; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { can } = useAuth();
  const manage = can('compliance.manage');
  const k = rule?.conditions ?? {};
  const [f, setF] = useState({ name: rule?.name ?? '', action: rule?.action ?? 'WARN', booking: rule ? rule.stages.includes('BOOKING') : true, checkIn: rule ? rule.stages.includes('CHECK_IN') : false, nat: (k.nationalities ?? []).join(' '), notNat: (k.excludeNationalities ?? []).join(' '),
    residency: k.residency ?? '', minGuests: k.minGuests ? String(k.minGuests) : '', minNights: k.minNights ? String(k.minNights) : '', message: rule?.message ?? '', messageUr: rule?.messageUr ?? '', docs: rule?.documentTypes ?? [] as string[], task: rule?.taskTitle ?? '' });
  const { busy, problem, run } = useAction();
  const set = (key: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [key]: e.target.value });
  const body = () => ({ name: f.name.trim(), action: f.action, stages: [...(f.booking ? ['BOOKING'] : []), ...(f.checkIn ? ['CHECK_IN'] : [])], message: f.message.trim(), messageUr: f.messageUr.trim() || null, documentTypes: f.action === 'REQUIRE_DOCUMENT' ? f.docs : [],
    taskTitle: f.action === 'REQUIRE_TASK' ? f.task.trim() : null,
    conditions: { ...(codes(f.nat).length ? { nationalities: codes(f.nat) } : {}), ...(codes(f.notNat).length ? { excludeNationalities: codes(f.notNat) } : {}), ...(f.residency ? { residency: f.residency } : {}), ...(f.minGuests ? { minGuests: Number(f.minGuests) } : {}), ...(f.minNights ? { minNights: Number(f.minNights) } : {}) } });
  const save = async () => { if (await run(() => rule ? api('PATCH', `/v1/compliance/rules/${rule.id}`, { ...body(), version: rule.version }) : api('POST', '/v1/compliance/rules', body()))) onDone(); };
  const status = async (s: 'ACTIVE' | 'DISABLED') => { if (await run(() => api('PUT', `/v1/compliance/rules/${rule!.id}/status`, { status: s, version: rule!.version }))) onDone(); };
  const valid = f.name.trim().length >= 3 && f.message.trim().length >= 3 && (f.booking || f.checkIn) && (f.action !== 'REQUIRE_DOCUMENT' || f.docs.length > 0) && (f.action !== 'REQUIRE_TASK' || f.task.trim().length > 0);
  return (
    <Sheet title={rule ? rule.name : t('cmp.newRule')} onClose={onClose}>
      <fieldset disabled={!manage} className="stack" style={{ border: 0, padding: 0 }}>
        <label>{t('cmp.name')}<input value={f.name} onChange={set('name')} /></label>
        <label>{t('cmp.action')}<select value={f.action} onChange={set('action')}>{ACTIONS.map((a) => <option key={a} value={a}>{t(`cmp.a.${a}` as Key)}</option>)}</select></label>
        <div className="row"><label className="check"><input type="checkbox" checked={f.booking} onChange={(e) => setF({ ...f, booking: e.target.checked })} /> {t('cmp.st.BOOKING')}</label><label className="check"><input type="checkbox" checked={f.checkIn} onChange={(e) => setF({ ...f, checkIn: e.target.checked })} /> {t('cmp.st.CHECK_IN')}</label></div>
        <label>{t('cmp.nat')}<input value={f.nat} onChange={set('nat')} dir="ltr" placeholder="AF IR SY" /></label>
        <label>{t('cmp.notNat')}<input value={f.notNat} onChange={set('notNat')} dir="ltr" /></label>
        <div className="grid2"><label>{t('tax.residency')}<select value={f.residency} onChange={set('residency')}><option value="">{t('tax.res.ANY')}</option><option value="RESIDENT">{t('tax.res.RESIDENT')}</option><option value="NON_RESIDENT">{t('tax.res.NON_RESIDENT')}</option></select></label>
          <label>{t('cmp.minGuests')}<input inputMode="numeric" value={f.minGuests} onChange={set('minGuests')} dir="ltr" /></label></div>
        <label>{t('cmp.minNights')}<input inputMode="numeric" value={f.minNights} onChange={set('minNights')} dir="ltr" /></label>
        {f.action === 'REQUIRE_DOCUMENT' && <fieldset className="chips">{ID_TYPES.map((d) => <label key={d} className={`chip${f.docs.includes(d) ? ' on' : ''}`}><input type="checkbox" hidden checked={f.docs.includes(d)} onChange={() => setF({ ...f, docs: f.docs.includes(d) ? f.docs.filter((x) => x !== d) : [...f.docs, d] })} />{d}</label>)}</fieldset>}
        {f.action === 'REQUIRE_TASK' && <label>{t('cmp.taskTitle')}<input value={f.task} onChange={set('task')} /></label>}
        <label>{t('cmp.message')}<input value={f.message} onChange={set('message')} /></label>
        <label>{t('cmp.messageUr')}<input value={f.messageUr} onChange={set('messageUr')} dir="rtl" /></label>
      </fieldset>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {manage && <div className="actions"><button className="primary" disabled={busy || !valid} onClick={save}>{t('common.save')}</button>
        {rule && rule.status !== 'ACTIVE' && <button disabled={busy} onClick={() => status('ACTIVE')}>{t('cmp.activate')}</button>}{rule && rule.status === 'ACTIVE' && <button disabled={busy} onClick={() => status('DISABLED')}>{t('cmp.disable')}</button>}</div>}
    </Sheet>
  );
}
