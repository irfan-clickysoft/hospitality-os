import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';

interface RecipeRow { id: string; name: string; kind: 'DISH' | 'SUB_RECIPE'; active: boolean; menuItemId: string | null; dish: string | null; approvedVersion: number | null; hasDraft: boolean; costPerUnit: Amount | null; yieldQty: number | null; price: Amount | null; foodCostPct: number | null }
interface Line { id?: string; stockItemId: string | null; subRecipeId: string | null; name?: string; unit?: string; qty: number; wastePct: number; note: string | null }
interface Version { id: string; recipeId: string; versionNo: number; status: 'DRAFT' | 'APPROVED' | 'RETIRED'; yieldQty: number; yieldUnit: string; prepMinutes: number | null; cookMinutes: number | null; steps: string[]; equipment: string[]; cookingMethod: string | null; temperature: string | null; plating: string | null; foodSafety: string | null; changeNote: string | null; video: string | null; lines: Line[] }
interface Detail { id: string; name: string; kind: 'DISH' | 'SUB_RECIPE'; menuItemId: string | null; versions: Array<{ id: string; versionNo: number; status: string; changeNote: string | null; approvedAt: string | null }>; version: Version }
interface Cost { batch: Amount; perUnit: Amount; price: Amount | null; foodCostPct: number | null; margin: Amount | null; missingCosts: string[]; lines: Array<{ name: string; cost: Amount }>; yieldUnit: string }
interface Stock { id: string; name: string; unit: 'g' | 'ml' | 'pcs'; unitCost: Amount; costPerLarge: { per: string; amount: string }; onHand: number; reorderLevel: number | null; low: boolean; active: boolean; version: number }
const larger = (u: string) => (u === 'g' ? 'kg' : u === 'ml' ? 'l' : 'pcs');
const unitsFor = (u: string) => (u === 'g' ? ['g', 'kg'] : u === 'ml' ? ['ml', 'l'] : ['pcs']);
const num = (s: string) => (s.trim() === '' ? null : Number(s));
const tone = (s: string) => (s === 'APPROVED' ? 'clean' : s === 'DRAFT' ? 'warn' : 'neutral') as 'clean' | 'warn' | 'neutral';

/** Administration → Recipes & stock: what each dish is made of, how it is made, what it costs, and what is in the store. */
export function Recipes() {
  const { t } = useT();
  const [view, setView] = useState<'recipes' | 'stock'>('recipes');
  return (
    <section className="stack">
      <h2>{t('rc.title')}</h2>
      <div className="chips">{(['recipes', 'stock'] as const).map((v) => <Chip key={v} active={view === v} onClick={() => setView(v)}>{t(`rc.v.${v}` as Key)}</Chip>)}</div>
      {view === 'recipes' ? <RecipeList /> : <StockList />}
    </section>
  );
}

function RecipeList() {
  const { t } = useT();
  const { property } = useAuth();
  const b = `/v1/properties/${property!.id}`;
  const list = useLive<{ items: RecipeRow[] }>(`${b}/recipes`, 60_000);
  const [open, setOpen] = useState<string | null>(null); const [adding, setAdding] = useState(false);
  return (
    <div className="stack">
      <div className="actions"><button className="primary" onClick={() => setAdding(true)}>{t('rc.newRecipe')}</button></div>
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('rc.noRecipes')} /> : (
        <ul className="plain">{list.data.items.map((r) => (
          <li key={r.id} className={`card stack small${r.active ? '' : ' struck'}`}>
            <div className="row between"><strong>{r.name}</strong><span className="row"><Badge tone="neutral">{t(`rc.kind.${r.kind}` as Key)}</Badge>{r.approvedVersion ? <Badge tone="clean">{t('rc.approvedV', { n: r.approvedVersion })}</Badge> : <Badge tone="warn">{t('rc.notApproved')}</Badge>}{r.hasDraft && r.approvedVersion ? <Badge tone="warn">{t('rc.hasDraft')}</Badge> : null}</span></div>
            <span className="muted">{[r.dish && `${t('rc.dish')}: ${r.dish}`, r.costPerUnit && `${t(r.kind === 'DISH' ? 'rc.perPortion' : 'rc.perUnit')}: ${money(r.costPerUnit)}`, r.foodCostPct != null && `${t('rc.foodCost')}: ${r.foodCostPct}%`].filter(Boolean).join(' · ')}</span>
            <div className="row"><button onClick={() => setOpen(r.id)}>{t('rc.open')}</button></div>
          </li>))}</ul>)}
      {adding && <NewRecipe b={b} onDone={(id) => { setAdding(false); list.reload(); setOpen(id); }} onClose={() => setAdding(false)} />}
      {open && <Editor b={b} id={open} onClose={() => { setOpen(null); list.reload(); }} />}
    </div>
  );
}

function NewRecipe({ b, onDone, onClose }: { b: string; onDone: (id: string) => void; onClose: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction();
  const dishes = useLive<{ items: Array<{ id: string; name: string; active: boolean }> }>(`${b}/fnb/menu`, 300_000);
  const [name, setName] = useState(''); const [kind, setKind] = useState<'DISH' | 'SUB_RECIPE'>('DISH'); const [dish, setDish] = useState('');
  const go = async () => { const r = await run(() => api<{ id: string }>('POST', `${b}/recipes`, { name: name.trim(), kind, ...(kind === 'DISH' && dish ? { menuItemId: dish } : {}) })); if (r) onDone(r.id); };
  return (
    <Sheet title={t('rc.newRecipe')} onClose={onClose}>
      <div className="chips" role="group">{(['DISH', 'SUB_RECIPE'] as const).map((k) => <Chip key={k} active={kind === k} onClick={() => setKind(k)}>{t(`rc.kind.${k}` as Key)}</Chip>)}</div>
      <p className="muted small">{t(`rc.kindHelp.${kind}` as Key)}</p>
      <label>{t('rc.name')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      {kind === 'DISH' && <label>{t('rc.linkDish')}<select value={dish} onChange={(e) => setDish(e.target.value)}><option value="">—</option>{(dishes.data?.items ?? []).filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || name.trim().length < 2} onClick={go}>{t('common.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

interface Form { yieldQty: string; prep: string; cook: string; steps: string; equipment: string; method: string; temperature: string; plating: string; safety: string; note: string; lines: Array<{ kind: 'item' | 'sub'; id: string; qty: string; unit: string; waste: string; note: string }> }
const toForm = (v: Version): Form => ({ yieldQty: String(v.yieldQty), prep: v.prepMinutes?.toString() ?? '', cook: v.cookMinutes?.toString() ?? '', steps: v.steps.join('\n'), equipment: v.equipment.join(', '), method: v.cookingMethod ?? '', temperature: v.temperature ?? '', plating: v.plating ?? '', safety: v.foodSafety ?? '', note: v.changeNote ?? '',
  lines: v.lines.map((l) => ({ kind: l.stockItemId ? 'item' : 'sub', id: (l.stockItemId ?? l.subRecipeId)!, qty: String(l.qty), unit: l.unit ?? '', waste: String(l.wastePct), note: l.note ?? '' })) });

function Editor({ b, id, onClose }: { b: string; id: string; onClose: () => void }) {
  const { t } = useT(); const { can } = useAuth(); const { busy, problem, run, clear } = useAction();
  const [vid, setVid] = useState<string | undefined>(undefined);
  const d = useLive<Detail>(`${b}/recipes/${id}${vid ? `?versionId=${vid}` : ''}`, 300_000);
  const stock = useLive<{ items: Stock[] }>(`${b}/stock-items`, 300_000);
  const subs = useLive<{ items: RecipeRow[] }>(`${b}/recipes`, 300_000);
  const [f, setF] = useState<Form | null>(null); const loaded = useRef('');
  const cost = useLive<Cost>(d.data ? `${b}/recipe-versions/${d.data.version.id}/cost` : null, 300_000);
  const pick = useRef<HTMLInputElement>(null);
  useEffect(() => { const v = d.data?.version; if (!v || loaded.current === v.id + JSON.stringify(v.lines.length) + v.status) return; loaded.current = v.id + JSON.stringify(v.lines.length) + v.status; setF(toForm(v)); }, [d.data]);
  if (!d.data || !f) return <Sheet title="…" onClose={onClose}><Spinner /></Sheet>;
  const v = d.data.version; const draft = v.status === 'DRAFT'; const dish = d.data.kind === 'DISH';
  const set = (p: Partial<Form>) => setF({ ...f, ...p });
  const setLine = (i: number, p: Partial<Form['lines'][number]>) => set({ lines: f.lines.map((l, k) => (k === i ? { ...l, ...p } : l)) });
  const unitOf = (l: Form['lines'][number]) => (l.kind === 'item' ? stock.data?.items.find((s) => s.id === l.id)?.unit : v.lines.find((x) => x.subRecipeId === l.id)?.unit ?? 'g') ?? 'g';
  const body = () => ({
    yieldQty: Number(f.yieldQty) || 1, yieldUnit: dish ? 'portion' : v.yieldUnit === 'portion' ? 'g' : v.yieldUnit, prepMinutes: num(f.prep), cookMinutes: num(f.cook),
    steps: f.steps.split('\n').map((x) => x.trim()).filter(Boolean), equipment: f.equipment.split(/[,،]/).map((x) => x.trim()).filter(Boolean),
    cookingMethod: f.method.trim() || null, temperature: f.temperature.trim() || null, plating: f.plating.trim() || null, foodSafety: f.safety.trim() || null, changeNote: f.note.trim() || null,
    lines: f.lines.filter((l) => l.id).map((l) => ({ ...(l.kind === 'item' ? { stockItemId: l.id } : { subRecipeId: l.id }), qty: Number(l.qty), unit: l.kind === 'item' ? l.unit || undefined : undefined, wastePct: Number(l.waste) || 0, note: l.note.trim() || null })),
  });
  const save = async () => { const r = await run(() => api('PUT', `${b}/recipe-versions/${v.id}`, body())); if (r) { loaded.current = ''; d.reload(); cost.reload(); } return !!r; };
  const approve = async () => { if (await save() && (await run(() => api('POST', `${b}/recipe-versions/${v.id}/approve`, {})))) { loaded.current = ''; d.reload(); cost.reload(); } };
  const newVersion = async () => { const r = await run(() => api<{ id: string }>('POST', `${b}/recipes/${id}/versions`, {})); if (r) { setVid(r.id); loaded.current = ''; d.reload(); } };
  const upload = async (files: FileList | null) => { const file = files?.[0]; if (!file) return; const fd = new FormData(); fd.append('file', file); if (await run(() => api('POST', `${b}/recipe-versions/${v.id}/video`, fd))) { loaded.current = ''; d.reload(); } };
  const dropVideo = async () => { if (await run(() => api('DELETE', `${b}/recipe-versions/${v.id}/video`))) { loaded.current = ''; d.reload(); } };
  const ro = !draft;
  return (
    <Sheet title={d.data.name} onClose={onClose}>
      <div className="chips" role="group" aria-label={t('rc.versions')}>{d.data.versions.map((x) => <Chip key={x.id} active={x.id === v.id} onClick={() => { setVid(x.id); loaded.current = ''; }}>v{x.versionNo} · {t(`rc.s.${x.status}` as Key)}</Chip>)}</div>
      <div className="row"><Badge tone={tone(v.status)}>{t(`rc.s.${v.status}` as Key)}</Badge>{v.changeNote && <span className="muted small">{v.changeNote}</span>}</div>
      {ro && <p className="muted small">{t('rc.readOnly')}</p>}
      <fieldset className="stack" disabled={ro}><legend>{t('rc.sec.yield')}</legend>
        <div className="grid2"><label>{dish ? t('rc.yieldPortions') : t('rc.yieldAmount', { u: v.yieldUnit === 'portion' ? 'g' : v.yieldUnit })}<input inputMode="decimal" value={f.yieldQty} onChange={(e) => set({ yieldQty: e.target.value })} dir="ltr" /></label>
          {!dish && <label>{t('rc.yieldUnit')}<select value={v.yieldUnit} disabled>{['g', 'ml', 'pcs'].map((u) => <option key={u}>{u}</option>)}</select></label>}</div>
        <div className="grid2"><label>{t('rc.prepMin')}<input inputMode="numeric" value={f.prep} onChange={(e) => set({ prep: e.target.value })} dir="ltr" /></label><label>{t('rc.cookMin')}<input inputMode="numeric" value={f.cook} onChange={(e) => set({ cook: e.target.value })} dir="ltr" /></label></div>
      </fieldset>
      <fieldset className="stack" disabled={ro}><legend>{t('rc.sec.ingredients')}</legend>
        {f.lines.map((l, i) => (
          <div key={i} className="card inner stack small">
            <div className="grid2">
              <label>{t('rc.ingredient')}<select value={`${l.kind}:${l.id}`} onChange={(e) => { const [k, ...r] = e.target.value.split(':'); const nk = k as 'item' | 'sub'; const nid = r.join(':'); setLine(i, { kind: nk, id: nid, unit: nk === 'item' ? stock.data?.items.find((s) => s.id === nid)?.unit ?? '' : 'g' }); }}>
                <option value="item:">—</option>
                <optgroup label={t('rc.stockItems')}>{(stock.data?.items ?? []).map((s) => <option key={s.id} value={`item:${s.id}`}>{s.name} ({s.unit})</option>)}</optgroup>
                <optgroup label={t('rc.subRecipes')}>{(subs.data?.items ?? []).filter((s) => s.kind === 'SUB_RECIPE' && s.active && s.id !== id).map((s) => <option key={s.id} value={`sub:${s.id}`}>{s.name}</option>)}</optgroup></select></label>
              <div className="grid2"><label>{t('rc.qty')}<input inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} dir="ltr" /></label>
                <label>{t('rc.unit')}<select value={l.unit || unitOf(l)} onChange={(e) => setLine(i, { unit: e.target.value })}>{(l.kind === 'item' ? unitsFor(unitOf(l)) : [unitOf(l)]).map((u) => <option key={u}>{u}</option>)}</select></label></div>
            </div>
            <div className="grid2"><label>{t('rc.waste')}<input inputMode="decimal" value={l.waste} onChange={(e) => setLine(i, { waste: e.target.value })} dir="ltr" /></label><label>{t('rc.lineNote')}<input value={l.note} onChange={(e) => setLine(i, { note: e.target.value })} /></label></div>
            {!ro && <button type="button" className="link" onClick={() => set({ lines: f.lines.filter((_, k) => k !== i) })}>{t('mn.remove')}</button>}
          </div>))}
        {!ro && <button type="button" onClick={() => set({ lines: [...f.lines, { kind: 'item', id: '', qty: '', unit: '', waste: '0', note: '' }] })}>{t('rc.addLine')}</button>}
        {stock.data && stock.data.items.length === 0 && <p className="muted small">{t('rc.noStock')}</p>}
      </fieldset>
      <fieldset className="stack" disabled={ro}><legend>{t('rc.sec.method')}</legend>
        <label>{t('rc.steps')}<textarea rows={6} value={f.steps} onChange={(e) => set({ steps: e.target.value })} /></label><p className="muted small">{t('rc.stepsHint')}</p>
        <label>{t('rc.equipment')}<input value={f.equipment} onChange={(e) => set({ equipment: e.target.value })} placeholder={t('mn.commaHint')} /></label>
        <div className="grid2"><label>{t('rc.method')}<input value={f.method} onChange={(e) => set({ method: e.target.value })} /></label><label>{t('rc.temperature')}<input value={f.temperature} onChange={(e) => set({ temperature: e.target.value })} /></label></div>
        <label>{t('rc.plating')}<textarea rows={2} value={f.plating} onChange={(e) => set({ plating: e.target.value })} /></label>
        <label>{t('rc.safety')}<textarea rows={2} value={f.safety} onChange={(e) => set({ safety: e.target.value })} /></label>
        {draft && <label>{t('rc.changeNote')}<input value={f.note} onChange={(e) => set({ note: e.target.value })} /></label>}
      </fieldset>
      <fieldset className="stack"><legend>{t('rc.sec.video')}</legend>
        {v.video ? <video src={v.video} controls preload="metadata" style={{ maxWidth: '100%' }} aria-label={t('rc.video')} /> : <span className="muted small">{t('rc.noVideo')}</span>}
        {draft && <div className="row"><input ref={pick} type="file" hidden accept="video/mp4,video/webm" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} /><button type="button" disabled={busy} onClick={() => pick.current?.click()}>{busy ? t('ps.uploading') : v.video ? t('rc.replaceVideo') : t('rc.addVideo')}</button>{v.video && <button type="button" className="link" disabled={busy} onClick={dropVideo}>{t('mn.remove')}</button>}</div>}
      </fieldset>
      <fieldset className="stack"><legend>{t('rc.sec.cost')}</legend>
        {!cost.data ? <Spinner /> : (<>
          <div className="row between"><span>{t('rc.batch')}</span><strong>{money(cost.data.batch)}</strong></div>
          <div className="row between"><span>{t(dish ? 'rc.perPortion' : 'rc.perUnit')}</span><strong>{money(cost.data.perUnit)}</strong></div>
          {cost.data.price && <div className="row between"><span>{t('rc.menuPrice')}</span><span>{money(cost.data.price)}{cost.data.foodCostPct != null ? ` · ${t('rc.foodCost')} ${cost.data.foodCostPct}%` : ''}</span></div>}
          {cost.data.margin && <div className="row between"><span>{t('rc.margin')}</span><span>{money(cost.data.margin)}</span></div>}
          {cost.data.missingCosts.length > 0 && <p className="warnbox">{t('rc.missingCosts')}: {cost.data.missingCosts.join(', ')}</p>}
          {draft && <p className="muted small">{t('rc.costAfterSave')}</p>}
        </>)}
      </fieldset>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions">
        {draft && <button disabled={busy} onClick={() => { clear(); void save(); }}>{t('rc.saveDraft')}</button>}
        {draft && can('recipe.approve') && <button className="primary" disabled={busy} onClick={() => { clear(); void approve(); }}>{t('rc.approve')}</button>}
        {!draft && !d.data.versions.some((x) => x.status === 'DRAFT') && <button className="primary" disabled={busy} onClick={newVersion}>{t('rc.newVersion')}</button>}
        <button onClick={onClose}>{t('common.close')}</button>
      </div>
      {draft && !can('recipe.approve') && <p className="muted small">{t('rc.needsApprover')}</p>}
    </Sheet>
  );
}

function StockList() {
  const { t } = useT();
  const { property } = useAuth();
  const b = `/v1/properties/${property!.id}`;
  const list = useLive<{ items: Stock[] }>(`${b}/stock-items`, 60_000);
  const [adding, setAdding] = useState(false); const [mv, setMv] = useState<{ s: Stock; kind: 'RECEIVE' | 'WASTE' | 'ADJUST' } | null>(null);
  return (
    <div className="stack">
      <div className="actions"><button className="primary" onClick={() => setAdding(true)}>{t('rc.addStock')}</button></div>
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('rc.noStock')} /> : (
        <ul className="plain">{list.data.items.map((s) => (
          <li key={s.id} className="card stack small">
            <div className="row between"><strong>{s.name}</strong>{s.low && <Badge tone="warn">{t('rc.low')}</Badge>}</div>
            <span>{t('rc.onHand')}: <strong>{s.onHand}</strong> {s.unit}{s.onHand < 0 ? ` · ${t('rc.negative')}` : ''}<span className="muted"> · {money({ amount: s.costPerLarge.amount, currency: s.unitCost.currency })} / {s.costPerLarge.per}{s.reorderLevel != null ? ` · ${t('rc.reorderAt', { n: s.reorderLevel })}` : ''}</span></span>
            <div className="row"><button onClick={() => setMv({ s, kind: 'RECEIVE' })}>{t('rc.receive')}</button><button onClick={() => setMv({ s, kind: 'WASTE' })}>{t('rc.waste2')}</button><button onClick={() => setMv({ s, kind: 'ADJUST' })}>{t('rc.count')}</button></div>
          </li>))}</ul>)}
      {adding && <StockSheet b={b} onDone={() => { setAdding(false); list.reload(); }} onClose={() => setAdding(false)} />}
      {mv && <MoveSheet b={b} s={mv.s} kind={mv.kind} onDone={() => { setMv(null); list.reload(); }} onClose={() => setMv(null)} />}
    </div>
  );
}

function StockSheet({ b, onDone, onClose }: { b: string; onDone: () => void; onClose: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction();
  const [name, setName] = useState(''); const [unit, setUnit] = useState<'g' | 'ml' | 'pcs'>('g'); const [cost, setCost] = useState(''); const [per, setPer] = useState('kg'); const [re, setRe] = useState('');
  useEffect(() => { setPer(larger(unit)); }, [unit]);
  const go = async () => { if (await run(() => api('POST', `${b}/stock-items`, { name: name.trim(), unit, cost: cost.trim() || '0', costPer: per, ...(re.trim() ? { reorderLevel: Number(re) } : {}) }))) onDone(); };
  return (
    <Sheet title={t('rc.addStock')} onClose={onClose}>
      <label>{t('rc.name')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>{t('rc.countedIn')}<select value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>{['g', 'ml', 'pcs'].map((u) => <option key={u}>{u}</option>)}</select></label>
      <div className="grid2"><label>{t('rc.cost')}<input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} dir="ltr" /></label><label>{t('rc.costPer')}<select value={per} onChange={(e) => setPer(e.target.value)}>{[unit, ...unitsFor(unit).filter((u) => u !== unit)].map((u) => <option key={u}>{u}</option>)}</select></label></div>
      <label>{t('rc.reorder', { u: unit })}<input inputMode="decimal" value={re} onChange={(e) => setRe(e.target.value)} dir="ltr" /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || name.trim().length < 2} onClick={go}>{t('common.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function MoveSheet({ b, s, kind, onDone, onClose }: { b: string; s: Stock; kind: 'RECEIVE' | 'WASTE' | 'ADJUST'; onDone: () => void; onClose: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction();
  const [qty, setQty] = useState(''); const [unit, setUnit] = useState<string>(s.unit); const [cost, setCost] = useState(''); const [per, setPer] = useState(larger(s.unit)); const [note, setNote] = useState('');
  const go = async () => {
    const body = kind === 'RECEIVE' ? { kind, qty: Number(qty), unit, ...(cost.trim() ? { cost: cost.trim(), costPer: per } : {}), ...(note.trim() ? { note: note.trim() } : {}) } : kind === 'WASTE' ? { kind, qty: Number(qty), unit, note: note.trim() } : { kind, counted: Number(qty), unit, note: note.trim() };
    if (await run(() => api('POST', `${b}/stock-items/${s.id}/movements`, body))) onDone();
  };
  return (
    <Sheet title={`${s.name} · ${t(`rc.mv.${kind}` as Key)}`} onClose={onClose}>
      <div className="grid2"><label>{kind === 'ADJUST' ? t('rc.counted') : t('rc.qty')}<input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} dir="ltr" /></label><label>{t('rc.unit')}<select value={unit} onChange={(e) => setUnit(e.target.value)}>{unitsFor(s.unit).map((u) => <option key={u}>{u}</option>)}</select></label></div>
      {kind === 'RECEIVE' && <div className="grid2"><label>{t('rc.cost')}<input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} dir="ltr" /></label><label>{t('rc.costPer')}<select value={per} onChange={(e) => setPer(e.target.value)}>{[s.unit, ...unitsFor(s.unit).filter((u) => u !== s.unit)].map((u) => <option key={u}>{u}</option>)}</select></label></div>}
      <label>{t(kind === 'RECEIVE' ? 'common.note' : 'rc.why')}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || qty.trim() === '' || (kind !== 'RECEIVE' && note.trim().length < 3)} onClick={go}>{t('common.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

/** What a cook sees for a dish: ingredients, steps, equipment, plating, food safety and the how-to video. No costs. */
export function RecipeCard({ base, itemId, name, onClose }: { base: string; itemId: string; name: string; onClose: () => void }) {
  const { t } = useT();
  const c = useLive<{ available: boolean; versionNo: number; yieldQty: number; prepMinutes: number | null; cookMinutes: number | null; steps: string[]; equipment: string[]; cookingMethod: string | null; temperature: string | null; plating: string | null; foodSafety: string | null; video: string | null; ingredients: Array<{ name: string; qty: number; unit: string; note: string | null }> }>(`${base}/menu-items/${itemId}/recipe-card`, 600_000);
  return (
    <Sheet title={name} onClose={onClose}>
      {!c.data ? <Spinner /> : !c.data.available ? <Empty text={t('rc.noCard')} /> : (<>
        <span className="muted small">{t('rc.cardMakes', { n: c.data.yieldQty })}{c.data.prepMinutes != null ? ` · ${t('rc.prepShort', { n: c.data.prepMinutes })}` : ''}{c.data.cookMinutes != null ? ` · ${t('rc.cookShort', { n: c.data.cookMinutes })}` : ''}</span>
        {c.data.video && <video src={c.data.video} controls preload="metadata" style={{ maxWidth: '100%' }} aria-label={t('rc.video')} />}
        <h3>{t('rc.sec.ingredients')}</h3><ul className="plain small">{c.data.ingredients.map((i, k) => <li key={k}>{i.qty} {i.unit} {i.name}{i.note ? ` — ${i.note}` : ''}</li>)}</ul>
        <h3>{t('rc.steps')}</h3><ol className="small">{c.data.steps.map((s, k) => <li key={k}>{s}</li>)}</ol>
        {c.data.equipment.length > 0 && <p><strong>{t('rc.equipment')}:</strong> {c.data.equipment.join(', ')}</p>}
        {(c.data.cookingMethod || c.data.temperature) && <p><strong>{t('rc.method')}:</strong> {[c.data.cookingMethod, c.data.temperature].filter(Boolean).join(' · ')}</p>}
        {c.data.plating && <p><strong>{t('rc.plating')}:</strong> {c.data.plating}</p>}
        {c.data.foodSafety && <p className="warnbox"><strong>{t('rc.safety')}:</strong> {c.data.foodSafety}</p>}
      </>)}
    </Sheet>
  );
}
