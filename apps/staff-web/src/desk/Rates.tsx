import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { useAuth, useLive } from '../state.js';
import { Chip, ErrorLine, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';

interface Plan { id: string; code: string; name: string; kind: 'BASE' | 'DERIVED'; parentPlanId: string | null; derive: { type: string; value: number | string; roundTo: string } | null; extraBed: Amount; status: string; version: number }
interface PlanDetail extends Plan { baseRates: Array<{ roomTypeId: string; amount: Amount; weekendAmount: Amount | null; extraAdult: Amount; extraChild: Amount }> }
interface RoomType { id: string; code: string; name: string; maxAdults: number; maxOccupancy: number; baseOccupancy: number; status: string; version: number }
interface Property { id: string; weekendDays: number[]; version: number }
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONEY = /^\d{1,9}(\.\d{1,2})?$/;

/** Prices per room type, extra-person prices, the weekend, and how many people each room type sleeps — editable by whoever manages rates. */
export function Rates() {
  const { t } = useT();
  const { property } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const plans = useLive<{ items: Plan[] }>(`${base}/rate-plans`, 120_000);
  const [pick, setPick] = useState('');
  const list = (plans.data?.items ?? []).filter((p) => p.status === 'ACTIVE');
  const plan = list.find((p) => p.id === pick) ?? list.find((p) => p.kind === 'BASE') ?? list[0];
  return (
    <section className="stack">
      <h2>{t('nav.rates')}</h2>
      {!plans.data ? <Spinner /> : <>
        <WeekendCard base={base} />
        <div className="chips">{list.map((p) => <Chip key={p.id} active={plan?.id === p.id} onClick={() => setPick(p.id)}>{p.name}</Chip>)}</div>
        {plan && <PlanEditor key={plan.id} base={base} plan={plan} all={list} onSaved={plans.reload} />}
        <p className="muted small">{t('rt.taxNote')}</p>
      </>}
    </section>
  );
}

function WeekendCard({ base }: { base: string }) {
  const { t } = useT();
  const { can } = useAuth();
  const prop = useLive<Property>(base, 120_000);
  const { busy, problem, run } = useAction();
  if (!prop.data) return null;
  const days = prop.data.weekendDays;
  const toggle = async (d: number) => { const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d]; if (await run(() => api('PATCH', base, { weekendDays: next, version: prop.data!.version }))) prop.reload(); };
  return (
    <div className="card inner stack">
      <strong>{t('rt.weekend')}</strong>
      <div className="chips" role="group">{DAYS.map((n, i) => <button key={n} type="button" disabled={busy || !can('property.manage')} className={`chip${days.includes(i + 1) ? ' on' : ''}`} aria-pressed={days.includes(i + 1)} onClick={() => toggle(i + 1)}>{n}</button>)}</div>
      <span className="muted small">{t('rt.weekendHelp')}</span>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </div>
  );
}

function PlanEditor({ base, plan, all, onSaved }: { base: string; plan: Plan; all: Plan[]; onSaved: () => void }) {
  const { t } = useT();
  const { can } = useAuth();
  const detail = useLive<PlanDetail>(`${base}/rate-plans/${plan.id}`, 120_000);
  const types = useLive<{ items: RoomType[] }>(`${base}/room-types`, 120_000);
  const edit = can('rate.manage');
  if (!detail.data || !types.data) return <Spinner />;
  const reload = () => { detail.reload(); types.reload(); onSaved(); };
  return plan.kind === 'DERIVED'
    ? <DerivedEditor base={base} plan={detail.data} parent={all.find((p) => p.id === plan.parentPlanId)} edit={edit} onSaved={reload} />
    : <BaseEditor base={base} plan={detail.data} types={types.data.items.filter((x) => x.status === 'ACTIVE')} edit={edit} onSaved={reload} />;
}

function BaseEditor({ base, plan, types, edit, onSaved }: { base: string; plan: PlanDetail; types: RoomType[]; edit: boolean; onSaved: () => void }) {
  const { t } = useT();
  const { can } = useAuth();
  const init = (id: string) => { const r = plan.baseRates.find((x) => x.roomTypeId === id); return { amount: r?.amount.amount ?? '', weekend: r?.weekendAmount?.amount ?? '', xa: r?.extraAdult.amount ?? '0', xc: r?.extraChild.amount ?? '0' }; };
  const [rows, setRows] = useState(() => Object.fromEntries(types.map((x) => [x.id, { ...init(x.id), maxAdults: String(x.maxAdults), maxOcc: String(x.maxOccupancy) }])));
  const [bed, setBed] = useState(plan.extraBed.amount);
  const { busy, problem, run, setProblem } = useAction();
  const set = (id: string, k: string, v: string) => setRows((r) => ({ ...r, [id]: { ...r[id]!, [k]: v } }));
  const bad = types.some((x) => { const r = rows[x.id]!; return !MONEY.test(r.amount) || (r.weekend !== '' && !MONEY.test(r.weekend)) || !MONEY.test(r.xa) || !MONEY.test(r.xc) || !/^\d+$/.test(r.maxAdults) || !/^\d+$/.test(r.maxOcc) || Number(r.maxAdults) < 1 || Number(r.maxOcc) < Number(r.maxAdults); }) || !MONEY.test(bed);
  const save = async () => {
    setProblem(null);
    const ok = await run(async () => {
      await api('PUT', `${base}/rate-plans/${plan.id}/base-rates`, { items: types.map((x) => { const r = rows[x.id]!; return { roomTypeId: x.id, amount: r.amount, weekendAmount: r.weekend === '' ? null : r.weekend, extraAdult: r.xa, extraChild: r.xc }; }) });
      if (bed !== plan.extraBed.amount) await api('PATCH', `${base}/rate-plans/${plan.id}`, { extraBed: bed, version: plan.version });
      if (can('property.manage')) for (const x of types) {
        const r = rows[x.id]!;
        if (Number(r.maxAdults) !== x.maxAdults || Number(r.maxOcc) !== x.maxOccupancy) await api('PATCH', `${base}/room-types/${x.id}`, { maxAdults: Number(r.maxAdults), maxOccupancy: Number(r.maxOcc), baseOccupancy: Math.min(x.baseOccupancy, Number(r.maxOcc)), version: x.version });
      }
      return true;
    });
    if (ok) onSaved();
  };
  return (
    <div className="stack">
      <ul className="plain">{types.map((x) => { const r = rows[x.id]!; return (
        <li key={x.id} className="card inner stack small">
          <strong>{x.name}</strong>
          <div className="grid2"><label>{t('rt.price')}<input inputMode="decimal" disabled={!edit} value={r.amount} onChange={(e) => set(x.id, 'amount', e.target.value)} dir="ltr" /></label>
            <label>{t('rt.weekendPrice')}<input inputMode="decimal" disabled={!edit} value={r.weekend} placeholder={t('rt.sameAsWeekday')} onChange={(e) => set(x.id, 'weekend', e.target.value)} dir="ltr" /></label></div>
          <div className="grid2"><label>{t('rt.extraAdult')}<input inputMode="decimal" disabled={!edit} value={r.xa} onChange={(e) => set(x.id, 'xa', e.target.value)} dir="ltr" /></label>
            <label>{t('rt.extraChild')}<input inputMode="decimal" disabled={!edit} value={r.xc} onChange={(e) => set(x.id, 'xc', e.target.value)} dir="ltr" /></label></div>
          <div className="grid2"><label>{t('rt.maxAdults')}<input inputMode="numeric" disabled={!edit || !can('property.manage')} value={r.maxAdults} onChange={(e) => set(x.id, 'maxAdults', e.target.value.replace(/\D/g, ''))} dir="ltr" /></label>
            <label>{t('rt.maxPeople')}<input inputMode="numeric" disabled={!edit || !can('property.manage')} value={r.maxOcc} onChange={(e) => set(x.id, 'maxOcc', e.target.value.replace(/\D/g, ''))} dir="ltr" /></label></div>
        </li>); })}</ul>
      <label>{t('rt.extraBed')}<input inputMode="decimal" disabled={!edit} value={bed} onChange={(e) => setBed(e.target.value)} dir="ltr" /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {edit && <div className="actions"><button className="primary" disabled={busy || bad} onClick={save}>{t('rt.save')}</button></div>}
    </div>
  );
}

function DerivedEditor({ base, plan, parent, edit, onSaved }: { base: string; plan: PlanDetail; parent: Plan | undefined; edit: boolean; onSaved: () => void }) {
  const { t } = useT();
  const percent = plan.derive?.type === 'PERCENT' ? String(Number(plan.derive.value) / 100) : '';
  const [pct, setPct] = useState(percent);
  const { busy, problem, run } = useAction();
  const ok = /^-?\d{1,3}(\.\d{1,2})?$/.test(pct);
  const save = async () => { if (await run(() => api('PATCH', `${base}/rate-plans/${plan.id}`, { derive: { parentPlanId: plan.parentPlanId, type: 'PERCENT', value: Math.round(Number(pct) * 100), roundTo: plan.derive?.roundTo ?? '1' }, version: plan.version }))) onSaved(); };
  return (
    <div className="card inner stack">
      <p>{t('rt.derived', { parent: parent?.name ?? '' })}</p>
      {plan.derive?.type === 'PERCENT'
        ? <label>{t('rt.percent')}<input inputMode="decimal" disabled={!edit} value={pct} onChange={(e) => setPct(e.target.value)} dir="ltr" /></label>
        : <p className="muted">{t('rt.fixedDerive')}</p>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {edit && plan.derive?.type === 'PERCENT' && <div className="actions"><button className="primary" disabled={busy || !ok} onClick={save}>{t('rt.save')}</button></div>}
    </div>
  );
}
