import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { addDays, money } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';

interface Order {
  id: string; number: string; title: string; description: string | null; category: string; priority: number; status: string; roomId: string | null; room: string | null; area: string | null;
  assignedTo: string | null; assignee: string | null; reporter: string | null; dueDate: string | null; overdue: boolean; cost: Amount; vendor: string | null; doneNote: string | null; doneBy: string | null; blockId: string | null;
}
interface Detail extends Order { events: Array<{ action: string; from: string | null; to: string | null; note: string | null; amount: Amount | null; at: string; by: string | null }> }
const CATS = ['PLUMBING', 'ELECTRICAL', 'AC', 'FURNITURE', 'APPLIANCE', 'CLEANLINESS', 'SAFETY', 'OTHER'];
const tone = (s: string) => (s === 'VERIFIED' ? 'clean' : s === 'DONE' ? 'inspected' : s === 'IN_PROGRESS' ? 'cleaning' : s === 'WAITING' ? 'warn' : s === 'CANCELLED' ? 'neutral' : 'dirty') as 'clean' | 'inspected' | 'cleaning' | 'warn' | 'neutral' | 'dirty';

/** Repairs: report a fault, give it to a technician, see it through, and have someone else check it before the room goes back on sale. */
export function Maintenance() {
  const { t } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/work-orders`;
  const [filter, setFilter] = useState<'ACTIVE' | 'MINE' | 'DONE'>(can('maintenance.manage') ? 'ACTIVE' : 'MINE');
  const [open, setOpen] = useState<string | null>(null); const [creating, setCreating] = useState(false);
  const q = filter === 'MINE' ? '?mine=true' : filter === 'DONE' ? '?status=DONE' : '?status=ACTIVE';
  const list = useLive<{ items: Order[]; counts: Record<string, number> }>(`${base}${q}`, 30_000);
  return (
    <section className="stack">
      <h2>{t('nav.maintenance')}</h2>
      <div className="chips">{(['ACTIVE', 'MINE', 'DONE'] as const).map((f) => <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>{t(`mt.f.${f}` as Key)}</Chip>)}</div>
      {can('maintenance.manage') && <div className="actions"><button className="primary" onClick={() => setCreating(true)}>{t('mt.new')}</button></div>}
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('common.none')} /> : (
        <ul className="plain rows">{list.data.items.map((o) => (
          <li key={o.id}><button className="row-card" onClick={() => setOpen(o.id)}>
            <span className="rc-main"><strong>{o.room ? `${t('d.room')} ${o.room} · ` : ''}{o.title}</strong><span className="muted small">{o.number} · {t(`mt.c.${o.category}` as Key)}{o.assignee ? ` · ${o.assignee}` : ` · ${t('mt.unassigned')}`}{o.dueDate ? ` · ${t('ar.due', { date: o.dueDate })}` : ''}</span></span>
            <span className="rc-side">{o.priority === 1 && <Badge tone="urgent">{t('priority.1')}</Badge>}{o.overdue && <Badge tone="dirty">{t('ar.overdue')}</Badge>}<Badge tone={tone(o.status)}>{t(`mt.s.${o.status}` as Key)}</Badge></span>
          </button></li>))}</ul>)}
      {creating && <CreateSheet base={base} onDone={() => { setCreating(false); list.reload(); }} onClose={() => setCreating(false)} />}
      {open && <OrderSheet base={base} id={open} onChanged={list.reload} onClose={() => setOpen(null)} />}
    </section>
  );
}

function CreateSheet({ base, onDone, onClose }: { base: string; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const rooms = useLive<{ items: Array<{ id: string; number: string }> }>(`/v1/properties/${property!.id}/rooms`, 600_000);
  const techs = useLive<{ items: Array<{ id: string; name: string }> }>(`${base}/technicians`, 300_000);
  const today = property?.businessDate;
  const [f, setF] = useState({ title: '', description: '', category: 'PLUMBING', priority: '3', roomId: '', area: '', dueDate: '', assignedTo: '', ooo: false, from: today ?? '', to: '' });
  const { busy, problem, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const go = async () => {
    const body = { title: f.title.trim(), category: f.category, priority: Number(f.priority), ...(f.description.trim() ? { description: f.description.trim() } : {}), ...(f.roomId ? { roomId: f.roomId } : {}), ...(f.area.trim() ? { area: f.area.trim() } : {}),
      ...(f.dueDate ? { dueDate: f.dueDate } : {}), ...(f.assignedTo ? { assignedTo: f.assignedTo } : {}), ...(f.ooo && f.roomId ? { outOfOrder: { startDate: f.from, endDate: f.to } } : {}) };
    if (await run(() => api('POST', base, body))) onDone();
  };
  return (
    <Sheet title={t('mt.new')} onClose={onClose}>
      <label>{t('mt.title')}<input value={f.title} onChange={set('title')} /></label>
      <label>{t('common.note')}<input value={f.description} onChange={set('description')} /></label>
      <div className="grid2"><label>{t('mt.category')}<select value={f.category} onChange={set('category')}>{CATS.map((c) => <option key={c} value={c}>{t(`mt.c.${c}` as Key)}</option>)}</select></label>
        <label>{t('mt.priority')}<select value={f.priority} onChange={set('priority')}>{[1, 2, 3, 4].map((p) => <option key={p} value={p}>{t(`mt.p.${p}` as Key)}</option>)}</select></label></div>
      <div className="grid2"><label>{t('d.room')}<select value={f.roomId} onChange={set('roomId')}><option value="">—</option>{rooms.data?.items.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}</select></label>
        <label>{t('mt.area')}<input value={f.area} onChange={set('area')} /></label></div>
      <div className="grid2"><label>{t('mt.dueDate')}<input type="date" value={f.dueDate} onChange={set('dueDate')} dir="ltr" /></label>
        <label>{t('mt.assignTo')}<select value={f.assignedTo} onChange={set('assignedTo')}><option value="">—</option>{techs.data?.items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label></div>
      {f.roomId && <label className="row"><input type="checkbox" checked={f.ooo} onChange={(e) => setF({ ...f, ooo: e.target.checked, to: e.target.checked && !f.to ? addDays(f.from || property!.businessDate, 2) : f.to })} /> {t('mt.takeOut')}</label>}
      {f.roomId && f.ooo && <div className="grid2"><label>{t('mt.from')}<input type="date" value={f.from} onChange={set('from')} dir="ltr" /></label><label>{t('mt.backOn')}<input type="date" value={f.to} onChange={set('to')} dir="ltr" /></label></div>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || f.title.trim().length < 3 || (f.ooo && (!f.from || !f.to))} onClick={go}>{t('common.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function OrderSheet({ base, id, onChanged, onClose }: { base: string; id: string; onChanged: () => void; onClose: () => void }) {
  const { t } = useT();
  const { me, can } = useAuth();
  const d = useLive<Detail>(`${base}/${id}`, 20_000);
  const techs = useLive<{ items: Array<{ id: string; name: string }> }>(can('maintenance.manage') ? `${base}/technicians` : null, 300_000);
  const [f, setF] = useState({ text: '', cost: '', vendor: '', tech: '' });
  const { busy, problem, run } = useAction();
  const o = d.data;
  const mine = !!o && o.assignedTo === me?.user.id;
  const mgr = can('maintenance.manage'); const worker = can('maintenance.work') && (mine || mgr);
  const act = async (tail: string, body: unknown = {}) => { if (await run(() => api('POST', `${base}/${id}/${tail}`, body))) { d.reload(); onChanged(); setF({ text: '', cost: '', vendor: '', tech: '' }); } };
  const need = f.text.trim().length >= 3;
  return (
    <Sheet title={o ? `${o.number} · ${o.title}` : '…'} onClose={onClose}>
      {!o ? <Spinner /> : (<>
        <div className="card inner stack small">
          <div className="row between"><span>{o.room ? `${t('d.room')} ${o.room}` : o.area ?? ''}</span><Badge tone={tone(o.status)}>{t(`mt.s.${o.status}` as Key)}</Badge></div>
          <span className="muted">{t(`mt.c.${o.category}` as Key)} · {t(`mt.p.${o.priority}` as Key)}{o.dueDate ? ` · ${t('ar.due', { date: o.dueDate })}` : ''}</span>
          {o.description && <span>{o.description}</span>}
          <span className="muted">{o.assignee ? `${t('mt.assignTo')}: ${o.assignee}` : t('mt.unassigned')}{o.reporter ? ` · ${o.reporter}` : ''}</span>
          {o.blockId && <span className="warnbox">{t('mt.outOfOrder')}</span>}
          {o.cost.amount !== '0.00' && <span>{t('mt.cost')}: {money(o.cost)}{o.vendor ? ` · ${o.vendor}` : ''}</span>}
        </div>
        {mgr && ['OPEN', 'ASSIGNED', 'WAITING'].includes(o.status) && (
          <div className="card inner stack"><label>{t('mt.assignTo')}<select value={f.tech} onChange={(e) => setF({ ...f, tech: e.target.value })}><option value="">—</option>{techs.data?.items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            <button disabled={busy || !f.tech} onClick={() => act('assign', { assignedTo: f.tech })}>{t('mt.assign')}</button></div>)}
        {worker && ['ASSIGNED', 'WAITING', ...(mgr ? ['OPEN'] : [])].includes(o.status) && <button className="primary" disabled={busy} onClick={() => act('start')}>{t('mt.start')}</button>}
        {worker && ['IN_PROGRESS', 'ASSIGNED'].includes(o.status) && (
          <div className="card inner stack"><label>{t('mt.noteLabel')}<input value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></label>
            <div className="grid2"><label>{t('mt.cost')}<input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} dir="ltr" /></label><label>{t('mt.vendor')}<input value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} /></label></div>
            <div className="row"><button className="primary" disabled={busy || !need} onClick={() => act('done', { note: f.text.trim(), ...(f.cost.trim() ? { cost: f.cost.trim() } : {}), ...(f.vendor.trim() ? { vendor: f.vendor.trim() } : {}) })}>{t('mt.finish')}</button>
              {o.status === 'IN_PROGRESS' && <button disabled={busy || !need} onClick={() => act('wait', { reason: f.text.trim() })}>{t('mt.wait')}</button>}</div></div>)}
        {mgr && o.status === 'DONE' && (
          <div className="card inner stack"><label>{t('mt.noteLabel')}<input value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></label>
            <div className="row"><button className="primary" disabled={busy} onClick={() => act('verify', f.text.trim() ? { note: f.text.trim() } : {})}>{t('mt.verify')}</button><button disabled={busy || !need} onClick={() => act('reopen', { reason: f.text.trim() })}>{t('mt.reopen')}</button></div></div>)}
        {mgr && !['VERIFIED', 'CANCELLED'].includes(o.status) && (
          <div className="row"><input value={f.text} placeholder={t('common.reason')} onChange={(e) => setF({ ...f, text: e.target.value })} /><button disabled={busy || !need} onClick={() => act('cancel', { reason: f.text.trim() })}>{t('mt.cancel')}</button></div>)}
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        <h3>{t('rs.tab.history')}</h3>
        <ul className="plain small">{o.events.map((e, i) => <li key={i} className="row between"><span>{t(`mt.e.${e.action}` as Key) === `mt.e.${e.action}` ? e.action : t(`mt.e.${e.action}` as Key)}{e.note ? ` · ${e.note}` : ''}{e.amount ? ` · ${money(e.amount)}` : ''}</span><span className="muted">{e.by}</span></li>)}</ul>
      </>)}
    </Sheet>
  );
}
