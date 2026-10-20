import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';
import { ItemCard, type Card, type Tree } from './Menus.js';

interface OrderLine { id: string; name: string; variant: string | null; modifiers: Array<{ name: string }>; removed: string[]; quantity: number; total: Amount; note: string | null }
interface Order { id: string; number: string; payDigitally: boolean; status: string; room: string; guest: string; note: string | null; total: Amount; createdAt: string; cancelReason: string | null; lines: OrderLine[] }
interface Stay { reservationRoomId: string; room: string; guest: string }
const tone = (s: string) => (s === 'READY' ? 'clean' : s === 'PREPARING' ? 'cleaning' : s === 'DELIVERED' ? 'inspected' : s === 'CANCELLED' ? 'neutral' : 'warn') as 'clean' | 'cleaning' | 'inspected' | 'neutral' | 'warn';
const age = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));

/** Room service: the kitchen queue, taking an order for a guest in the house, and the menu. The bill is charged when the food is handed over. */
export function Kitchen() {
  const { t, locale } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/fnb`;
  const [view, setView] = useState<'queue' | 'done'>('queue'); const [taking, setTaking] = useState(false);
  const queue = useLive<{ items: Order[] }>(view === 'queue' ? `${base}/orders` : `${base}/orders?status=ALL&limit=40`, 10_000);
  const { busy, problem, run } = useAction();
  const go = async (id: string, tail: string, body: unknown = {}) => { if (await run(() => api('POST', `${base}/orders/${id}/${tail}`, body))) queue.reload(); };
  const manage = can('fnb.manage');
  return (
    <section className="stack">
      <h2>{t('nav.kitchen')}</h2>
      <div className="chips">{(['queue', 'done'] as const).map((v) => <Chip key={v} active={view === v} onClick={() => setView(v)}>{t(`kt.v.${v}` as Key)}</Chip>)}</div>
      <div className="actions"><button className="primary" onClick={() => setTaking(true)}>{t('kt.newOrder')}</button></div>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {!queue.data ? <Spinner /> : queue.data.items.length === 0 ? <Empty text={view === 'queue' ? t('kt.nothing') : t('common.none')} /> : (
        <ul className="plain">{queue.data.items.map((o) => (
          <li key={o.id} className="card stack small">
            <div className="row between"><strong>{t('d.room')} {o.room} · {o.guest}</strong><Badge tone={tone(o.status)}>{t(`kt.s.${o.status}` as Key)}</Badge></div>
            <span className="muted">{o.number} · {t('kt.minutes', { n: age(o.createdAt) })} · {money(o.total)}{o.payDigitally ? ` · ${t('kt.digital')}` : ''}</span>
            <ul className="plain">{o.lines.map((l) => <li key={l.id}><strong>{l.quantity} ×</strong> {l.name}{l.variant ? ` (${l.variant})` : ''}{l.modifiers.length ? ` + ${l.modifiers.map((m) => m.name).join(', ')}` : ''}{l.removed.length ? ` — ${t('kt.no')} ${l.removed.join(', ')}` : ''}{l.note ? <span className="muted"> — {l.note}</span> : null}</li>)}</ul>
            {o.note && <span className="warnbox">{o.note}</span>}{o.cancelReason && <span className="muted">{o.cancelReason}</span>}
            {['NEW', 'PREPARING', 'READY'].includes(o.status) && (
              <div className="row">
                {manage && o.status === 'NEW' && <button disabled={busy} onClick={() => go(o.id, 'prepare')}>{t('kt.prepare')}</button>}
                {manage && o.status !== 'READY' && <button className={o.status === 'PREPARING' ? 'primary' : ''} disabled={busy} onClick={() => go(o.id, 'ready')}>{t('kt.ready')}</button>}
                {(o.status === 'READY' || manage) && <button className={o.status === 'READY' ? 'primary' : ''} disabled={busy} onClick={() => go(o.id, 'deliver')}>{t('kt.deliver')}</button>}
                <button className="link" disabled={busy} onClick={() => { const r = window.prompt(t('kt.cancelWhy')); if (r && r.trim().length >= 3) void go(o.id, 'cancel', { reason: r.trim() }); }}>{t('kt.cancel')}</button>
              </div>)}
          </li>))}</ul>)}
      {taking && <TakeOrder base={base} locale={locale} onDone={() => { setTaking(false); queue.reload(); }} onClose={() => setTaking(false)} />}
    </section>
  );
}

interface Opt { id: string; name: string; priceDelta: Amount; active: boolean }
interface Grp { id: string; name: string; minSelect: number; maxSelect: number; options: Opt[] }
interface Full extends Card { variantList: Array<{ id: string; name: string; price: Amount; active: boolean }>; modifierGroups: Grp[]; removableIngredients: string[]; minQuantity: number; maxQuantity: number; specialInstructions: boolean }
interface Line { key: number; item: Card; variantId: string | null; variantName: string | null; unit: number; optionIds: string[]; optionNames: string[]; removed: string[]; note: string; qty: number }
let lineKey = 0;

function TakeOrder({ base, locale, onDone, onClose }: { base: string; locale: string; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const root = base.replace(/\/fnb$/, '');
  const stays = useLive<{ items: Stay[] }>(`${base}/in-house`, 120_000);
  const outlets = useLive<{ items: Array<{ id: string; name: string; status: string }> }>(`${root}/outlets`, 120_000);
  const [outlet, setOutlet] = useState('');
  const cur = outlet || outlets.data?.items.find((o) => o.status === 'ACTIVE')?.id || '';
  const tree = useLive<Tree>(cur ? `${root}/outlets/${cur}/menu` : null, 60_000);
  const [stay, setStay] = useState(''); const [lines, setLines] = useState<Line[]>([]); const [note, setNote] = useState(''); const [digital, setDigital] = useState(false);
  const [choosing, setChoosing] = useState<Card | null>(null);
  const { busy, problem, run } = useAction();
  const total = lines.reduce((a, l) => a + l.unit * l.qty, 0);
  const go = async () => { if (await run(() => api('POST', `${base}/orders`, { reservationRoomId: stay, payDigitally: digital, ...(note.trim() ? { note: note.trim() } : {}), lines: lines.map((l) => ({ menuItemId: l.item.id, quantity: l.qty, ...(l.variantId ? { variantId: l.variantId } : {}), modifierOptionIds: l.optionIds, removed: l.removed, ...(l.note.trim() ? { note: l.note.trim() } : {}) })) }))) onDone(); };
  const cards = (tree.data?.menus ?? []).filter((m) => m.status === 'ACTIVE');
  return (
    <Sheet title={t('kt.newOrder')} onClose={onClose}>
      {!stays.data || !outlets.data ? <Spinner /> : (<>
        <label>{t('d.room')}<select value={stay} onChange={(e) => setStay(e.target.value)}><option value="">—</option>{stays.data.items.map((s) => <option key={s.reservationRoomId} value={s.reservationRoomId}>{s.room} · {s.guest}</option>)}</select></label>
        {outlets.data.items.length > 1 && <label>{t('mn.outlet')}<select value={cur} onChange={(e) => setOutlet(e.target.value)}>{outlets.data.items.filter((o) => o.status === 'ACTIVE').map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>}
        {tree.data && cards.every((m) => m.categories.every((c) => c.items.length === 0)) && <p className="muted">{t('kt.noMenu')}</p>}
        {cards.map((m) => m.categories.filter((c) => c.items.length).map((c) => (<div key={c.id} className="stack"><h3>{locale === 'ur' && c.nameUr ? c.nameUr : c.name}</h3>
          {c.items.map((i) => <ItemCard key={i.id} c={i} locale={locale} action={<div className="row"><button disabled={!i.orderable} onClick={() => setChoosing(i)}>{t('mn.addToOrder')}</button></div>} />)}</div>)))}
        {lines.length > 0 && <div className="stack"><h3>{t('kt.yourOrder')}</h3>{lines.map((l) => (
          <div key={l.key} className="row between small"><span>{l.qty} × {l.item.name}{l.variantName ? ` (${l.variantName})` : ''}{l.optionNames.length ? ` + ${l.optionNames.join(', ')}` : ''}{l.removed.length ? ` — ${t('kt.no')} ${l.removed.join(', ')}` : ''}{l.note ? ` — ${l.note}` : ''}</span>
            <button className="link" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>{t('mn.remove')}</button></div>))}</div>}
        <label>{t('common.note')}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <label className="row"><input type="checkbox" checked={digital} onChange={(e) => setDigital(e.target.checked)} /> {t('kt.payDigital')}</label>
        <div className="row between"><strong>{t('tax.total')}</strong><strong>{money({ amount: total.toFixed(2), currency: 'PKR' })}</strong></div>
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        <div className="actions"><button className="primary" disabled={busy || !stay || lines.length === 0} onClick={go}>{t('kt.send')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
      </>)}
      {choosing && <Choose base={root} card={choosing} onAdd={(l) => { setLines((x) => [...x, { ...l, key: ++lineKey }]); setChoosing(null); }} onClose={() => setChoosing(null)} />}
    </Sheet>
  );
}

/** What the guest wants on this dish: the size, the extras, anything to leave out, and the quantity. */
function Choose({ base, card, onAdd, onClose }: { base: string; card: Card; onAdd: (l: Omit<Line, 'key'>) => void; onClose: () => void }) {
  const { t } = useT();
  const d = useLive<Full>(`${base}/menu-items/${card.id}`, 300_000);
  const [size, setSize] = useState(''); const [picked, setPicked] = useState<string[]>([]); const [removed, setRemoved] = useState<string[]>([]); const [qty, setQty] = useState(1); const [note, setNote] = useState('');
  const x = d.data;
  if (!x) return <Sheet title={card.name} onClose={onClose}><Spinner /></Sheet>;
  const sizes = x.variantList.filter((v) => v.active);
  const chosen = sizes.find((v) => v.id === size);
  const opts = x.modifierGroups.flatMap((g) => g.options.filter((o) => o.active));
  const unit = Number(chosen ? chosen.price.amount : (x.discountedPrice ?? x.price).amount) + picked.reduce((a, id) => a + Number(opts.find((o) => o.id === id)?.priceDelta.amount ?? 0), 0);
  const okGroups = x.modifierGroups.every((g) => { const n = picked.filter((id) => g.options.some((o) => o.id === id)).length; return n >= g.minSelect && n <= g.maxSelect; });
  const flip = (g: Grp, id: string) => setPicked((p) => (p.includes(id) ? p.filter((y) => y !== id) : g.maxSelect === 1 ? [...p.filter((y) => !g.options.some((o) => o.id === y)), id] : [...p, id]));
  return (
    <Sheet title={x.name} onClose={onClose}>
      {sizes.length > 0 && <fieldset className="stack"><legend>{t('mn.size')}</legend>{sizes.map((v) => <label key={v.id} className="row"><input type="radio" name="size" checked={size === v.id} onChange={() => setSize(v.id)} /> {v.name} · {money(v.price)}</label>)}</fieldset>}
      {x.modifierGroups.map((g) => (
        <fieldset key={g.id} className="stack"><legend>{g.name}{g.minSelect > 0 ? ` · ${t('mn.required')}` : ''}</legend>
          {g.options.filter((o) => o.active).map((o) => <label key={o.id} className="row"><input type={g.maxSelect === 1 ? 'radio' : 'checkbox'} name={g.id} checked={picked.includes(o.id)} onChange={() => flip(g, o.id)} /> {o.name}{Number(o.priceDelta.amount) ? ` · +${money(o.priceDelta)}` : ''}</label>)}</fieldset>))}
      {x.removableIngredients.length > 0 && <fieldset className="stack"><legend>{t('mn.leaveOut')}</legend>{x.removableIngredients.map((r) => <label key={r} className="row"><input type="checkbox" checked={removed.includes(r)} onChange={() => setRemoved((p) => (p.includes(r) ? p.filter((y) => y !== r) : [...p, r]))} /> {t('kt.no')} {r}</label>)}</fieldset>}
      {x.specialInstructions && <label>{t('mn.instructions')}<input value={note} maxLength={160} onChange={(e) => setNote(e.target.value)} /></label>}
      <div className="row"><button aria-label="−" onClick={() => setQty(Math.max(x.minQuantity, qty - 1))}>−</button><strong style={{ minWidth: 24, textAlign: 'center' }}>{qty}</strong><button aria-label="+" onClick={() => setQty(Math.min(x.maxQuantity, qty + 1))}>+</button></div>
      <div className="actions"><button className="primary" disabled={(sizes.length > 0 && !chosen) || !okGroups} onClick={() => onAdd({ item: card, variantId: chosen?.id ?? null, variantName: chosen?.name ?? null, unit, optionIds: picked, optionNames: picked.map((id) => opts.find((o) => o.id === id)?.name ?? ''), removed, note, qty })}>{t('mn.addToOrder')} · {money({ amount: (unit * qty).toFixed(2), currency: 'PKR' })}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}
