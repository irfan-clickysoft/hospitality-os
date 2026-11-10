import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { shortDate } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Field } from '../ui/ds.js';
import { Empty, ErrorLine, Spinner } from '../ui/kit.js';

interface Item { text: string; done: boolean; doneBy: string | null }
interface Row { id: string; businessDate: string; shift: string; author: string; mine: boolean; notes: string; items: Item[]; openItems: number; acknowledgedBy: string | null; acknowledgedAt: string | null; createdAt: string }
const SHIFTS = ['MORNING', 'EVENING', 'NIGHT'] as const;
const guess = (): (typeof SHIFTS)[number] => { const h = new Date().getHours(); return h >= 6 && h < 14 ? 'MORNING' : h >= 14 && h < 22 ? 'EVENING' : 'NIGHT'; };

/** The note one shift leaves for the next. What is still open stays on screen until someone ticks it off; the next person marks it read. */
export function Handover() {
  const { t, locale } = useT(); const { property, can } = useAuth(); const { busy, problem, run } = useAction();
  const base = `/v1/properties/${property!.id}/handovers`; const list = useLive<{ items: Row[] }>(base, 30_000); const write = can('reservation.create');
  const [shift, setShift] = useState<(typeof SHIFTS)[number]>(guess()); const [notes, setNotes] = useState(''); const [items, setItems] = useState<string[]>(['']);
  const send = async () => { const r = await run(() => api('POST', base, { shift, notes: notes.trim(), items: items.map((x) => x.trim()).filter(Boolean) })); if (r) { setNotes(''); setItems(['']); list.reload(); } };
  const read = async (id: string) => { if (await run(() => api('POST', `${base}/${id}/acknowledge`, {}))) list.reload(); };
  const tick = async (id: string, i: number, done: boolean) => { if (await run(() => api('PUT', `${base}/${id}/items/${i}`, { done }))) list.reload(); };
  return (
    <div className="stack">
      <h3>{t('ho.title')}</h3><p className="muted small">{t('ho.help')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {write && (
        <fieldset className="guestcard stack"><legend>{t('ho.write')}</legend>
          <Field label={t('ho.shift')}>{(p) => <select {...p} value={shift} onChange={(e) => setShift(e.target.value as (typeof SHIFTS)[number])}>{SHIFTS.map((s) => <option key={s} value={s}>{t(`ho.s.${s}` as Key)}</option>)}</select>}</Field>
          <Field label={t('ho.notes')} required>{(p) => <textarea {...p} rows={4} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
          <div className="stack"><span className="small">{t('ho.items')}</span>
            {items.map((x, i) => <input key={i} aria-label={`${t('ho.item')} ${i + 1}`} maxLength={200} value={x} onChange={(e) => setItems(items.map((y, k) => (k === i ? e.target.value : y)))} />)}
            {items.length < 10 && <button type="button" className="link" onClick={() => setItems([...items, ''])}>+ {t('ho.addItem')}</button>}</div>
          <div className="actions"><button className="primary" disabled={busy || notes.trim().length < 3} onClick={() => void send()}>{t('ho.send')}</button></div>
        </fieldset>)}
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('ho.none')} /> : (
        <ul className="plain">{list.data.items.map((r) => (
          <li key={r.id} className="card inner stack small">
            <div className="row between"><strong>{t(`ho.s.${r.shift}` as Key)} · {shortDate(r.businessDate, locale)}</strong><span className="muted">{t('ho.by', { name: r.author })}</span></div>
            <p style={{ whiteSpace: 'pre-wrap' }}>{r.notes}</p>
            {r.items.length > 0 && <ul className="plain">{r.items.map((it, i) => <li key={i}><label className="check"><input type="checkbox" checked={it.done} disabled={busy || !write} onChange={(e) => void tick(r.id, i, e.target.checked)} /> <span style={it.done ? { textDecoration: 'line-through' } : undefined}>{it.text}</span>{it.done && it.doneBy ? <span className="muted"> · {it.doneBy}</span> : null}</label></li>)}</ul>}
            <div className="row between">{r.acknowledgedBy ? <span className="ok">✓ {t('ho.readBy', { name: r.acknowledgedBy })}</span> : <span className="warn">{t('ho.unread')}</span>}
              {write && !r.mine && !r.acknowledgedBy && <button disabled={busy} onClick={() => void read(r.id)}>{t('ho.markRead')}</button>}</div>
          </li>))}</ul>)}
    </div>
  );
}
