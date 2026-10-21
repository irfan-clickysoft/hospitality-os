import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';

interface OrderLine { id: string; name: string; quantity: number; total: Amount; note: string | null }
interface Order { id: string; number: string; payDigitally: boolean; status: string; room: string; guest: string; note: string | null; total: Amount; createdAt: string; cancelReason: string | null; lines: OrderLine[] }
interface Item { id: string; category: string; name: string; nameUr: string | null; price: Amount; active: boolean; version: number }
interface Stay { reservationRoomId: string; room: string; guest: string }
const tone = (s: string) => (s === 'READY' ? 'clean' : s === 'PREPARING' ? 'cleaning' : s === 'DELIVERED' ? 'inspected' : s === 'CANCELLED' ? 'neutral' : 'warn') as 'clean' | 'cleaning' | 'inspected' | 'neutral' | 'warn';
const age = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));

/** Room service: the kitchen queue, taking an order for a guest in the house, and the menu. The bill is charged when the food is handed over. */
export function Kitchen() {
  const { t, locale } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/fnb`;
  const [view, setView] = useState<'queue' | 'done' | 'menu'>('queue'); const [taking, setTaking] = useState(false);
  const queue = useLive<{ items: Order[] }>(view === 'queue' ? `${base}/orders` : view === 'done' ? `${base}/orders?status=ALL&limit=40` : null, 10_000);
  const { busy, problem, run } = useAction();
  const go = async (id: string, tail: string, body: unknown = {}) => { if (await run(() => api('POST', `${base}/orders/${id}/${tail}`, body))) queue.reload(); };
  const manage = can('fnb.manage');
  return (
    <section className="stack">
      <h2>{t('nav.kitchen')}</h2>
      <div className="chips">{(['queue', 'done', ...(manage ? ['menu'] : [])] as const).map((v) => <Chip key={v} active={view === v} onClick={() => setView(v as typeof view)}>{t(`kt.v.${v}` as Key)}</Chip>)}</div>
      <div className="actions"><button className="primary" onClick={() => setTaking(true)}>{t('kt.newOrder')}</button></div>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {view === 'menu' ? <MenuAdmin base={base} /> : !queue.data ? <Spinner /> : queue.data.items.length === 0 ? <Empty text={view === 'queue' ? t('kt.nothing') : t('common.none')} /> : (
        <ul className="plain">{queue.data.items.map((o) => (
          <li key={o.id} className="card stack small">
            <div className="row between"><strong>{t('d.room')} {o.room} · {o.guest}</strong><Badge tone={tone(o.status)}>{t(`kt.s.${o.status}` as Key)}</Badge></div>
            <span className="muted">{o.number} · {t('kt.minutes', { n: age(o.createdAt) })} · {money(o.total)}{o.payDigitally ? ` · ${t('kt.digital')}` : ''}</span>
            <ul className="plain">{o.lines.map((l) => <li key={l.id}><strong>{l.quantity} ×</strong> {l.name}{l.note ? <span className="muted"> — {l.note}</span> : null}</li>)}</ul>
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

function TakeOrder({ base, locale, onDone, onClose }: { base: string; locale: string; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const stays = useLive<{ items: Stay[] }>(`${base}/in-house`, 120_000);
  const menu = useLive<{ items: Item[] }>(`${base}/menu`, 120_000);
  const [stay, setStay] = useState(''); const [qty, setQty] = useState<Record<string, number>>({}); const [note, setNote] = useState(''); const [digital, setDigital] = useState(false);
  const { busy, problem, run } = useAction();
  const items = menu.data?.items ?? [];
  const chosen = items.filter((i) => (qty[i.id] ?? 0) > 0);
  const total = chosen.reduce((a, i) => a + Number(i.price.amount) * qty[i.id]!, 0);
  const bump = (id: string, d: number) => setQty((q) => ({ ...q, [id]: Math.max(0, Math.min(99, (q[id] ?? 0) + d)) }));
  const go = async () => { if (await run(() => api('POST', `${base}/orders`, { reservationRoomId: stay, payDigitally: digital, ...(note.trim() ? { note: note.trim() } : {}), lines: chosen.map((i) => ({ menuItemId: i.id, quantity: qty[i.id] })) }))) onDone(); };
  const cats = [...new Set(items.map((i) => i.category))];
  return (
    <Sheet title={t('kt.newOrder')} onClose={onClose}>
      {!stays.data || !menu.data ? <Spinner /> : (<>
        <label>{t('d.room')}<select value={stay} onChange={(e) => setStay(e.target.value)}><option value="">—</option>{stays.data.items.map((s) => <option key={s.reservationRoomId} value={s.reservationRoomId}>{s.room} · {s.guest}</option>)}</select></label>
        {items.length === 0 && <p className="muted">{t('kt.noMenu')}</p>}
        {cats.map((c) => (<div key={c} className="stack"><h3>{c}</h3>
          {items.filter((i) => i.category === c).map((i) => (
            <div key={i.id} className="row between"><span>{locale === 'ur' && i.nameUr ? i.nameUr : i.name}<span className="muted small"> · {money(i.price)}</span></span>
              <span className="row"><button aria-label="−" onClick={() => bump(i.id, -1)}>−</button><strong style={{ minWidth: 24, textAlign: 'center' }}>{qty[i.id] ?? 0}</strong><button aria-label="+" onClick={() => bump(i.id, 1)}>+</button></span></div>))}</div>))}
        <label>{t('common.note')}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <label className="row"><input type="checkbox" checked={digital} onChange={(e) => setDigital(e.target.checked)} /> {t('kt.payDigital')}</label>
        <div className="row between"><strong>{t('tax.total')}</strong><strong>{money({ amount: total.toFixed(2), currency: 'PKR' })}</strong></div>
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        <div className="actions"><button className="primary" disabled={busy || !stay || chosen.length === 0} onClick={go}>{t('kt.send')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
      </>)}
    </Sheet>
  );
}

function MenuAdmin({ base }: { base: string }) {
  const { t } = useT();
  const list = useLive<{ items: Item[] }>(`${base}/menu?all=true`, 60_000);
  const [f, setF] = useState({ category: '', name: '', nameUr: '', price: '' });
  const { busy, problem, run } = useAction();
  const add = async () => { if (await run(() => api('POST', `${base}/menu`, { category: f.category.trim(), name: f.name.trim(), price: f.price.trim(), ...(f.nameUr.trim() ? { nameUr: f.nameUr.trim() } : {}) }))) { setF({ ...f, name: '', nameUr: '', price: '' }); list.reload(); } };
  const toggle = async (i: Item) => { if (await run(() => api('PATCH', `${base}/menu/${i.id}`, { active: !i.active, version: i.version }))) list.reload(); };
  const reprice = async (i: Item) => { const p = window.prompt(t('kt.newPrice'), i.price.amount); if (p && /^\d{1,9}(\.\d{1,2})?$/.test(p.trim()) && (await run(() => api('PATCH', `${base}/menu/${i.id}`, { price: p.trim(), version: i.version })))) list.reload(); };
  return (
    <div className="stack">
      <div className="card inner stack">
        <div className="grid2"><label>{t('kt.category')}<input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /></label><label>{t('kt.price')}<input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} dir="ltr" /></label></div>
        <div className="grid2"><label>{t('kt.name')}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label><label>{t('kt.nameUr')}<input value={f.nameUr} onChange={(e) => setF({ ...f, nameUr: e.target.value })} dir="rtl" /></label></div>
        <button className="primary" disabled={busy || f.category.trim().length < 2 || f.name.trim().length < 2 || !f.price.trim()} onClick={add}>{t('kt.addItem')}</button>
        <ErrorLine code={problem?.code} detail={problem?.detail} />
      </div>
      {!list.data ? <Spinner /> : <ul className="plain">{list.data.items.map((i) => (
        <li key={i.id} className={`row between small${i.active ? '' : ' struck'}`}><span>{i.category} · {i.name}{i.nameUr ? ` · ${i.nameUr}` : ''}</span><span className="row"><button className="link" onClick={() => reprice(i)}>{money(i.price)}</button><button className="link" disabled={busy} onClick={() => toggle(i)}>{i.active ? t('kt.off') : t('kt.on')}</button></span></li>))}</ul>}
    </div>
  );
}
