import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';

export const ALLERGENS = ['NUTS', 'PEANUTS', 'DAIRY', 'EGGS', 'GLUTEN', 'SHELLFISH', 'FISH', 'SOY', 'SESAME', 'MUSTARD', 'CELERY', 'SULPHITES'] as const;
export const DIETARY = ['HALAL', 'KOSHER', 'VEGETARIAN', 'VEGAN', 'GLUTEN_FREE', 'DAIRY_FREE'] as const;
const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const OUTLET_KINDS = ['RESTAURANT', 'ROOM_SERVICE', 'CAFE', 'BAR', 'BANQUET', 'OTHER'] as const;

export interface Card {
  id: string; categoryId: string | null; name: string; nameUr: string | null; shortDescription: string | null; price: Amount; discountedPrice: Amount | null; serves: number | null; servingSize: string | null;
  prepMinMinutes: number | null; prepMaxMinutes: number | null; dietary: string[]; spiceLevel: number | null; allergensContain: string[]; availability: string; limitedQuantity: number | null; active: boolean;
  orderable: boolean; unavailableReason: string | null; image: string | null; variants: number; hasModifiers: boolean; version: number;
}
interface Category { id: string; name: string; nameUr: string | null; items: Card[] }
interface MenuT { id: string; name: string; days: number[]; availableFrom: string | null; availableTo: string | null; status: string; categories: Category[] }
export interface Tree { outlet: { id: string; name: string; kind: string; status: string; description: string | null; openingNote: string | null }; currency: string; menus: MenuT[] }
interface Outlet { id: string; name: string; kind: string; status: string; menus: number; items: number }
interface Group { id: string; name: string; minSelect: number; maxSelect: number; active: boolean; options: Array<{ id: string; name: string; priceDelta: Amount; active: boolean }> }
interface Detail extends Card {
  description: string | null; portionAmount: string | null; days: number[] | null; availableFrom: string | null; availableTo: string | null; ingredients: string[]; removableIngredients: string[]; allergensMay: string[];
  calories: number | null; proteinG: number | null; carbsG: number | null; fatG: number | null; sodiumMg: number | null; cuisine: string | null; temperature: string | null; pairings: string | null;
  minQuantity: number; maxQuantity: number; specialInstructions: boolean; category: string; menuId: string | null; outletId: string | null;
  variantList: Array<{ id: string; name: string; price: Amount; serves: number | null; active: boolean }>; modifierGroups: Group[];
  media: Array<{ id: string; kind: 'IMAGE' | 'VIDEO'; url: string; altText: string | null; isPrimary: boolean }>;
}

const list = (s: string) => s.split(/[,\n،]/).map((x) => x.trim()).filter(Boolean);
const num = (s: string) => (s.trim() === '' ? null : Number(s));

/** The one-line summary a guest sees: "PKR 1,850 · Serves 2 · 35–45 min". */
export function useFacts() {
  const { t } = useT();
  return (c: Card) => [
    money(c.discountedPrice ?? c.price),
    c.serves ? t('mn.serves', { n: c.serves }) : null,
    c.prepMinMinutes != null && c.prepMaxMinutes != null ? t('mn.prep', { a: c.prepMinMinutes, b: c.prepMaxMinutes }) : null,
  ].filter(Boolean).join(' · ');
}
export function useTags() {
  const { t } = useT();
  return (c: Card) => [...c.dietary.map((d) => t(`mn.di.${d}` as Key)), c.spiceLevel ? t(`mn.spice.${c.spiceLevel}` as Key) : null].filter(Boolean).join(' · ');
}

/** The menu card: name, short description, price · serves · time, dietary · spice. */
export function ItemCard({ c, locale, action }: { c: Card; locale: string; action?: React.ReactNode }) {
  const { t } = useT(); const facts = useFacts(); const tags = useTags();
  return (
    <div className={`card stack small${c.active ? '' : ' struck'}`}>
      <div className="row between">
        <div className="stack" style={{ gap: 2 }}>
          <strong>{locale === 'ur' && c.nameUr ? c.nameUr : c.name}</strong>
          {c.shortDescription && <span className="muted">{c.shortDescription}</span>}
          <span>{c.discountedPrice && <s className="muted">{money(c.price)} </s>}{facts(c)}</span>
          {tags(c) && <span className="muted">{tags(c)}</span>}
          {!c.orderable && c.unavailableReason && <Badge tone="warn">{t(`mn.why.${c.unavailableReason}` as Key)}</Badge>}
          {c.availability === 'LIMITED' && c.limitedQuantity != null && <span className="muted">{t('mn.left', { n: c.limitedQuantity })}</span>}
        </div>
        {c.image && <img src={c.image} alt={c.name} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 10 }} />}
      </div>
      {action}
    </div>
  );
}

/** Administration → Menu & outlets: where the restaurant, its menus and every dish are set up. */
export function Menus() {
  const { t, locale } = useT();
  const { property } = useAuth();
  const b = `/v1/properties/${property!.id}`;
  const outlets = useLive<{ items: Outlet[] }>(`${b}/outlets`, 120_000);
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false); const [groups, setGroups] = useState(false);
  const cur = sel ?? outlets.data?.items[0]?.id ?? null;
  const tree = useLive<Tree>(cur ? `${b}/outlets/${cur}/menu?all=true` : null, 60_000);
  const { busy, problem, run } = useAction();
  const reload = () => { outlets.reload(); tree.reload(); };
  const [editing, setEditing] = useState<{ id: string | null; categoryId: string } | null>(null);
  const [newMenu, setNewMenu] = useState(false);
  if (!outlets.data) return <Spinner />;
  const toggleOutlet = async () => { if (tree.data && await run(() => api('PATCH', `${b}/outlets/${cur}`, { status: tree.data!.outlet.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }))) reload(); };
  return (
    <section className="stack">
      <h2>{t('mn.title')}</h2>
      <div className="chips">
        {outlets.data.items.map((o) => <Chip key={o.id} active={o.id === cur} onClick={() => setSel(o.id)}>{o.name}{o.status !== 'ACTIVE' ? ` · ${t('mn.closed')}` : ''}</Chip>)}
        <Chip onClick={() => setAdding(true)}>+ {t('mn.addOutlet')}</Chip>
      </div>
      <div className="actions"><button onClick={() => setGroups(true)}>{t('mn.groups')}</button></div>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {!cur ? <Empty text={t('mn.noOutlets')} /> : !tree.data ? <Spinner /> : (<>
        <div className="card stack small">
          <div className="row between"><strong>{tree.data.outlet.name} · {t(`mn.kind.${tree.data.outlet.kind}` as Key)}</strong>
            <button disabled={busy} onClick={toggleOutlet}>{tree.data.outlet.status === 'ACTIVE' ? t('mn.closeOutlet') : t('mn.openOutlet')}</button></div>
          {tree.data.outlet.description && <span className="muted">{tree.data.outlet.description}</span>}
        </div>
        {tree.data.menus.map((m) => <MenuBlock key={m.id} b={b} m={m} locale={locale} onChange={reload} onEdit={(id, categoryId) => setEditing({ id, categoryId })} />)}
        <div className="actions"><button className="primary" onClick={() => setNewMenu(true)}>{t('mn.addMenu')}</button></div>
      </>)}
      {adding && <OutletSheet b={b} onDone={(id) => { setAdding(false); setSel(id); reload(); }} onClose={() => setAdding(false)} />}
      {newMenu && cur && <MenuSheet b={b} outletId={cur} onDone={() => { setNewMenu(false); reload(); }} onClose={() => setNewMenu(false)} />}
      {editing && <ItemEditor b={b} itemId={editing.id} categoryId={editing.categoryId} cats={(tree.data?.menus ?? []).flatMap((m) => m.categories.map((c) => ({ id: c.id, label: `${m.name} · ${c.name}` })))} onChange={reload} onClose={() => { setEditing(null); reload(); }} />}
      {groups && <GroupsSheet b={b} onClose={() => setGroups(false)} />}
    </section>
  );
}

function OutletSheet({ b, onDone, onClose }: { b: string; onDone: (id: string) => void; onClose: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction();
  const [name, setName] = useState(''); const [kind, setKind] = useState<string>('RESTAURANT'); const [desc, setDesc] = useState('');
  const go = async () => { const r = await run(() => api<{ id: string }>('POST', `${b}/outlets`, { name: name.trim(), kind, ...(desc.trim() ? { description: desc.trim() } : {}) })); if (r) onDone(r.id); };
  return (
    <Sheet title={t('mn.addOutlet')} onClose={onClose}>
      <label>{t('mn.name')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>{t('mn.kindLabel')}<select value={kind} onChange={(e) => setKind(e.target.value)}>{OUTLET_KINDS.map((k) => <option key={k} value={k}>{t(`mn.kind.${k}` as Key)}</option>)}</select></label>
      <label>{t('mn.about')}<input value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || name.trim().length < 2} onClick={go}>{t('common.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function DayPicker({ value, onChange }: { value: number[]; onChange: (d: number[]) => void }) {
  const { t } = useT();
  return <div className="chips" role="group" aria-label={t('mn.days')}>{DAYS.map((d) => <Chip key={d} active={value.includes(d)} onClick={() => onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d].sort())}>{t(`mn.day.${d}` as Key)}</Chip>)}</div>;
}

function MenuSheet({ b, outletId, onDone, onClose }: { b: string; outletId: string; onDone: () => void; onClose: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction();
  const [name, setName] = useState(''); const [days, setDays] = useState<number[]>([...DAYS]); const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const go = async () => { if (await run(() => api('POST', `${b}/outlets/${outletId}/menus`, { name: name.trim(), days, ...(from && to ? { availableFrom: from, availableTo: to } : {}) }))) onDone(); };
  return (
    <Sheet title={t('mn.addMenu')} onClose={onClose}>
      <label>{t('mn.name')}<input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('mn.menuEx')} /></label>
      <p className="muted small">{t('mn.daysHint')}</p><DayPicker value={days} onChange={setDays} />
      <div className="grid2"><label>{t('mn.from')}<input type="time" value={from} onChange={(e) => setFrom(e.target.value)} dir="ltr" /></label><label>{t('mn.to')}<input type="time" value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" /></label></div>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || name.trim().length < 2 || days.length === 0 || !from !== !to} onClick={go}>{t('common.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function MenuBlock({ b, m, locale, onChange, onEdit }: { b: string; m: MenuT; locale: string; onChange: () => void; onEdit: (id: string | null, categoryId: string) => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction();
  const [cat, setCat] = useState('');
  const addCat = async () => { if (await run(() => api('POST', `${b}/menus/${m.id}/categories`, { name: cat.trim() }))) { setCat(''); onChange(); } };
  const toggle = async () => { if (await run(() => api('PATCH', `${b}/menus/${m.id}`, { status: m.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }))) onChange(); };
  const when = `${m.days.length === 7 ? t('mn.everyDay') : m.days.map((d) => t(`mn.day.${d}` as Key)).join(' ')}${m.availableFrom ? ` · ${m.availableFrom}–${m.availableTo}` : ''}`;
  return (
    <div className="stack">
      <div className="row between"><h3>{m.name} <span className="muted small">· {when}{m.status !== 'ACTIVE' ? ` · ${t('mn.off')}` : ''}</span></h3><button className="link" disabled={busy} onClick={toggle}>{m.status === 'ACTIVE' ? t('mn.turnOff') : t('mn.turnOn')}</button></div>
      {m.categories.map((c) => (
        <div key={c.id} className="stack">
          <div className="row between"><strong>{locale === 'ur' && c.nameUr ? c.nameUr : c.name}</strong><button className="link" onClick={() => onEdit(null, c.id)}>+ {t('mn.addItem')}</button></div>
          {c.items.length === 0 ? <span className="muted small">{t('common.none')}</span> : c.items.map((i) => <ItemCard key={i.id} c={i} locale={locale} action={<div className="row"><button onClick={() => onEdit(i.id, c.id)}>{t('mn.edit')}</button></div>} />)}
        </div>))}
      <div className="row"><input aria-label={t('mn.newCategory')} placeholder={t('mn.newCategory')} value={cat} onChange={(e) => setCat(e.target.value)} /><button disabled={busy || cat.trim().length < 2} onClick={addCat}>{t('mn.addCategory')}</button></div>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </div>
  );
}

const blank = { name: '', nameUr: '', shortDescription: '', description: '', price: '', discountedPrice: '', servingSize: '', serves: '', portionAmount: '', prepMin: '', prepMax: '', availability: 'AVAILABLE', limitedQuantity: '', days: [...DAYS] as number[], allDays: true, from: '', to: '',
  ingredients: '', removable: '', contain: [] as string[], may: [] as string[], dietary: [] as string[], calories: '', protein: '', carbs: '', fat: '', sodium: '', spice: '', cuisine: '', temperature: '', pairings: '', minQty: '1', maxQty: '20', special: true, active: true };

function Pick({ legend, opts, value, onChange, label }: { legend: string; opts: readonly string[]; value: string[]; onChange: (v: string[]) => void; label: (o: string) => string }) {
  return <fieldset className="stack"><legend>{legend}</legend><div className="chips">{opts.map((o) => <Chip key={o} active={value.includes(o)} onClick={() => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])}>{label(o)}</Chip>)}</div></fieldset>;
}

/** Every detail of a dish, in the order the kitchen manager thinks of them. Sizes, option groups and pictures are added once the dish exists. */
function ItemEditor({ b, itemId, categoryId, cats, onChange, onClose }: { b: string; itemId: string | null; categoryId: string; cats: Array<{ id: string; label: string }>; onChange: () => void; onClose: () => void }) {
  const { t } = useT(); const { busy, problem, run, clear } = useAction();
  const [id, setId] = useState(itemId); const [cat, setCat] = useState(categoryId); const [f, setF] = useState(blank);
  const d = useLive<Detail>(id ? `${b}/menu-items/${id}` : null, 300_000);
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    const x = d.data; if (!x || loaded.current === `${x.id}:${x.version}`) return; loaded.current = `${x.id}:${x.version}`;
    setCat(x.categoryId ?? categoryId);
    setF({ name: x.name, nameUr: x.nameUr ?? '', shortDescription: x.shortDescription ?? '', description: x.description ?? '', price: x.price.amount, discountedPrice: x.discountedPrice?.amount ?? '', servingSize: x.servingSize ?? '', serves: x.serves?.toString() ?? '', portionAmount: x.portionAmount ?? '',
      prepMin: x.prepMinMinutes?.toString() ?? '', prepMax: x.prepMaxMinutes?.toString() ?? '', availability: x.availability, limitedQuantity: x.limitedQuantity?.toString() ?? '', days: x.days ?? [...DAYS], allDays: !x.days, from: x.availableFrom ?? '', to: x.availableTo ?? '',
      ingredients: x.ingredients.join(', '), removable: x.removableIngredients.join(', '), contain: x.allergensContain, may: x.allergensMay, dietary: x.dietary, calories: x.calories?.toString() ?? '', protein: x.proteinG?.toString() ?? '', carbs: x.carbsG?.toString() ?? '', fat: x.fatG?.toString() ?? '', sodium: x.sodiumMg?.toString() ?? '',
      spice: x.spiceLevel?.toString() ?? '', cuisine: x.cuisine ?? '', temperature: x.temperature ?? '', pairings: x.pairings ?? '', minQty: x.minQuantity.toString(), maxQty: x.maxQuantity.toString(), special: x.specialInstructions, active: x.active });
  }, [d.data, categoryId]);
  const set = <K extends keyof typeof blank>(k: K, v: (typeof blank)[K]) => setF((p) => ({ ...p, [k]: v }));
  const body = () => ({
    categoryId: cat, name: f.name.trim(), nameUr: f.nameUr.trim() || null, shortDescription: f.shortDescription.trim() || null, description: f.description.trim() || null, price: f.price.trim(), discountedPrice: f.discountedPrice.trim() || null,
    servingSize: f.servingSize.trim() || null, serves: num(f.serves), portionAmount: f.portionAmount.trim() || null, prepMinMinutes: num(f.prepMin), prepMaxMinutes: num(f.prepMax),
    availability: f.availability, limitedQuantity: f.availability === 'LIMITED' ? num(f.limitedQuantity) : null, days: f.allDays ? null : f.days, availableFrom: f.from || null, availableTo: f.to || null,
    ingredients: list(f.ingredients), removableIngredients: list(f.removable), allergensContain: f.contain, allergensMay: f.may, dietary: f.dietary,
    calories: num(f.calories), proteinG: num(f.protein), carbsG: num(f.carbs), fatG: num(f.fat), sodiumMg: num(f.sodium), spiceLevel: num(f.spice), cuisine: f.cuisine.trim() || null, temperature: f.temperature || null, pairings: f.pairings.trim() || null,
    minQuantity: Number(f.minQty) || 1, maxQuantity: Number(f.maxQty) || 20, specialInstructions: f.special,
  });
  const save = async () => {
    if (id) { if (await run(() => api('PATCH', `${b}/menu-items/${id}`, { ...body(), active: f.active, version: d.data!.version }))) { onChange(); d.reload(); } }
    else { const r = await run(() => api<{ id: string }>('POST', `${b}/menu-items`, body())); if (r) { setId(r.id); onChange(); } }
  };
  const x = d.data;
  return (
    <Sheet title={id ? t('mn.editItem') : t('mn.addItem')} onClose={onClose}>
      <fieldset className="stack"><legend>{t('mn.sec.identity')}</legend>
        <label>{t('mn.name')}<input value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label>{t('mn.nameUr')}<input value={f.nameUr} onChange={(e) => set('nameUr', e.target.value)} dir="rtl" /></label>
        <label>{t('mn.short')}<input value={f.shortDescription} maxLength={160} onChange={(e) => set('shortDescription', e.target.value)} /></label>
        <label>{t('mn.long')}<textarea value={f.description} rows={3} onChange={(e) => set('description', e.target.value)} /></label>
        <label>{t('mn.category')}<select value={cat} onChange={(e) => setCat(e.target.value)}>{cats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
      </fieldset>
      <fieldset className="stack"><legend>{t('mn.sec.pricing')}</legend>
        <div className="grid2"><label>{t('mn.price')}<input inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value)} dir="ltr" /></label><label>{t('mn.discounted')}<input inputMode="decimal" value={f.discountedPrice} onChange={(e) => set('discountedPrice', e.target.value)} dir="ltr" /></label></div>
        <p className="muted small">{t('mn.taxHint')}</p>
      </fieldset>
      <fieldset className="stack"><legend>{t('mn.sec.portion')}</legend>
        <div className="grid2"><label>{t('mn.servingSize')}<input value={f.servingSize} onChange={(e) => set('servingSize', e.target.value)} /></label><label>{t('mn.servesLabel')}<input inputMode="numeric" value={f.serves} onChange={(e) => set('serves', e.target.value)} dir="ltr" /></label></div>
        <label>{t('mn.weight')}<input value={f.portionAmount} onChange={(e) => set('portionAmount', e.target.value)} placeholder="450 g" /></label>
        <div className="grid2"><label>{t('mn.prepMin')}<input inputMode="numeric" value={f.prepMin} onChange={(e) => set('prepMin', e.target.value)} dir="ltr" /></label><label>{t('mn.prepMax')}<input inputMode="numeric" value={f.prepMax} onChange={(e) => set('prepMax', e.target.value)} dir="ltr" /></label></div>
      </fieldset>
      <fieldset className="stack"><legend>{t('mn.sec.avail')}</legend>
        <label>{t('mn.availability')}<select value={f.availability} onChange={(e) => set('availability', e.target.value)}>{['AVAILABLE', 'LIMITED', 'SOLD_OUT'].map((a) => <option key={a} value={a}>{t(`mn.av.${a}` as Key)}</option>)}</select></label>
        {f.availability === 'LIMITED' && <label>{t('mn.limited')}<input inputMode="numeric" value={f.limitedQuantity} onChange={(e) => set('limitedQuantity', e.target.value)} dir="ltr" /></label>}
        <label className="row"><input type="checkbox" checked={f.allDays} onChange={(e) => set('allDays', e.target.checked)} /> {t('mn.menuDays')}</label>
        {!f.allDays && <DayPicker value={f.days} onChange={(v) => set('days', v)} />}
        <div className="grid2"><label>{t('mn.from')}<input type="time" value={f.from} onChange={(e) => set('from', e.target.value)} dir="ltr" /></label><label>{t('mn.to')}<input type="time" value={f.to} onChange={(e) => set('to', e.target.value)} dir="ltr" /></label></div>
      </fieldset>
      <fieldset className="stack"><legend>{t('mn.sec.ingredients')}</legend>
        <label>{t('mn.ingredients')}<input value={f.ingredients} onChange={(e) => set('ingredients', e.target.value)} placeholder={t('mn.commaHint')} /></label>
        <label>{t('mn.removable')}<input value={f.removable} onChange={(e) => set('removable', e.target.value)} placeholder={t('mn.commaHint')} /></label>
      </fieldset>
      <Pick legend={t('mn.contains')} opts={ALLERGENS} value={f.contain} onChange={(v) => set('contain', v)} label={(o) => t(`mn.al.${o}` as Key)} />
      <Pick legend={t('mn.mayContain')} opts={ALLERGENS} value={f.may} onChange={(v) => set('may', v)} label={(o) => t(`mn.al.${o}` as Key)} />
      <Pick legend={t('mn.dietary')} opts={DIETARY} value={f.dietary} onChange={(v) => set('dietary', v)} label={(o) => t(`mn.di.${o}` as Key)} />
      <fieldset className="stack"><legend>{t('mn.sec.nutrition')}</legend>
        <div className="grid2"><label>{t('mn.calories')}<input inputMode="numeric" value={f.calories} onChange={(e) => set('calories', e.target.value)} dir="ltr" /></label><label>{t('mn.protein')}<input inputMode="decimal" value={f.protein} onChange={(e) => set('protein', e.target.value)} dir="ltr" /></label></div>
        <div className="grid2"><label>{t('mn.carbs')}<input inputMode="decimal" value={f.carbs} onChange={(e) => set('carbs', e.target.value)} dir="ltr" /></label><label>{t('mn.fat')}<input inputMode="decimal" value={f.fat} onChange={(e) => set('fat', e.target.value)} dir="ltr" /></label></div>
        <label>{t('mn.sodium')}<input inputMode="numeric" value={f.sodium} onChange={(e) => set('sodium', e.target.value)} dir="ltr" /></label>
      </fieldset>
      <fieldset className="stack"><legend>{t('mn.sec.food')}</legend>
        <div className="grid2">
          <label>{t('mn.spiceLabel')}<select value={f.spice} onChange={(e) => set('spice', e.target.value)}><option value="">—</option>{[0, 1, 2, 3, 4].map((s) => <option key={s} value={s}>{t(`mn.spice.${s}` as Key)}</option>)}</select></label>
          <label>{t('mn.temperature')}<select value={f.temperature} onChange={(e) => set('temperature', e.target.value)}><option value="">—</option>{['HOT', 'WARM', 'COLD', 'AMBIENT'].map((s) => <option key={s} value={s}>{t(`mn.temp.${s}` as Key)}</option>)}</select></label>
        </div>
        <label>{t('mn.cuisine')}<input value={f.cuisine} onChange={(e) => set('cuisine', e.target.value)} /></label>
        <label>{t('mn.pairings')}<input value={f.pairings} onChange={(e) => set('pairings', e.target.value)} /></label>
      </fieldset>
      <fieldset className="stack"><legend>{t('mn.sec.ordering')}</legend>
        <div className="grid2"><label>{t('mn.minQty')}<input inputMode="numeric" value={f.minQty} onChange={(e) => set('minQty', e.target.value)} dir="ltr" /></label><label>{t('mn.maxQty')}<input inputMode="numeric" value={f.maxQty} onChange={(e) => set('maxQty', e.target.value)} dir="ltr" /></label></div>
        <label className="row"><input type="checkbox" checked={f.special} onChange={(e) => set('special', e.target.checked)} /> {t('mn.special')}</label>
        {id && <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> {t('mn.active')}</label>}
      </fieldset>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || f.name.trim().length < 2 || !f.price.trim() || !cat} onClick={save}>{t('common.save')}</button><button onClick={onClose}>{t('common.close')}</button></div>
      {id && x && (<>
        <Sizes b={b} item={x} onChange={() => { d.reload(); onChange(); }} clear={clear} />
        <Attach b={b} item={x} onChange={() => { d.reload(); onChange(); }} />
        <Gallery b={b} item={x} onChange={() => { d.reload(); onChange(); }} />
      </>)}
      {!id && <p className="muted small">{t('mn.saveFirst')}</p>}
    </Sheet>
  );
}

function Sizes({ b, item, onChange, clear }: { b: string; item: Detail; onChange: () => void; clear: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction();
  const [n, setN] = useState(''); const [p, setP] = useState(''); const [s, setS] = useState('');
  const add = async () => { if (await run(() => api('POST', `${b}/menu-items/${item.id}/variants`, { name: n.trim(), price: p.trim(), ...(s.trim() ? { serves: Number(s) } : {}) }))) { setN(''); setP(''); setS(''); clear(); onChange(); } };
  const off = async (v: Detail['variantList'][number]) => { if (await run(() => api('PATCH', `${b}/menu-items/${item.id}/variants/${v.id}`, { active: !v.active }))) onChange(); };
  return (
    <fieldset className="stack"><legend>{t('mn.sizes')}</legend>
      <p className="muted small">{t('mn.sizesHint')}</p>
      {item.variantList.map((v) => <div key={v.id} className={`row between small${v.active ? '' : ' struck'}`}><span>{v.name} · {money(v.price)}{v.serves ? ` · ${t('mn.serves', { n: v.serves })}` : ''}</span><button className="link" disabled={busy} onClick={() => off(v)}>{v.active ? t('mn.turnOff') : t('mn.turnOn')}</button></div>)}
      <div className="grid2"><label>{t('mn.sizeName')}<input value={n} onChange={(e) => setN(e.target.value)} placeholder={t('mn.sizeEx')} /></label><label>{t('mn.price')}<input inputMode="decimal" value={p} onChange={(e) => setP(e.target.value)} dir="ltr" /></label></div>
      <button disabled={busy || !n.trim() || !p.trim()} onClick={add}>{t('mn.addSize')}</button>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </fieldset>
  );
}

function Attach({ b, item, onChange }: { b: string; item: Detail; onChange: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction();
  const all = useLive<{ items: Group[] }>(`${b}/modifier-groups`, 120_000);
  const on = new Set(item.modifierGroups.map((g) => g.id));
  const flip = async (g: Group) => { const next = on.has(g.id) ? [...on].filter((x) => x !== g.id) : [...on, g.id]; if (await run(() => api('PUT', `${b}/menu-items/${item.id}/modifier-groups`, { groupIds: next }))) onChange(); };
  return (
    <fieldset className="stack"><legend>{t('mn.groupsFor')}</legend>
      {!all.data ? <Spinner /> : all.data.items.filter((g) => g.active).length === 0 ? <span className="muted small">{t('mn.noGroups')}</span> : all.data.items.filter((g) => g.active).map((g) => (
        <label key={g.id} className="row"><input type="checkbox" checked={on.has(g.id)} disabled={busy} onChange={() => flip(g)} /> {g.name} <span className="muted small">({g.options.map((o) => o.name).join(', ')})</span></label>))}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </fieldset>
  );
}

function Gallery({ b, item, onChange }: { b: string; item: Detail; onChange: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction(); const pick = useRef<HTMLInputElement>(null);
  const upload = async (files: FileList | null) => { for (const file of Array.from(files ?? [])) { const fd = new FormData(); fd.append('file', file); if (!(await run(() => api('POST', `${b}/menu-items/${item.id}/media`, fd)))) break; } onChange(); };
  const alt = async (m: Detail['media'][number]) => { const a = window.prompt(t('mn.alt'), m.altText ?? ''); if (a !== null && (await run(() => api('PATCH', `${b}/menu-items/${item.id}/media/${m.id}`, { altText: a.trim() || null })))) onChange(); };
  const first = async (m: Detail['media'][number]) => { if (await run(() => api('PATCH', `${b}/menu-items/${item.id}/media/${m.id}`, { makePrimary: true }))) onChange(); };
  const drop = async (m: Detail['media'][number]) => { if (await run(() => api('DELETE', `${b}/menu-items/${item.id}/media/${m.id}`))) onChange(); };
  return (
    <fieldset className="stack"><legend>{t('mn.sec.media')}</legend>
      <p className="muted small">{t('mn.mediaHint')}</p>
      <div className="stack">{item.media.map((m) => (
        <div key={m.id} className="row between small">
          {m.kind === 'IMAGE' ? <img src={m.url} alt={m.altText ?? ''} style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8 }} /> : <video src={m.url} style={{ width: 96 }} controls preload="metadata" aria-label={t('mn.video')} />}
          <span className="muted">{m.isPrimary ? t('mn.primary') : m.kind === 'VIDEO' ? t('mn.video') : ''}{m.altText ? ` · ${m.altText}` : ''}</span>
          <span className="row">{m.kind === 'IMAGE' && <button className="link" onClick={() => alt(m)}>{t('mn.altBtn')}</button>}{m.kind === 'IMAGE' && !m.isPrimary && <button className="link" onClick={() => first(m)}>{t('mn.makePrimary')}</button>}<button className="link" disabled={busy} onClick={() => drop(m)}>{t('mn.remove')}</button></span>
        </div>))}</div>
      <input ref={pick} type="file" hidden accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" multiple onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
      <button type="button" disabled={busy} onClick={() => pick.current?.click()}>{busy ? t('ps.uploading') : t('mn.addMedia')}</button>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </fieldset>
  );
}

/** Option groups ("Choose a side", "Extras") are set up once for the property and attached to whichever dishes need them. */
function GroupsSheet({ b, onClose }: { b: string; onClose: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction();
  const all = useLive<{ items: Group[] }>(`${b}/modifier-groups`, 60_000);
  const [n, setN] = useState(''); const [min, setMin] = useState('0'); const [max, setMax] = useState('1');
  const [opt, setOpt] = useState<Record<string, { n: string; p: string }>>({});
  const addGroup = async () => { if (await run(() => api('POST', `${b}/modifier-groups`, { name: n.trim(), minSelect: Number(min), maxSelect: Number(max) }))) { setN(''); all.reload(); } };
  const addOption = async (g: Group) => { const o = opt[g.id]; if (o && await run(() => api('POST', `${b}/modifier-groups/${g.id}/options`, { name: o.n.trim(), priceDelta: o.p.trim() || '0' }))) { setOpt({ ...opt, [g.id]: { n: '', p: '' } }); all.reload(); } };
  return (
    <Sheet title={t('mn.groups')} onClose={onClose}>
      <p className="muted small">{t('mn.groupsHint')}</p>
      {!all.data ? <Spinner /> : all.data.items.map((g) => (
        <div key={g.id} className="card stack small">
          <strong>{g.name} <span className="muted">· {t('mn.pickRange', { a: g.minSelect, b: g.maxSelect })}</span></strong>
          <ul className="plain">{g.options.map((o) => <li key={o.id}>{o.name} · {money(o.priceDelta)}</li>)}</ul>
          <div className="grid2"><input aria-label={`${g.name} ${t('mn.optionName')}`} placeholder={t('mn.optionName')} value={opt[g.id]?.n ?? ''} onChange={(e) => setOpt({ ...opt, [g.id]: { n: e.target.value, p: opt[g.id]?.p ?? '' } })} /><input aria-label={`${g.name} ${t('mn.extraPrice')}`} placeholder={t('mn.extraPrice')} inputMode="decimal" dir="ltr" value={opt[g.id]?.p ?? ''} onChange={(e) => setOpt({ ...opt, [g.id]: { n: opt[g.id]?.n ?? '', p: e.target.value } })} /></div>
          <button disabled={busy || !(opt[g.id]?.n ?? '').trim()} onClick={() => addOption(g)}>{t('mn.addOption')}</button>
        </div>))}
      <div className="card inner stack">
        <label>{t('mn.groupName')}<input value={n} onChange={(e) => setN(e.target.value)} placeholder={t('mn.groupEx')} /></label>
        <div className="grid2"><label>{t('mn.chooseAtLeast')}<input inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} dir="ltr" /></label><label>{t('mn.chooseAtMost')}<input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} dir="ltr" /></label></div>
        <button className="primary" disabled={busy || n.trim().length < 2} onClick={addGroup}>{t('mn.addGroup')}</button>
      </div>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </Sheet>
  );
}
