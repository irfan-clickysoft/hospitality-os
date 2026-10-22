import { useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';
import { AssigneeSelect, assignBody, useAssignees, type Vendor } from './Maintenance.js';

export interface MediaItem { id: string; kind: 'IMAGE' | 'VIDEO'; stage: 'REPORTED' | 'PROGRESS' | 'COMPLETED'; url: string; by: string | null; uploadedBy: string }
interface BillRow { id: string; workOrderId: string; orderNumber: string; orderTitle: string; payee: string | null; billNo: string; billDate: string; dueDate: string | null; amount: Amount; note: string | null; hasFile: boolean; status: 'RECEIVED' | 'APPROVED' | 'REJECTED' | 'PAID'; rejectReason: string | null; paidMethod: string | null; paidRef: string | null }
export interface BillsBlock { items: BillRow[]; billed: Amount; paid: Amount; unpaid: Amount; overEstimate: boolean }
const tone = (s: string) => (s === 'PAID' ? 'clean' : s === 'APPROVED' ? 'inspected' : s === 'REJECTED' ? 'neutral' : 'warn') as 'clean' | 'inspected' | 'neutral' | 'warn';

/** Pictures and videos of the fault, the work under way and the finished job. Anyone who can see the job sees them; the person who asked, the one doing it and managers add them. */
export function Gallery({ base, id, media, closed, canAdd, meId, onChange }: { base: string; id: string; media: MediaItem[]; closed: boolean; canAdd: boolean; meId: string; onChange: () => void }) {
  const { t } = useT(); const { can } = useAuth(); const { busy, problem, run } = useAction(); const pick = useRef<HTMLInputElement>(null);
  const upload = async (files: FileList | null) => { for (const file of Array.from(files ?? [])) { const fd = new FormData(); fd.append('file', file); if (!(await run(() => api('POST', `${base}/${id}/media`, fd)))) break; } onChange(); };
  const drop = async (m: MediaItem) => { if (await run(() => api('DELETE', `${base}/${id}/media/${m.id}`))) onChange(); };
  if (!media.length && (!canAdd || closed)) return null;
  return (
    <div className="stack">
      <h3>{t('mx.photos')}</h3>
      {(['REPORTED', 'PROGRESS', 'COMPLETED'] as const).map((st) => { const items = media.filter((m) => m.stage === st); return items.length === 0 ? null : (
        <div key={st} className="stack"><span className="muted small">{t(`mx.stage.${st}` as Key)}</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>{items.map((m) => (
            <figure key={m.id} style={{ margin: 0 }}>
              {m.kind === 'IMAGE' ? <a href={m.url} target="_blank" rel="noreferrer"><img src={m.url} alt={t('mx.photoAlt', { by: m.by ?? '' })} style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 8 }} /></a> : <video src={m.url} controls preload="metadata" style={{ width: 160 }} aria-label={t('mx.video')} />}
              {(m.uploadedBy === meId || can('maintenance.manage')) && !closed && <figcaption><button className="link small" disabled={busy} onClick={() => drop(m)}>{t('mx.remove')}</button></figcaption>}
            </figure>))}</div></div>); })}
      {canAdd && !closed && <><input ref={pick} type="file" hidden multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
        <button type="button" disabled={busy} onClick={() => pick.current?.click()}>{busy ? t('ps.uploading') : t('mx.addPhoto')}</button></>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </div>
  );
}

/** The bills that come with a job: recorded, approved, paid. Only people who deal with bills see this. */
export function Bills({ base, id, bills, vendorId, status, onChange }: { base: string; id: string; bills: BillsBlock; vendorId: string | null; status: string; onChange: () => void }) {
  const { t } = useT(); const { can } = useAuth(); const { busy, problem, run } = useAction(); const [adding, setAdding] = useState(false);
  const pick = useRef<HTMLInputElement>(null); const [attachFor, setAttachFor] = useState<string | null>(null);
  const [f, setF] = useState({ payee: '', billNo: '', billDate: '', dueDate: '', amount: '', note: '' });
  const record = can('maintenance.manage') || can('maintenance.approve');
  const canRecord = record && !['REQUESTED', 'REJECTED', 'CANCELLED'].includes(status);
  const add = async () => { if (await run(() => api('POST', `${base}/${id}/bills`, { ...(vendorId ? {} : { payee: f.payee.trim() }), billNo: f.billNo.trim(), billDate: f.billDate, ...(f.dueDate ? { dueDate: f.dueDate } : {}), amount: f.amount.trim(), ...(f.note.trim() ? { note: f.note.trim() } : {}) }))) { setAdding(false); setF({ payee: '', billNo: '', billDate: '', dueDate: '', amount: '', note: '' }); onChange(); } };
  const act = async (b: BillRow, tail: string, body: unknown = {}) => { if (await run(() => api('POST', `${base}/${id}/bills/${b.id}/${tail}`, body))) onChange(); };
  const attach = async (files: FileList | null) => { const file = files?.[0]; if (!file || !attachFor) return; const fd = new FormData(); fd.append('file', file); if (await run(() => api('POST', `${base}/${id}/bills/${attachFor}/file`, fd))) onChange(); setAttachFor(null); };
  const reject = (b: BillRow) => { const r = window.prompt(t('mx.rejectWhy')); if (r && r.trim().length >= 3) void act(b, 'reject', { reason: r.trim() }); };
  const pay = (b: BillRow) => { const method = window.prompt(t('mx.payMethod'), 'BANK_TRANSFER')?.trim().toUpperCase().replace(' ', '_'); if (!method) return; const ref = window.prompt(t('mx.payRef')) ?? ''; void act(b, 'pay', { method, ...(ref.trim() ? { ref: ref.trim() } : {}) }); };
  return (
    <div className="stack">
      <h3>{t('mx.billsFor')}</h3>
      <span className="muted small">{t('mx.billed')}: {money(bills.billed)} · {t('mx.paid')}: {money(bills.paid)} · {t('mx.unpaid')}: {money(bills.unpaid)}</span>
      {bills.overEstimate && <p className="warnbox">{t('mx.overEstimate')}</p>}
      {bills.items.map((b) => (
        <div key={b.id} className={`card inner stack small${b.status === 'REJECTED' ? ' struck' : ''}`}>
          <div className="row between"><strong>{b.payee} · #{b.billNo}</strong><Badge tone={tone(b.status)}>{t(`mx.bs.${b.status}` as Key)}</Badge></div>
          <span>{money(b.amount)} · {b.billDate}{b.dueDate ? ` · ${t('ar.due', { date: b.dueDate })}` : ''}</span>
          {b.note && <span className="muted">{b.note}</span>}{b.rejectReason && <span className="warnbox">{b.rejectReason}</span>}
          {b.status === 'PAID' && <span className="muted">{t('mx.paidBy', { m: b.paidMethod ?? '' })}{b.paidRef ? ` · ${b.paidRef}` : ''}</span>}
          <div className="row">
            {b.hasFile && <a className="button" href={`${base}/${id}/bills/${b.id}/file`} target="_blank" rel="noreferrer">{t('mx.viewBill')}</a>}
            {record && b.status === 'RECEIVED' && <button disabled={busy} onClick={() => { setAttachFor(b.id); pick.current?.click(); }}>{b.hasFile ? t('mx.replaceFile') : t('mx.attach')}</button>}
            {can('maintenance.approve') && b.status === 'RECEIVED' && <button className="primary" disabled={busy} onClick={() => act(b, 'approve')}>{t('mx.approve')}</button>}
            {can('maintenance.approve') && ['RECEIVED', 'APPROVED'].includes(b.status) && <button disabled={busy} onClick={() => reject(b)}>{t('mx.reject')}</button>}
            {can('maintenance.pay') && b.status === 'APPROVED' && <button className="primary" disabled={busy} onClick={() => pay(b)}>{t('mx.markPaid')}</button>}
          </div>
        </div>))}
      <input ref={pick} type="file" hidden accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
      {canRecord && !adding && <button onClick={() => setAdding(true)}>{t('mx.addBill')}</button>}
      {adding && (
        <div className="card inner stack">
          {!vendorId && <label>{t('mx.payee')}<input value={f.payee} onChange={(e) => setF({ ...f, payee: e.target.value })} placeholder={t('mx.payeeEx')} /></label>}
          <div className="grid2"><label>{t('mx.billNo')}<input value={f.billNo} onChange={(e) => setF({ ...f, billNo: e.target.value })} dir="ltr" /></label><label>{t('mt.cost')}<input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} dir="ltr" /></label></div>
          <div className="grid2"><label>{t('mx.billDate')}<input type="date" value={f.billDate} onChange={(e) => setF({ ...f, billDate: e.target.value })} dir="ltr" /></label><label>{t('mx.dueDate')}<input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} dir="ltr" /></label></div>
          <label>{t('common.note')}<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <div className="actions"><button className="primary" disabled={busy || !f.billNo.trim() || !f.amount.trim() || !f.billDate || (!vendorId && f.payee.trim().length < 2)} onClick={add}>{t('common.save')}</button><button onClick={() => setAdding(false)}>{t('common.cancel')}</button></div>
        </div>)}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </div>
  );
}

/** What is owed to contractors: waiting for approval, approved and unpaid, paid; by contractor. */
export function BillsOverview({ propertyId, onOpenOrder, onClose }: { propertyId: string; onOpenOrder: (id: string) => void; onClose: () => void }) {
  const { t } = useT(); const [st, setSt] = useState<'OPEN' | 'RECEIVED' | 'APPROVED' | 'PAID' | 'ALL'>('OPEN');
  const d = useLive<{ items: BillRow[]; totals: { awaitingApproval: Amount; approvedUnpaid: Amount; paid: Amount }; owedByPayee: Array<{ payee: string; amount: Amount }> }>(`/v1/properties/${propertyId}/maintenance-bills?status=${st}`, 30_000);
  return (
    <Sheet title={t('mx.bills')} onClose={onClose}>
      {!d.data ? <Spinner /> : (<>
        <div className="card inner stack small"><div className="row between"><span>{t('mx.awaiting')}</span><strong>{money(d.data.totals.awaitingApproval)}</strong></div><div className="row between"><span>{t('mx.toPay')}</span><strong>{money(d.data.totals.approvedUnpaid)}</strong></div><div className="row between"><span>{t('mx.paid')}</span><span>{money(d.data.totals.paid)}</span></div></div>
        {d.data.owedByPayee.length > 0 && <><h3>{t('mx.owedBy')}</h3><ul className="plain small">{d.data.owedByPayee.map((o) => <li key={o.payee} className="row between"><span>{o.payee}</span><strong>{money(o.amount)}</strong></li>)}</ul></>}
        <div className="chips" role="group">{(['OPEN', 'RECEIVED', 'APPROVED', 'PAID', 'ALL'] as const).map((s) => <Chip key={s} active={st === s} onClick={() => setSt(s)}>{t(`mx.bf.${s}` as Key)}</Chip>)}</div>
        {d.data.items.length === 0 ? <Empty text={t('common.none')} /> : <ul className="plain">{d.data.items.map((b) => (
          <li key={b.id} className="card inner stack small"><div className="row between"><strong>{b.payee} · #{b.billNo}</strong><Badge tone={tone(b.status)}>{t(`mx.bs.${b.status}` as Key)}</Badge></div>
            <span>{money(b.amount)}{b.dueDate ? ` · ${t('ar.due', { date: b.dueDate })}` : ''}</span><span className="muted">{b.orderNumber} · {b.orderTitle}</span>
            <div className="row"><button onClick={() => onOpenOrder(b.workOrderId)}>{t('mx.openJob')}</button></div></li>))}</ul>}
      </>)}
    </Sheet>
  );
}

interface Sched { id: string; title: string; category: string; room: string | null; area: string | null; everyN: number; unit: string; nextDue: string; leadDays: number; assignee: string | null; contractor: string | null; estimatedCost: Amount | null; active: boolean }
const CATS = ['PLUMBING', 'ELECTRICAL', 'AC', 'FURNITURE', 'APPLIANCE', 'CLEANLINESS', 'SAFETY', 'FUMIGATION', 'OTHER'];

/** Recurring preventive jobs: "AC filter service every 3 months in these rooms". The jobs are created by themselves a few days ahead. */
export function SchedulesSheet({ propertyId, onClose }: { propertyId: string; onClose: () => void }) {
  const { t } = useT(); const { can } = useAuth();
  const b = `/v1/properties/${propertyId}`;
  const list = useLive<{ items: Sched[] }>(`${b}/maintenance-schedules`, 60_000);
  const rooms = useLive<{ items: Array<{ id: string; number: string }> }>(`${b}/rooms`, 600_000);
  const { techs, vendors } = useAssignees(`${b}/work-orders`, can('maintenance.approve'));
  const { busy, problem, run } = useAction(); const [made, setMade] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ title: '', category: 'AC', everyN: '3', unit: 'MONTH', firstDue: '', leadDays: '7', who: '', estimate: '', roomIds: [] as string[], area: '' });
  const create = async () => { if (await run(() => api('POST', `${b}/maintenance-schedules`, { title: f.title.trim(), category: f.category, everyN: Number(f.everyN), unit: f.unit, firstDue: f.firstDue, leadDays: Number(f.leadDays), roomIds: f.roomIds, ...(f.area.trim() && !f.roomIds.length ? { area: f.area.trim() } : {}), ...assignBody(f.who), ...(f.estimate.trim() ? { estimatedCost: f.estimate.trim() } : {}) }))) { setAdding(false); list.reload(); } };
  const toggle = async (s: Sched) => { if (await run(() => api('PATCH', `${b}/maintenance-schedules/${s.id}`, { active: !s.active }))) list.reload(); };
  const runNow = async () => { const r = await run(() => api<{ created: number }>('POST', `${b}/maintenance-schedules/run`, {})); if (r) { setMade(r.created); list.reload(); } };
  const approver = can('maintenance.approve');
  return (
    <Sheet title={t('mx.recurring')} onClose={onClose}>
      <p className="muted small">{t('mx.recurringHelp')}</p>
      {approver && <div className="actions"><button className="primary" onClick={() => setAdding(!adding)}>{t('mx.newSchedule')}</button><button disabled={busy} onClick={runNow}>{t('mx.createNow')}</button></div>}
      {made !== null && <p className="muted small" role="status">{t('mx.created', { n: made })}</p>}
      {adding && (
        <div className="card inner stack">
          <label>{t('mt.title')}<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={t('mx.titleEx')} /></label>
          <label>{t('mt.category')}<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map((c) => <option key={c} value={c}>{t(`mt.c.${c}` as Key)}</option>)}</select></label>
          <div className="grid2"><label>{t('mx.every')}<input inputMode="numeric" value={f.everyN} onChange={(e) => setF({ ...f, everyN: e.target.value })} dir="ltr" /></label>
            <label>{t('mx.unit')}<select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>{['DAY', 'WEEK', 'MONTH', 'YEAR'].map((u) => <option key={u} value={u}>{t(`mx.u.${u}` as Key)}</option>)}</select></label></div>
          <div className="grid2"><label>{t('mx.firstDue')}<input type="date" value={f.firstDue} onChange={(e) => setF({ ...f, firstDue: e.target.value })} dir="ltr" /></label><label>{t('mx.lead')}<input inputMode="numeric" value={f.leadDays} onChange={(e) => setF({ ...f, leadDays: e.target.value })} dir="ltr" /></label></div>
          <fieldset className="stack"><legend>{t('mx.rooms')}</legend><div className="chips">{(rooms.data?.items ?? []).map((r) => <Chip key={r.id} active={f.roomIds.includes(r.id)} onClick={() => setF({ ...f, roomIds: f.roomIds.includes(r.id) ? f.roomIds.filter((x) => x !== r.id) : [...f.roomIds, r.id] })}>{r.number}</Chip>)}</div>
            {!f.roomIds.length && <label>{t('mt.area')}<input value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })} /></label>}<p className="muted small">{t('mx.roomsHelp')}</p></fieldset>
          <AssigneeSelect value={f.who} onChange={(v) => setF({ ...f, who: v })} techs={techs} vendors={vendors as Vendor[]} />
          <label>{t('mw.estimate')}<input inputMode="decimal" value={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.value })} dir="ltr" /></label>
          <div className="actions"><button className="primary" disabled={busy || f.title.trim().length < 3 || !f.firstDue || !Number(f.everyN)} onClick={create}>{t('common.save')}</button><button onClick={() => setAdding(false)}>{t('common.cancel')}</button></div>
        </div>)}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('mx.noSchedules')} /> : (
        <ul className="plain">{list.data.items.map((s) => (
          <li key={s.id} className={`card inner stack small${s.active ? '' : ' struck'}`}>
            <strong>{s.title}{s.room ? ` · ${t('d.room')} ${s.room}` : s.area ? ` · ${s.area}` : ''}</strong>
            <span className="muted">{t('mx.everyN', { n: s.everyN, u: t(`mx.u.${s.unit}` as Key) })} · {t('mx.nextDue', { date: s.nextDue })} · {s.contractor ?? s.assignee ?? t('mt.unassigned')}</span>
            {approver && <div className="row"><button className="link" disabled={busy} onClick={() => toggle(s)}>{s.active ? t('mx.turnOff') : t('mx.turnOn')}</button></div>}
          </li>))}</ul>)}
    </Sheet>
  );
}
