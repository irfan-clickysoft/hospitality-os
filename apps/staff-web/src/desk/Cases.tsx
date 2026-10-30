import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import { BookingPick, Photos, Timeline, stamp, type Event } from './CaseBits.js';
import type { Amount } from './types.js';

const TYPES = ['GUEST_COMPLAINT', 'SERVICE_FAILURE', 'SAFETY', 'SECURITY', 'MEDICAL', 'INTERNAL'] as const;
const CHANNELS = ['IN_PERSON', 'PHONE', 'WHATSAPP', 'EMAIL', 'ONLINE_REVIEW', 'STAFF'] as const;
interface Row { id: string; ref: string; type: string; category: string | null; severity: string; restricted: boolean; status: string; occurredAt: string; slaDueAt: string; overdue: boolean; description: string; room: string | null; guest: string | null; owner: string | null; compensation: Amount | null }
interface Detail extends Row {
  reportedAt: string; channel: string; reporterName: string | null; reportedBy: string | null; ownerId: string | null; immediateAction: string | null; rootCause: string | null; correctiveAction: string | null; preventiveAction: string | null; compensationNote: string | null; resolvedAt: string | null; resolvedBy: string | null; resolutionNote: string | null;
  followupAt: string | null; followupNote: string | null; confirmationNo: string | null; version: number; events: Event[]; photos: Array<{ id: string }>;
}
const FILTERS: Record<string, string> = { open: 'OPEN,IN_PROGRESS', resolved: 'RESOLVED,CLOSED', all: '' };
const sevTone = (s: string) => (s === 'CRITICAL' ? 'urgent' : s === 'HIGH' ? 'high' : s === 'MEDIUM' ? 'warn' : 'neutral') as 'urgent' | 'high' | 'warn' | 'neutral';
const stTone = (s: string) => (s === 'OPEN' ? 'warn' : s === 'IN_PROGRESS' ? 'cleaning' : 'clean') as 'warn' | 'cleaning' | 'clean';

/** Complaints, service failures and incidents. Each has an owner, a target time to resolve, and a history that only grows. Safety, security and medical cases are restricted. */
export function Cases() {
  const { t, locale } = useT(); const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/cases`;
  const [filter, setFilter] = useState<keyof typeof FILTERS>('open'); const [q, setQ] = useState(''); const [kind, setKind] = useState<'' | 'guest' | 'incident'>('');
  const view = can('case.view');
  const types = kind === 'guest' ? 'GUEST_COMPLAINT,SERVICE_FAILURE' : kind === 'incident' ? 'SAFETY,SECURITY,MEDICAL,INTERNAL' : '';
  const live = useLive<{ items: Row[]; restrictedAccess: boolean }>(view ? `${base}?${FILTERS[filter] ? `status=${FILTERS[filter]}&` : ''}${types ? `type=${types}&` : ''}${q.trim() ? `q=${encodeURIComponent(q.trim())}` : ''}` : null, 60_000);
  const [creating, setCreating] = useState(false); const [open, setOpen] = useState<string | null>(null); const [notice, setNotice] = useState('');
  return (
    <section className="stack">
      <div className="row between"><h2>{t('cs.title')}</h2>{can('case.report') && <button className="primary small" onClick={() => setCreating(true)}>{t('cs.new')}</button>}</div>
      <p className="muted small">{t('cs.help')}</p>
      {notice && <p className="ok" role="status">✓ {notice}</p>}
      {view && <>
        <div className="chips">{Object.keys(FILTERS).map((f) => <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>{t(`cs.f.${f}` as Key)}</Chip>)}</div>
        <div className="chips">{([['', 'cs.k.all'], ['guest', 'cs.k.guest'], ['incident', 'cs.k.incident']] as const).map(([k, l]) => <Chip key={k} active={kind === k} onClick={() => setKind(k)}>{t(l)}</Chip>)}</div>
        <label>{t('dm.search')}<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('cs.searchEx')} /></label>
        {live.data && !live.data.restrictedAccess && <p className="muted small">{t('cs.noRestricted')}</p>}
        {!live.data ? <Spinner /> : live.data.items.length === 0 ? <Empty text={t('cs.empty')} /> : (
          <ul className="plain rows">{live.data.items.map((i) => (
            <li key={i.id}><button className="row-card" onClick={() => setOpen(i.id)}>
              <span className="rc-main"><strong>{t(`cs.t.${i.type}` as Key)}{i.category ? ` · ${i.category}` : ''}</strong><span className="muted small">{[i.ref, i.room && `${t('common.room')} ${i.room}`, i.guest, stamp(i.occurredAt, locale), i.owner].filter(Boolean).join(' · ')}</span><span className="small">{i.description.length > 110 ? `${i.description.slice(0, 110)}…` : i.description}</span></span>
              <span className="rc-side">{i.restricted && <Badge tone="neutral">{t('cs.restricted')}</Badge>}{i.overdue && <Badge tone="dirty">{t('cs.overdue')}</Badge>}<Badge tone={sevTone(i.severity)}>{t(`cs.sev.${i.severity}` as Key)}</Badge><Badge tone={stTone(i.status)}>{t(`cs.s.${i.status}` as Key)}</Badge></span>
            </button></li>))}</ul>)}
      </>}
      {creating && <CreateSheet base={base} onDone={(r) => { setCreating(false); live.reload(); if (r.restricted && !live.data?.restrictedAccess) setNotice(t('cs.loggedRestricted', { ref: r.ref })); else if (view) setOpen(r.id); }} onClose={() => setCreating(false)} />}
      {open && <DetailSheet base={base} id={open} onChanged={live.reload} onClose={() => setOpen(null)} />}
    </section>
  );
}

function CreateSheet({ base, onDone, onClose }: { base: string; onDone: (r: { id: string; ref: string; restricted: boolean }) => void; onClose: () => void }) {
  const { t } = useT(); const { property } = useAuth(); const { busy, problem, run } = useAction();
  const rooms = useLive<{ items: Array<{ id: string; number: string }> }>(`/v1/properties/${property!.id}/rooms`, 600_000);
  const [type, setType] = useState<(typeof TYPES)[number]>('GUEST_COMPLAINT'); const [sev, setSev] = useState('MEDIUM'); const [cat, setCat] = useState(''); const [channel, setChannel] = useState<(typeof CHANNELS)[number]>('IN_PERSON'); const [who, setWho] = useState('');
  const [conf, setConf] = useState(false); const [booking, setBooking] = useState<{ id: string; label: string } | null>(null); const [roomId, setRoomId] = useState(''); const [desc, setDesc] = useState(''); const [action, setAction] = useState('');
  const forced = ['SAFETY', 'SECURITY', 'MEDICAL'].includes(type);
  return (
    <Sheet title={t('cs.new')} onClose={onClose}>
      <div className="grid2">
        <label>{t('cs.type')}<select value={type} onChange={(e) => setType(e.target.value as typeof type)}>{TYPES.map((x) => <option key={x} value={x}>{t(`cs.t.${x}` as Key)}</option>)}</select></label>
        <label>{t('cs.severity')}<select value={sev} onChange={(e) => setSev(e.target.value)}>{['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((x) => <option key={x} value={x}>{t(`cs.sev.${x}` as Key)} · {t(`cs.sla.${x}` as Key)}</option>)}</select></label>
      </div>
      <label className="check"><input type="checkbox" checked={forced || conf} disabled={forced} onChange={(e) => setConf(e.target.checked)} /> {t('cs.confidential')}</label>
      {forced && <p className="muted small">{t('cs.forcedRestricted')}</p>}
      <div className="grid2">
        <label>{t('cs.category')} ({t('common.optional')})<input value={cat} maxLength={60} onChange={(e) => setCat(e.target.value)} placeholder={t('cs.categoryEx')} /></label>
        <label>{t('cs.channel')}<select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>{CHANNELS.map((x) => <option key={x} value={x}>{t(`cs.ch.${x}` as Key)}</option>)}</select></label>
      </div>
      <label>{t('cs.reporter')} ({t('common.optional')})<input value={who} maxLength={160} onChange={(e) => setWho(e.target.value)} /></label>
      <BookingPick value={booking} onChange={setBooking} />
      <label>{t('common.room')} ({t('common.optional')})<select value={roomId} onChange={(e) => setRoomId(e.target.value)}><option value="">{booking ? t('dm.roomAuto') : '—'}</option>{rooms.data?.items.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}</select></label>
      <label>{t('cs.what')}<textarea rows={4} maxLength={3000} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <label>{t('cs.immediate')} ({t('common.optional')})<textarea rows={2} maxLength={1000} value={action} onChange={(e) => setAction(e.target.value)} /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || desc.trim().length < 3} onClick={async () => { const r = await run(() => api<{ id: string; ref: string; restricted: boolean }>('POST', base, { type, severity: sev, channel, confidential: conf, ...(cat.trim() ? { category: cat.trim() } : {}), ...(who.trim() ? { reporterName: who.trim() } : {}), ...(booking ? { reservationId: booking.id } : {}), ...(roomId ? { roomId } : {}), description: desc.trim(), ...(action.trim() ? { immediateAction: action.trim() } : {}) })); if (r) onDone(r); }}>{t('cs.log')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function DetailSheet({ base, id, onChanged, onClose }: { base: string; id: string; onChanged: () => void; onClose: () => void }) {
  const { t, locale } = useT(); const { can } = useAuth(); const { busy, problem, run } = useAction();
  const live = useLive<Detail>(`${base}/${id}`, 0); const people = useLive<{ items: Array<{ id: string; name: string }> }>(can('case.manage') ? `${base}/people` : null, 600_000);
  const [form, setForm] = useState<null | 'resolve' | 'reopen' | 'note'>(null); const [text, setText] = useState('');
  const [edit, setEdit] = useState<Record<string, string> | null>(null); const ev = (k: string) => edit?.[k] ?? '';
  const d = live.data;
  if (!d) return <Sheet title={t('cs.title')} onClose={onClose}>{live.error ? <ErrorLine code={live.error.code} detail={live.error.message} /> : <Spinner />}</Sheet>;
  const manage = can('case.manage'); const active = d.status === 'OPEN' || d.status === 'IN_PROGRESS';
  const post = async (path: string, body?: unknown) => { const r = await run(() => api('POST', `${base}/${id}/${path}`, body ?? {})); if (r) { setForm(null); setText(''); live.reload(); onChanged(); } };
  const startEdit = () => setEdit({ owner: d.ownerId ?? '', rootCause: d.rootCause ?? '', corrective: d.correctiveAction ?? '', preventive: d.preventiveAction ?? '', compNote: d.compensationNote ?? '', comp: d.compensation?.amount ?? '', follow: d.followupAt ? d.followupAt.slice(0, 10) : '', followNote: d.followupNote ?? '', severity: d.severity });
  const save = async () => { if (!edit) return; const r = await run(() => api('PATCH', `${base}/${id}`, { severity: edit.severity, ownerId: edit.owner || null, rootCause: ev('rootCause').trim() || null, correctiveAction: ev('corrective').trim() || null, preventiveAction: ev('preventive').trim() || null, compensationNote: ev('compNote').trim() || null, compensation: ev('comp').trim() || null, followupAt: edit.follow ? new Date(`${edit.follow}T09:00:00`).toISOString() : null, followupNote: ev('followNote').trim() || null })); if (r) { setEdit(null); live.reload(); onChanged(); } };
  const kv = (k: string, v: string | null | undefined) => v ? <div><dt className="muted small">{k}</dt><dd>{v}</dd></div> : null;
  const set = (k: string, v: string) => setEdit((e) => (e ? { ...e, [k]: v } : e));
  return (
    <Sheet title={`${d.ref} · ${t(`cs.t.${d.type}` as Key)}`} onClose={onClose} wide>
      <div className="row"><Badge tone={stTone(d.status)}>{t(`cs.s.${d.status}` as Key)}</Badge><Badge tone={sevTone(d.severity)}>{t(`cs.sev.${d.severity}` as Key)}</Badge>{d.restricted && <Badge tone="neutral">{t('cs.restricted')}</Badge>}{d.overdue && <Badge tone="dirty">{t('cs.overdue')}</Badge>}</div>
      <p>{d.description}</p>
      <dl className="summary">
        {kv(t('cs.category'), d.category)}{kv(t('cs.channel'), t(`cs.ch.${d.channel}` as Key))}{kv(t('cs.reporter'), d.reporterName)}{kv(t('dm.reportedBy'), d.reportedBy)}{kv(t('cs.happened'), stamp(d.occurredAt, locale))}{kv(t('cs.sla'), stamp(d.slaDueAt, locale))}
        {kv(t('ws.guest'), d.guest)}{kv(t('common.room'), d.room)}{kv(t('cb.booking'), d.confirmationNo)}{kv(t('cs.owner'), d.owner)}{kv(t('cs.immediate'), d.immediateAction)}{kv(t('cs.rootCause'), d.rootCause)}{kv(t('cs.corrective'), d.correctiveAction)}{kv(t('cs.preventive'), d.preventiveAction)}
        {kv(t('cs.compensation'), [d.compensation && money(d.compensation), d.compensationNote].filter(Boolean).join(' · '))}{kv(t('cs.followup'), d.followupAt && `${stamp(d.followupAt, locale)}${d.followupNote ? ` — ${d.followupNote}` : ''}`)}{kv(t('dm.resolution'), d.resolutionNote && `${d.resolutionNote}${d.resolvedBy ? ` · ${d.resolvedBy}` : ''}`)}
      </dl>
      <h3>{t('cb.evidence')}</h3><Photos base={`${base}/${id}`} ids={d.photos} canAdd={can('case.report') && d.status !== 'CLOSED'} onAdded={live.reload} />
      <div className="actions">
        {manage && d.status !== 'CLOSED' && !edit && <button onClick={startEdit}>{t('cs.work')}</button>}
        {manage && active && <button className="primary" onClick={() => setForm('resolve')}>{t('cs.resolve')}</button>}
        {manage && d.status === 'RESOLVED' && <button className="primary" disabled={busy} onClick={() => void post('close')}>{t('cs.close')}</button>}
        {manage && (d.status === 'RESOLVED' || d.status === 'CLOSED') && <button onClick={() => setForm('reopen')}>{t('cs.reopen')}</button>}
        <button onClick={() => setForm('note')}>{t('dm.note')}</button>
      </div>
      {edit && (
        <div className="card inner stack" role="group" aria-label={t('cs.work')}>
          <div className="grid2">
            <label>{t('cs.owner')}<select value={edit.owner} onChange={(e) => set('owner', e.target.value)}><option value="">—</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>{t('cs.severity')}<select value={edit.severity} onChange={(e) => set('severity', e.target.value)}>{['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((x) => <option key={x} value={x}>{t(`cs.sev.${x}` as Key)}</option>)}</select></label>
          </div>
          <label>{t('cs.rootCause')}<textarea rows={2} value={edit.rootCause} onChange={(e) => set('rootCause', e.target.value)} /></label>
          <label>{t('cs.corrective')}<textarea rows={2} value={edit.corrective} onChange={(e) => set('corrective', e.target.value)} /></label>
          <label>{t('cs.preventive')}<textarea rows={2} value={edit.preventive} onChange={(e) => set('preventive', e.target.value)} /></label>
          <div className="grid2"><label>{t('cs.compensationNote')}<input value={edit.compNote} onChange={(e) => set('compNote', e.target.value)} /></label><label>{t('cs.compensationAmount')}<input value={edit.comp} onChange={(e) => set('comp', e.target.value)} inputMode="decimal" dir="ltr" /></label></div>
          <div className="grid2"><label>{t('cs.followup')}<input type="date" value={edit.follow} onChange={(e) => set('follow', e.target.value)} dir="ltr" /></label><label>{t('cs.followupNote')}<input value={edit.followNote} onChange={(e) => set('followNote', e.target.value)} /></label></div>
          <div className="actions"><button className="primary" disabled={busy} onClick={save}>{t('common.save')}</button><button onClick={() => setEdit(null)}>{t('common.cancel')}</button></div>
        </div>)}
      {form && (
        <div className="card inner stack" role="group">
          <label>{form === 'note' ? t('dm.note') : form === 'reopen' ? t('dm.reason') : t('dm.resolution')}<input value={text} onChange={(e) => setText(e.target.value)} /></label>
          <div className="actions"><button className="primary" disabled={busy || text.trim().length < (form === 'note' ? 2 : 3)} onClick={() => void post(form, form === 'reopen' ? { reason: text.trim() } : { note: text.trim() })}>{form === 'resolve' ? t('cs.resolve') : form === 'reopen' ? t('cs.reopen') : t('common.save')}</button><button onClick={() => setForm(null)}>{t('common.cancel')}</button></div>
        </div>)}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <h3>{t('dm.history')}</h3><Timeline events={d.events} label={(x) => t(`cs.e.${x}` as Key)} />
    </Sheet>
  );
}
