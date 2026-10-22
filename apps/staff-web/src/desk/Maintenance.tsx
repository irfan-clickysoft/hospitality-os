import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { addDays, money, whatsappNumber } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';
import { BillsOverview, Bills, Gallery, SchedulesSheet, type BillsBlock, type MediaItem } from './MaintenanceExtras.js';

interface Sla { responseHours: number | null; fixHours: number | null; respondedAfter: number | null; fixedAfter: number | null; responseBreached: boolean; fixBreached: boolean }
interface Order {
  id: string; number: string; title: string; description: string | null; category: string; kind: 'CORRECTIVE' | 'PREVENTIVE'; priority: number; status: string; roomId: string | null; room: string | null; area: string | null;
  assignedTo: string | null; assignee: string | null; vendorId: string | null; contractor: string | null; reporter: string | null; dueDate: string | null; overdue: boolean; cost: Amount; estimatedCost: Amount | null;
  vendor: string | null; doneNote: string | null; doneBy: string | null; blockId: string | null; approvedBy: string | null; rejectedReason: string | null; sla: Sla | null;
}
interface Detail extends Order { media: MediaItem[]; bills: BillsBlock | null; scheduleId: string | null; events: Array<{ action: string; from: string | null; to: string | null; note: string | null; amount: Amount | null; at: string; by: string | null }> }
export interface Vendor { id: string; name: string; trade: string; contactName: string | null; phone: string | null; email: string | null; contractRef: string | null; contractStart: string | null; contractEnd: string | null; slaResponseHours: number | null; slaFixHours: number | null; notes: string | null; status: string; contractExpired: boolean }
interface Group { key: string | null; label: string | null; requested: number; open: number; active: number; done: number; overdue: number; estimated: Amount; actual: Amount }
const CATS = ['PLUMBING', 'ELECTRICAL', 'AC', 'FURNITURE', 'APPLIANCE', 'CLEANLINESS', 'SAFETY', 'FUMIGATION', 'OTHER'];
const tone = (s: string) => (s === 'VERIFIED' ? 'clean' : s === 'DONE' ? 'inspected' : s === 'IN_PROGRESS' ? 'cleaning' : s === 'WAITING' || s === 'REQUESTED' ? 'warn' : s === 'CANCELLED' || s === 'REJECTED' ? 'neutral' : 'dirty') as 'clean' | 'inspected' | 'cleaning' | 'warn' | 'neutral' | 'dirty';
type Filter = 'REQUESTED' | 'ACTIVE' | 'MINE' | 'DONE';
type By = 'none' | 'kind' | 'vendor' | 'technician' | 'category';

/** Repairs and maintenance: ask for work, have it approved, give it to an in-house technician or a contractor, see it through, and have someone else check it. */
export function Maintenance() {
  const { t } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/work-orders`;
  const approver = can('maintenance.approve'); const manager = can('maintenance.manage');
  const [filter, setFilter] = useState<Filter>(manager || approver ? 'ACTIVE' : 'MINE');
  const [by, setBy] = useState<By>('none'); const [pick, setPick] = useState<{ by: By; key: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null); const [creating, setCreating] = useState(false); const [vendors, setVendors] = useState(false); const [billsOpen, setBillsOpen] = useState(false); const [sched, setSched] = useState(false);
  const seeBills = manager || approver || can('maintenance.pay');
  const params = new URLSearchParams(); params.set('status', filter === 'REQUESTED' ? 'REQUESTED' : filter === 'DONE' ? 'DONE' : 'ACTIVE'); if (filter === 'MINE') params.set('mine', 'true');
  if (pick) params.set(pick.by === 'kind' ? 'kind' : pick.by === 'vendor' ? 'vendorId' : pick.by === 'technician' ? 'assignedTo' : 'category', pick.key);
  const list = useLive<{ items: Order[]; counts: Record<string, number> }>(`${base}?${params}`, 30_000);
  const groups = useLive<{ items: Group[] }>(by === 'none' ? null : `${base}/summary?by=${by}`, 30_000);
  const waiting = list.data?.counts.REQUESTED ?? 0;
  return (
    <section className="stack">
      <h2>{t('nav.maintenance')}</h2>
      <div className="chips">{(['ACTIVE', 'MINE', 'DONE'] as const).map((f) => <Chip key={f} active={filter === f} onClick={() => { setFilter(f); setPick(null); }}>{t(`mt.f.${f}` as Key)}</Chip>)}
        {(approver || manager || waiting > 0) && <Chip active={filter === 'REQUESTED'} onClick={() => { setFilter('REQUESTED'); setPick(null); }}>{t('mw.f.REQUESTED')}{waiting ? ` (${waiting})` : ''}</Chip>}</div>
      <div className="row">
        <label className="row">{t('mw.groupBy')} <select value={by} onChange={(e) => { setBy(e.target.value as By); setPick(null); }}>{(['none', 'kind', 'vendor', 'technician', 'category'] as const).map((b) => <option key={b} value={b}>{t(`mw.by.${b}` as Key)}</option>)}</select></label>
        {pick && <button className="link" onClick={() => setPick(null)}>{t('mw.clearFilter')}</button>}
      </div>
      <div className="actions">
        {(can('maintenance.request') || manager) && <button className="primary" onClick={() => setCreating(true)}>{can('maintenance.approve') ? t('mt.new') : t('mw.request')}</button>}
        {(can('maintenance.vendor') || can('maintenance.view')) && <button onClick={() => setVendors(true)}>{t('mw.contractors')}</button>}
        {seeBills && <button onClick={() => setBillsOpen(true)}>{t('mx.bills')}</button>}
        {(manager || approver || can('maintenance.view')) && <button onClick={() => setSched(true)}>{t('mx.recurring')}</button>}
      </div>
      {by !== 'none' && groups.data && (
        <table className="nighttable small"><thead><tr><th scope="col">{t(`mw.by.${by}` as Key)}</th><th scope="col">{t('mw.g.waiting')}</th><th scope="col">{t('mw.g.active')}</th><th scope="col">{t('mw.g.done')}</th><th scope="col">{t('ar.overdue')}</th><th scope="col">{t('mw.estimated')}</th><th scope="col">{t('mt.cost')}</th></tr></thead>
          <tbody>{groups.data.items.map((g) => (
            <tr key={g.key ?? '—'}><th scope="row">{g.key ? <button className="link" onClick={() => { setPick({ by, key: g.key! }); setFilter('ACTIVE'); }}>{by === 'kind' ? t(`mw.k.${g.key}` as Key) : by === 'category' ? t(`mt.c.${g.key}` as Key) : g.label}</button> : '—'}</th>
              <td>{g.requested}</td><td>{g.open + g.active}</td><td>{g.done}</td><td>{g.overdue || '—'}</td><td dir="ltr">{money(g.estimated)}</td><td dir="ltr">{money(g.actual)}</td></tr>))}</tbody></table>
      )}
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('common.none')} /> : (
        <ul className="plain rows">{list.data.items.map((o) => (
          <li key={o.id}><button className="row-card" onClick={() => setOpen(o.id)}>
            <span className="rc-main"><strong>{o.room ? `${t('d.room')} ${o.room} · ` : ''}{o.title}</strong><span className="muted small">{o.number} · {t(`mw.k.${o.kind}` as Key)} · {t(`mt.c.${o.category}` as Key)} · {o.contractor ?? o.assignee ?? t('mt.unassigned')}{o.dueDate ? ` · ${t('ar.due', { date: o.dueDate })}` : ''}{o.estimatedCost && o.estimatedCost.amount !== '0.00' ? ` · ${t('mw.est')} ${money(o.estimatedCost)}` : ''}</span></span>
            <span className="rc-side">{o.priority === 1 && <Badge tone="urgent">{t('priority.1')}</Badge>}{o.overdue && <Badge tone="dirty">{t('ar.overdue')}</Badge>}{o.sla && (o.sla.responseBreached || o.sla.fixBreached) && <Badge tone="dirty">{t('mw.slaBreached')}</Badge>}<Badge tone={tone(o.status)}>{t(`mt.s.${o.status}` as Key)}</Badge></span>
          </button></li>))}</ul>)}
      {creating && <CreateSheet base={base} onDone={() => { setCreating(false); list.reload(); }} onClose={() => setCreating(false)} />}
      {open && <OrderSheet base={base} id={open} onChanged={list.reload} onClose={() => setOpen(null)} />}
      {vendors && <VendorsSheet onClose={() => setVendors(false)} />}
      {billsOpen && <BillsOverview propertyId={property!.id} onOpenOrder={(id) => { setBillsOpen(false); setOpen(id); }} onClose={() => setBillsOpen(false)} />}
      {sched && <SchedulesSheet propertyId={property!.id} onClose={() => { setSched(false); list.reload(); }} />}
    </section>
  );
}

export function useAssignees(base: string, enabled: boolean) {
  const techs = useLive<{ items: Array<{ id: string; name: string }> }>(enabled ? `${base}/technicians` : null, 300_000);
  const vendors = useLive<{ items: Vendor[] }>(enabled ? '/v1/maintenance/vendors' : null, 300_000);
  return { techs: techs.data?.items ?? [], vendors: vendors.data?.items ?? [] };
}
/** One choice for who does the job: "technician:<id>" or "contractor:<id>". */
export function AssigneeSelect({ value, onChange, techs, vendors }: { value: string; onChange: (v: string) => void; techs: Array<{ id: string; name: string }>; vendors: Vendor[] }) {
  const { t } = useT();
  return (
    <label>{t('mw.whoDoes')}<select value={value} onChange={(e) => onChange(e.target.value)}><option value="">—</option>
      {techs.length > 0 && <optgroup label={t('mw.inhouse')}>{techs.map((x) => <option key={x.id} value={`technician:${x.id}`}>{x.name}</option>)}</optgroup>}
      {vendors.length > 0 && <optgroup label={t('mw.contractorsGroup')}>{vendors.map((v) => <option key={v.id} value={`contractor:${v.id}`}>{v.name} ({t(`mt.c.${v.trade}` as Key) === `mt.c.${v.trade}` ? v.trade : t(`mt.c.${v.trade}` as Key)}){v.contractExpired ? ` — ${t('mw.contractExpired')}` : ''}</option>)}</optgroup>}
    </select></label>
  );
}
export const assignBody = (v: string) => (v.startsWith('technician:') ? { assignedTo: v.slice(11) } : v.startsWith('contractor:') ? { vendorId: v.slice(11) } : {});

function CreateSheet({ base, onDone, onClose }: { base: string; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property, can } = useAuth();
  const approver = can('maintenance.approve') || can('maintenance.manage');
  const rooms = useLive<{ items: Array<{ id: string; number: string }> }>(`/v1/properties/${property!.id}/rooms`, 600_000);
  const { techs, vendors } = useAssignees(base, approver);
  const today = property?.businessDate;
  const [f, setF] = useState({ title: '', description: '', kind: 'CORRECTIVE', category: 'PLUMBING', priority: '3', roomId: '', area: '', dueDate: '', estimate: '', who: '', ooo: false, from: today ?? '', to: '' });
  const { busy, problem, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const go = async () => {
    const body = { title: f.title.trim(), kind: f.kind, category: f.category, priority: Number(f.priority), ...(f.description.trim() ? { description: f.description.trim() } : {}), ...(f.roomId ? { roomId: f.roomId } : {}), ...(f.area.trim() ? { area: f.area.trim() } : {}),
      ...(f.dueDate ? { dueDate: f.dueDate } : {}), ...(f.estimate.trim() ? { estimatedCost: f.estimate.trim() } : {}), ...(approver ? assignBody(f.who) : {}), ...(approver && f.ooo && f.roomId ? { outOfOrder: { startDate: f.from, endDate: f.to } } : {}) };
    if (await run(() => api('POST', base, body))) onDone();
  };
  return (
    <Sheet title={approver ? t('mt.new') : t('mw.request')} onClose={onClose}>
      {!approver && <p className="muted small">{t('mw.requestNote')}</p>}
      <label>{t('mw.k.label')}<select value={f.kind} onChange={set('kind')}><option value="CORRECTIVE">{t('mw.k.CORRECTIVE')}</option><option value="PREVENTIVE">{t('mw.k.PREVENTIVE')}</option></select></label>
      <label>{t('mt.title')}<input value={f.title} onChange={set('title')} placeholder={t('mw.titleEx')} /></label>
      <label>{t('mw.details')}<textarea rows={3} value={f.description} onChange={set('description')} placeholder={t('mw.detailsEx')} /></label>
      <div className="grid2"><label>{t('mt.category')}<select value={f.category} onChange={set('category')}>{CATS.map((c) => <option key={c} value={c}>{t(`mt.c.${c}` as Key)}</option>)}</select></label>
        <label>{t('mt.priority')}<select value={f.priority} onChange={set('priority')}>{[1, 2, 3, 4].map((p) => <option key={p} value={p}>{t(`mt.p.${p}` as Key)}</option>)}</select></label></div>
      <div className="grid2"><label>{t('d.room')}<select value={f.roomId} onChange={set('roomId')}><option value="">—</option>{rooms.data?.items.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}</select></label>
        <label>{t('mt.area')}<input value={f.area} onChange={set('area')} /></label></div>
      <div className="grid2"><label>{t('mt.dueDate')}<input type="date" value={f.dueDate} min={today} onChange={set('dueDate')} dir="ltr" /></label>
        <label>{t('mw.estimate')}<input inputMode="decimal" value={f.estimate} onChange={set('estimate')} dir="ltr" placeholder="0" /></label></div>
      {approver && <AssigneeSelect value={f.who} onChange={(v) => setF({ ...f, who: v })} techs={techs} vendors={vendors} />}
      {approver && f.roomId && <label className="row"><input type="checkbox" checked={f.ooo} onChange={(e) => setF({ ...f, ooo: e.target.checked, to: e.target.checked && !f.to ? addDays(f.from || property!.businessDate, 2) : f.to })} /> {t('mt.takeOut')}</label>}
      {approver && f.roomId && f.ooo && <div className="grid2"><label>{t('mt.from')}<input type="date" value={f.from} onChange={set('from')} dir="ltr" /></label><label>{t('mt.backOn')}<input type="date" value={f.to} onChange={set('to')} dir="ltr" /></label></div>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || f.title.trim().length < 3 || (f.ooo && (!f.from || !f.to))} onClick={go}>{approver ? t('common.save') : t('mw.send')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function OrderSheet({ base, id, onChanged, onClose }: { base: string; id: string; onChanged: () => void; onClose: () => void }) {
  const { t } = useT();
  const { me, can } = useAuth();
  const d = useLive<Detail>(`${base}/${id}`, 20_000);
  const mgr = can('maintenance.manage'); const approver = can('maintenance.approve');
  const { techs, vendors } = useAssignees(base, mgr || approver);
  const [f, setF] = useState({ text: '', cost: '', vendor: '', who: '', estimate: '' });
  const [msg, setMsg] = useState(false);
  const { busy, problem, run } = useAction();
  const o = d.data;
  const mine = !!o && o.assignedTo === me?.user.id;
  const worker = can('maintenance.work') && (mine || mgr);
  const act = async (tail: string, body: unknown = {}) => { if (await run(() => api('POST', `${base}/${id}/${tail}`, body))) { d.reload(); onChanged(); setF({ text: '', cost: '', vendor: '', who: '', estimate: '' }); } };
  const need = f.text.trim().length >= 3;
  const estimate = f.estimate.trim() ? { estimatedCost: f.estimate.trim() } : {};
  return (
    <Sheet title={o ? `${o.number} · ${o.title}` : '…'} onClose={onClose}>
      {!o ? <Spinner /> : (<>
        <div className="card inner stack small">
          <div className="row between"><span>{o.room ? `${t('d.room')} ${o.room}` : o.area ?? ''}</span><Badge tone={tone(o.status)}>{t(`mt.s.${o.status}` as Key)}</Badge></div>
          <span className="muted">{t(`mw.k.${o.kind}` as Key)} · {t(`mt.c.${o.category}` as Key)} · {t(`mt.p.${o.priority}` as Key)}{o.dueDate ? ` · ${t('ar.due', { date: o.dueDate })}` : ''}</span>
          {o.description && <span>{o.description}</span>}
          <span className="muted">{o.contractor ? `${t('mw.contractor')}: ${o.contractor}` : o.assignee ? `${t('mt.assignTo')}: ${o.assignee}` : t('mt.unassigned')}{o.reporter ? ` · ${t('mw.askedBy')} ${o.reporter}` : ''}{o.approvedBy ? ` · ${t('mw.approvedBy')} ${o.approvedBy}` : ''}</span>
          {o.estimatedCost && <span>{t('mw.estimate')}: {money(o.estimatedCost)}</span>}
          {o.cost.amount !== '0.00' && <span>{t('mt.cost')}: {money(o.cost)}{o.vendor ? ` · ${o.vendor}` : ''}</span>}
          {o.rejectedReason && <span className="warnbox">{t('mw.rejected')}: {o.rejectedReason}</span>}
          {o.blockId && <span className="warnbox">{t('mt.outOfOrder')}</span>}
          {o.sla && <span className={o.sla.responseBreached || o.sla.fixBreached ? 'warnbox' : 'muted'}>{t('mw.sla')}: {o.sla.responseHours ? `${t('mw.respond')} ${o.sla.respondedAfter ?? '…'}/${o.sla.responseHours} h` : ''}{o.sla.fixHours ? ` · ${t('mw.fix')} ${o.sla.fixedAfter ?? '…'}/${o.sla.fixHours} h` : ''}</span>}
        </div>

        <Gallery base={base} id={id} media={o.media} closed={['VERIFIED', 'CANCELLED', 'REJECTED'].includes(o.status)} canAdd={mgr || approver || mine || (o.reporter != null && me?.user.fullName === o.reporter)} meId={me?.user.id ?? ''} onChange={() => { d.reload(); onChanged(); }} />
        {o.status === 'REQUESTED' && approver && (
          <div className="card inner stack"><strong>{t('mw.decide')}</strong>
            <AssigneeSelect value={f.who} onChange={(v) => setF({ ...f, who: v })} techs={techs} vendors={vendors} />
            <label>{t('mw.estimate')}<input inputMode="decimal" value={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.value })} dir="ltr" /></label>
            <button className="primary" disabled={busy} onClick={() => act('approve', { ...assignBody(f.who), ...estimate })}>{t('mw.approve')}</button>
            <label>{t('common.reason')}<input value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></label>
            <button disabled={busy || !need} onClick={() => act('reject', { reason: f.text.trim() })}>{t('mw.reject')}</button></div>)}
        {o.status === 'REQUESTED' && !approver && <p className="muted small">{t('mw.waiting')}</p>}

        {mgr && ['OPEN', 'ASSIGNED', 'WAITING'].includes(o.status) && (
          <div className="card inner stack"><AssigneeSelect value={f.who} onChange={(v) => setF({ ...f, who: v })} techs={techs} vendors={vendors} />
            <button disabled={busy || !f.who} onClick={() => act('assign', assignBody(f.who))}>{t('mt.assign')}</button></div>)}
        {(o.assignedTo || o.vendorId) && !['REQUESTED', 'REJECTED', 'CANCELLED', 'VERIFIED'].includes(o.status) && <button onClick={() => setMsg(!msg)} aria-expanded={msg}>{t('mw.messageThem')}</button>}
        {msg && <WorkOrderMessage base={base} id={id} />}
        {worker && ['ASSIGNED', 'WAITING', ...(mgr ? ['OPEN'] : [])].includes(o.status) && <button className="primary" disabled={busy} onClick={() => act('start')}>{t('mt.start')}</button>}
        {worker && ['IN_PROGRESS', 'ASSIGNED'].includes(o.status) && (
          <div className="card inner stack"><label>{t('mt.noteLabel')}<input value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></label>
            <div className="grid2"><label>{t('mt.cost')}<input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} dir="ltr" /></label>{!o.vendorId && <label>{t('mt.vendor')}<input value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} /></label>}</div>
            <div className="row"><button className="primary" disabled={busy || !need} onClick={() => act('done', { note: f.text.trim(), ...(f.cost.trim() ? { cost: f.cost.trim() } : {}), ...(f.vendor.trim() ? { vendor: f.vendor.trim() } : {}) })}>{t('mt.finish')}</button>
              {o.status === 'IN_PROGRESS' && <button disabled={busy || !need} onClick={() => act('wait', { reason: f.text.trim() })}>{t('mt.wait')}</button>}</div></div>)}
        {mgr && o.status === 'DONE' && (
          <div className="card inner stack"><label>{t('mt.noteLabel')}<input value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></label>
            <div className="row"><button className="primary" disabled={busy} onClick={() => act('verify', f.text.trim() ? { note: f.text.trim() } : {})}>{t('mt.verify')}</button><button disabled={busy || !need} onClick={() => act('reopen', { reason: f.text.trim() })}>{t('mt.reopen')}</button></div></div>)}
        {(mgr || (o.status === 'REQUESTED' && o.reporter && me?.user.fullName === o.reporter)) && !['VERIFIED', 'CANCELLED', 'REJECTED'].includes(o.status) && (
          <div className="row"><input value={f.text} placeholder={t('common.reason')} onChange={(e) => setF({ ...f, text: e.target.value })} /><button disabled={busy || !need} onClick={() => act('cancel', { reason: f.text.trim() })}>{t('mt.cancel')}</button></div>)}
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        {o.bills && <Bills base={base} id={id} bills={o.bills} vendorId={o.vendorId} status={o.status} onChange={() => { d.reload(); onChanged(); }} />}
        <h3>{t('rs.tab.history')}</h3>
        <ul className="plain small">{o.events.map((e, i) => <li key={i} className="row between"><span>{t(`mt.e.${e.action}` as Key) === `mt.e.${e.action}` ? e.action : t(`mt.e.${e.action}` as Key)}{e.note ? ` · ${e.note}` : ''}{e.amount ? ` · ${money(e.amount)}` : ''}</span><span className="muted">{e.by}</span></li>)}</ul>
      </>)}
    </Sheet>
  );
}

/** The message that tells the technician or contractor about the job, ready for WhatsApp. */
function WorkOrderMessage({ base, id }: { base: string; id: string }) {
  const { t } = useT();
  const [data, setData] = useState<{ text: string; phone: string | null } | null>(null); const [text, setText] = useState(''); const [phone, setPhone] = useState(''); const [failed, setFailed] = useState(false);
  useEffect(() => {
    let dead = false;
    api<{ text: string; phone: string | null }>('POST', `${base}/${id}/message`).then((r) => { if (!dead) { setData(r); setText(r.text); setPhone(r.phone ?? ''); } }).catch(() => { if (!dead) setFailed(true); });
    return () => { dead = true; };
  }, [base, id]);
  if (failed) return <p className="warnbox small">{t('gm.failed')}</p>;
  if (!data) return <p className="muted small">{t('common.loading')}</p>;
  const wa = whatsappNumber(phone);
  return (
    <div className="stack">
      <label>{t('wa.message')}<textarea dir="ltr" rows={11} value={text} onChange={(e) => setText(e.target.value)} /></label>
      {!data.phone && <label>{t('mw.theirPhone')}<input value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" inputMode="tel" /></label>}
      <div className="actions">{wa ? <a className="primary button" href={`https://wa.me/${wa}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">{t('wa.send')}</a> : <p className="warnbox small">{t('mw.noPhone')}</p>}
        <button onClick={() => void navigator.clipboard?.writeText(text)}>{t('wa.copy')}</button></div>
    </div>
  );
}

function VendorsSheet({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const { can } = useAuth();
  const list = useLive<{ items: Vendor[] }>('/v1/maintenance/vendors?all=true', 60_000);
  const [edit, setEdit] = useState<Vendor | 'new' | null>(null);
  return (
    <Sheet title={t('mw.contractors')} onClose={onClose}>
      <p className="muted small">{t('mw.contractorsHint')}</p>
      {can('maintenance.vendor') && <div className="actions"><button className="primary" onClick={() => setEdit('new')}>{t('mw.addContractor')}</button></div>}
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('common.none')} /> : (
        <ul className="plain rows">{list.data.items.map((v) => (
          <li key={v.id}><button className="row-card" onClick={() => can('maintenance.vendor') && setEdit(v)}>
            <span className="rc-main"><strong>{v.name}</strong><span className="muted small">{[t(`mt.c.${v.trade}` as Key) === `mt.c.${v.trade}` ? v.trade : t(`mt.c.${v.trade}` as Key), v.contactName, v.phone, v.contractRef, v.slaResponseHours ? `${t('mw.respond')} ${v.slaResponseHours} h` : null, v.slaFixHours ? `${t('mw.fix')} ${v.slaFixHours} h` : null].filter(Boolean).join(' · ')}</span></span>
            <span className="rc-side">{v.contractExpired && <Badge tone="dirty">{t('mw.contractExpired')}</Badge>}{v.status === 'INACTIVE' && <Badge tone="neutral">{t('mw.inactive')}</Badge>}</span>
          </button></li>))}</ul>)}
      {edit && <VendorForm vendor={edit === 'new' ? null : edit} onDone={() => { setEdit(null); list.reload(); }} onClose={() => setEdit(null)} />}
    </Sheet>
  );
}

function VendorForm({ vendor, onDone, onClose }: { vendor: Vendor | null; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const [f, setF] = useState({ name: vendor?.name ?? '', trade: vendor?.trade ?? 'GENERAL', contactName: vendor?.contactName ?? '', phone: vendor?.phone ?? '', email: vendor?.email ?? '', contractRef: vendor?.contractRef ?? '', contractStart: vendor?.contractStart ?? '', contractEnd: vendor?.contractEnd ?? '', slaResponseHours: vendor?.slaResponseHours ? String(vendor.slaResponseHours) : '', slaFixHours: vendor?.slaFixHours ? String(vendor.slaFixHours) : '', notes: vendor?.notes ?? '', status: vendor?.status ?? 'ACTIVE' });
  const { busy, problem, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const body = { name: f.name.trim(), trade: f.trade, contactName: f.contactName.trim() || null, phone: f.phone.trim() || null, email: f.email.trim() || null, contractRef: f.contractRef.trim() || null, contractStart: f.contractStart || null, contractEnd: f.contractEnd || null,
      slaResponseHours: f.slaResponseHours ? Number(f.slaResponseHours) : null, slaFixHours: f.slaFixHours ? Number(f.slaFixHours) : null, notes: f.notes.trim() || null, ...(vendor ? { status: f.status } : {}) };
    if (await run(() => (vendor ? api('PATCH', `/v1/maintenance/vendors/${vendor.id}`, body) : api('POST', '/v1/maintenance/vendors', body)))) onDone();
  };
  return (
    <Sheet title={vendor ? vendor.name : t('mw.addContractor')} onClose={onClose}>
      <label>{t('mw.vName')}<input value={f.name} onChange={set('name')} /></label>
      <div className="grid2"><label>{t('mw.trade')}<select value={f.trade} onChange={set('trade')}>{['GENERAL', ...CATS].map((c) => <option key={c} value={c}>{t(`mt.c.${c}` as Key) === `mt.c.${c}` ? c : t(`mt.c.${c}` as Key)}</option>)}</select></label>
        <label>{t('mw.contact')}<input value={f.contactName} onChange={set('contactName')} /></label></div>
      <div className="grid2"><label>{t('bk.phone')}<input value={f.phone} onChange={set('phone')} dir="ltr" inputMode="tel" /></label><label>{t('login.email')}<input value={f.email} onChange={set('email')} dir="ltr" type="email" /></label></div>
      <label>{t('mw.contractRef')}<input value={f.contractRef} onChange={set('contractRef')} /></label>
      <div className="grid2"><label>{t('mw.contractStart')}<input type="date" value={f.contractStart} onChange={set('contractStart')} dir="ltr" /></label><label>{t('mw.contractEnd')}<input type="date" value={f.contractEnd} onChange={set('contractEnd')} dir="ltr" /></label></div>
      <div className="grid2"><label>{t('mw.slaRespond')}<input type="number" min={1} value={f.slaResponseHours} onChange={set('slaResponseHours')} dir="ltr" /></label><label>{t('mw.slaFix')}<input type="number" min={1} value={f.slaFixHours} onChange={set('slaFixHours')} dir="ltr" /></label></div>
      <label>{t('common.note')}<textarea rows={2} value={f.notes} onChange={set('notes')} /></label>
      {vendor && <label className="check"><input type="checkbox" checked={f.status === 'ACTIVE'} onChange={(e) => setF({ ...f, status: e.target.checked ? 'ACTIVE' : 'INACTIVE' })} /> {t('mw.active')}</label>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || f.name.trim().length < 2} onClick={() => void save()}>{t('common.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}
