import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import { BookingPick, Photos, Timeline, stamp, type Event } from './CaseBits.js';
import type { Amount } from './types.js';

const CATS = ['FURNITURE', 'FIXTURE', 'ELECTRONICS', 'LINEN', 'WALLS_FLOORS', 'APPLIANCE', 'KEYS', 'OTHER'] as const;
interface Row { id: string; ref: string; status: string; area: string; category: string; severity: string; discoveredAt: string; room: string | null; guest: string | null; confirmationNo: string | null; photos: number; estimated: Amount | null; charge: Amount | null; waived: Amount }
interface Detail extends Omit<Row, 'photos'> {
  description: string; internalNote: string | null; actual: Amount | null; guestNotifiedAt: string | null; guestNotifiedBy: string | null; guestResponse: string | null; guestResponseNote: string | null; approvedBy: string | null; chargedBy: string | null; chargedAt: string | null; reservationId: string | null;
  folio: { number: string; status: string; balance: Amount } | null; waiveReason: string | null; resolutionNote: string | null; canCharge: boolean; currency: string; taxNote: string; reportedBy: string | null; version: number; events: Event[]; photos: Array<{ id: string }>;
}
const OPEN = ['SUSPECTED', 'VERIFIED', 'CHARGE_APPROVED', 'DISPUTED'];
const FILTERS: Record<string, string> = { open: OPEN.join(','), charged: 'CHARGED', closed: 'WAIVED,DISMISSED,RESOLVED', all: '' };
const tone = (s: string) => (s === 'SUSPECTED' ? 'warn' : s === 'DISPUTED' ? 'urgent' : s === 'CHARGED' || s === 'RESOLVED' ? 'clean' : s === 'DISMISSED' || s === 'WAIVED' ? 'neutral' : 'cleaning') as 'warn' | 'urgent' | 'clean' | 'neutral' | 'cleaning';
const sevTone = (s: string) => (s === 'MAJOR' ? 'urgent' : s === 'MODERATE' ? 'high' : 'neutral') as 'urgent' | 'high' | 'neutral';

/** Damage register: report suspected damage with pictures, verify it, tell the guest, approve and charge it to the bill (or waive or dismiss it). Every step is kept in the case history. */
export function Damage() {
  const { t, locale } = useT(); const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/damage`;
  const [filter, setFilter] = useState<keyof typeof FILTERS>('open'); const [q, setQ] = useState('');
  const view = can('damage.view');
  const live = useLive<{ items: Row[] }>(view ? `${base}?${FILTERS[filter] ? `status=${FILTERS[filter]}&` : ''}${q.trim() ? `q=${encodeURIComponent(q.trim())}` : ''}` : null, 60_000);
  const [creating, setCreating] = useState(false); const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="stack">
      <div className="row between"><h2>{t('dm.title')}</h2>{can('damage.report') && <button className="primary small" onClick={() => setCreating(true)}>{t('dm.new')}</button>}</div>
      <p className="muted small">{t('dm.help')}</p>
      {view && <>
        <div className="chips">{Object.keys(FILTERS).map((f) => <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>{t(`dm.f.${f}` as Key)}</Chip>)}</div>
        <label>{t('dm.search')}<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('dm.searchEx')} /></label>
        {!live.data ? <Spinner /> : live.data.items.length === 0 ? <Empty text={t('dm.empty')} /> : (
          <ul className="plain rows">{live.data.items.map((i) => (
            <li key={i.id}><button className="row-card" onClick={() => setOpen(i.id)}>
              <span className="rc-main"><strong>{i.area}</strong><span className="muted small">{[i.ref, i.room && `${t('common.room')} ${i.room}`, i.guest, stamp(i.discoveredAt, locale)].filter(Boolean).join(' · ')}</span></span>
              <span className="rc-side">{i.charge ? <strong dir="ltr">{money(i.charge)}</strong> : i.estimated ? <span className="muted small" dir="ltr">≈ {money(i.estimated)}</span> : null}<Badge tone={sevTone(i.severity)}>{t(`dm.sev.${i.severity}` as Key)}</Badge><Badge tone={tone(i.status)}>{t(`dm.s.${i.status}` as Key)}</Badge></span>
            </button></li>))}</ul>)}
      </>}
      {creating && <CreateSheet base={base} onDone={(id) => { setCreating(false); live.reload(); if (view) setOpen(id); }} onClose={() => setCreating(false)} />}
      {open && <DetailSheet base={base} id={open} onChanged={live.reload} onClose={() => setOpen(null)} />}
    </section>
  );
}

function CreateSheet({ base, onDone, onClose }: { base: string; onDone: (id: string) => void; onClose: () => void }) {
  const { t } = useT(); const { property } = useAuth(); const { busy, problem, run } = useAction();
  const rooms = useLive<{ items: Array<{ id: string; number: string }> }>(`/v1/properties/${property!.id}/rooms`, 600_000);
  const [booking, setBooking] = useState<{ id: string; label: string } | null>(null); const [roomId, setRoomId] = useState(''); const [area, setArea] = useState(''); const [cat, setCat] = useState<(typeof CATS)[number]>('FIXTURE'); const [sev, setSev] = useState('MINOR'); const [desc, setDesc] = useState(''); const [est, setEst] = useState('');
  const ok = area.trim().length >= 2 && desc.trim().length >= 3 && (booking || roomId);
  return (
    <Sheet title={t('dm.new')} onClose={onClose}>
      <p className="muted small">{t('dm.suspectedNote')}</p>
      <BookingPick value={booking} onChange={setBooking} />
      <label>{t('common.room')}<select value={roomId} onChange={(e) => setRoomId(e.target.value)}><option value="">{booking ? t('dm.roomAuto') : '—'}</option>{rooms.data?.items.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}</select></label>
      <label>{t('dm.area')}<input value={area} maxLength={120} onChange={(e) => setArea(e.target.value)} placeholder={t('dm.areaEx')} /></label>
      <div className="grid2">
        <label>{t('dm.category')}<select value={cat} onChange={(e) => setCat(e.target.value as typeof cat)}>{CATS.map((c) => <option key={c} value={c}>{t(`dm.c.${c}` as Key)}</option>)}</select></label>
        <label>{t('dm.severity')}<select value={sev} onChange={(e) => setSev(e.target.value)}>{['MINOR', 'MODERATE', 'MAJOR'].map((c) => <option key={c} value={c}>{t(`dm.sev.${c}` as Key)}</option>)}</select></label>
      </div>
      <label>{t('dm.description')}<textarea rows={4} maxLength={2000} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <label>{t('dm.estimate')} ({t('common.optional')})<input value={est} onChange={(e) => setEst(e.target.value)} inputMode="decimal" dir="ltr" placeholder="2500" /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || !ok} onClick={async () => { const r = await run(() => api<{ id: string }>('POST', base, { ...(booking ? { reservationId: booking.id } : {}), ...(roomId ? { roomId } : {}), area: area.trim(), category: cat, severity: sev, description: desc.trim(), ...(est.trim() ? { estimatedCost: est.trim() } : {}) })); if (r) onDone(r.id); }}>{t('dm.report')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function DetailSheet({ base, id, onChanged, onClose }: { base: string; id: string; onChanged: () => void; onClose: () => void }) {
  const { t, locale } = useT(); const { can } = useAuth(); const withStepUp = useStepUp(); const { busy, problem, run } = useAction();
  const live = useLive<Detail>(`${base}/${id}`, 0);
  const [form, setForm] = useState<null | 'verify' | 'approve' | 'waive' | 'dismiss' | 'resolve' | 'respond' | 'note' | 'costs'>(null); const [a, setA] = useState(''); const [b, setB] = useState('');
  const d = live.data;
  if (!d) return <Sheet title={t('dm.title')} onClose={onClose}>{live.error ? <ErrorLine code={live.error.code} detail={live.error.message} /> : <Spinner />}</Sheet>;
  const manage = can('damage.manage'); const charge = can('damage.charge') && d.canCharge; const open = OPEN.includes(d.status);
  const post = async (path: string, body?: unknown, sensitive = false) => { const r = await run(() => (sensitive ? withStepUp(() => api('POST', `${base}/${id}/${path}`, body ?? {})) : api('POST', `${base}/${id}/${path}`, body ?? {}))); if (r) { setForm(null); setA(''); setB(''); live.reload(); onChanged(); } };
  const kv = (k: string, v: string | null | undefined) => v ? <div><dt className="muted small">{k}</dt><dd>{v}</dd></div> : null;
  return (
    <Sheet title={`${d.ref} · ${d.area}`} onClose={onClose} wide>
      <div className="row"><Badge tone={tone(d.status)}>{t(`dm.s.${d.status}` as Key)}</Badge><Badge tone={sevTone(d.severity)}>{t(`dm.sev.${d.severity}` as Key)}</Badge><span className="muted small">{t(`dm.c.${d.category}` as Key)}</span></div>
      <p>{d.description}</p>
      <dl className="summary">
        {kv(t('common.room'), d.room)}{kv(t('ws.guest'), d.guest)}{kv(t('cb.booking'), d.confirmationNo)}{kv(t('dm.discovered'), stamp(d.discoveredAt, locale))}{kv(t('dm.reportedBy'), d.reportedBy)}
        {kv(t('dm.estimate'), d.estimated && money(d.estimated))}{kv(t('dm.actual'), d.actual && money(d.actual))}{kv(t('dm.approved'), d.charge && `${money(d.charge)}${d.approvedBy ? ` · ${d.approvedBy}` : ''}`)}{kv(t('dm.waived'), Number(d.waived.amount) > 0 ? money(d.waived) : null)}
        {kv(t('dm.guestTold'), d.guestNotifiedAt && `${stamp(d.guestNotifiedAt, locale)}${d.guestNotifiedBy ? ` · ${d.guestNotifiedBy}` : ''}`)}{kv(t('dm.guestResponse'), d.guestResponse && `${t(`dm.r.${d.guestResponse}` as Key)}${d.guestResponseNote ? ` — ${d.guestResponseNote}` : ''}`)}
        {kv(t('dm.bill'), d.folio && `${d.folio.number} · ${d.folio.status === 'OPEN' ? t('dm.billOpen') : t('dm.billClosed')} · ${money(d.folio.balance)}`)}{kv(t('dm.internal'), d.internalNote)}{kv(t('dm.resolution'), d.resolutionNote ?? d.waiveReason)}
      </dl>
      {d.status === 'CHARGED' && <p className="muted small">{d.taxNote}</p>}
      <h3>{t('cb.evidence')}</h3><Photos base={`${base}/${id}`} ids={d.photos} canAdd={can('damage.report') && open} onAdded={live.reload} />
      {open && (
        <div className="stack">
          <div className="actions">
            {manage && d.status === 'SUSPECTED' && <button className="primary" onClick={() => setForm('verify')}>{t('dm.verify')}</button>}
            {manage && d.status !== 'SUSPECTED' && <button onClick={() => { setA(d.actual?.amount ?? ''); setB(d.estimated?.amount ?? ''); setForm('costs'); }}>{t('dm.costs')}</button>}
            {manage && d.status !== 'SUSPECTED' && !d.guestNotifiedAt && <button onClick={() => void post('notify-guest')}>{t('dm.tellGuest')}</button>}
            {manage && d.guestNotifiedAt && <button onClick={() => setForm('respond')}>{t('dm.recordResponse')}</button>}
            {charge && d.status !== 'SUSPECTED' && d.status !== 'CHARGE_APPROVED' && <button onClick={() => { setA(d.actual?.amount ?? d.estimated?.amount ?? ''); setForm('approve'); }}>{t('dm.approve')}</button>}
            {charge && d.status === 'CHARGE_APPROVED' && <button className="primary" disabled={busy} onClick={() => void post('charge', {}, true)}>{t('dm.chargeBill')}</button>}
            {charge && ['VERIFIED', 'DISPUTED', 'CHARGE_APPROVED'].includes(d.status) && <button onClick={() => setForm('waive')}>{t('dm.waive')}</button>}
            {manage && <button onClick={() => setForm('dismiss')}>{t('dm.dismiss')}</button>}
            <button onClick={() => setForm('note')}>{t('dm.note')}</button>
          </div>
        </div>)}
      {!open && manage && ['CHARGED', 'WAIVED', 'DISMISSED'].includes(d.status) && <div className="actions"><button className="primary" onClick={() => setForm('resolve')}>{t('dm.resolve')}</button></div>}
      {form && (
        <div className="card inner stack" role="group" aria-label={t(`dm.${form === 'respond' ? 'recordResponse' : form === 'costs' ? 'costs' : form}` as Key)}>
          {form === 'verify' && <><label>{t('dm.verifyNote')}<input value={b} onChange={(e) => setB(e.target.value)} /></label><label>{t('dm.actual')} ({t('common.optional')})<input value={a} onChange={(e) => setA(e.target.value)} inputMode="decimal" dir="ltr" /></label><button className="primary" disabled={busy} onClick={() => void post('verify', { ...(b.trim() ? { note: b.trim() } : {}), ...(a.trim() ? { actualCost: a.trim() } : {}) })}>{t('dm.verify')}</button></>}
          {form === 'costs' && <><label>{t('dm.estimate')}<input value={b} onChange={(e) => setB(e.target.value)} inputMode="decimal" dir="ltr" /></label><label>{t('dm.actual')}<input value={a} onChange={(e) => setA(e.target.value)} inputMode="decimal" dir="ltr" /></label>
            <button className="primary" disabled={busy} onClick={async () => { const r = await run(() => api('PATCH', `${base}/${id}`, { estimatedCost: b.trim() || null, actualCost: a.trim() || null })); if (r) { setForm(null); live.reload(); onChanged(); } }}>{t('common.save')}</button></>}
          {form === 'respond' && <><div className="actions"><button className="primary" disabled={busy} onClick={() => void post('guest-response', { response: 'ACKNOWLEDGED', ...(b.trim() ? { note: b.trim() } : {}) })}>{t('dm.r.ACKNOWLEDGED')}</button><button disabled={busy} onClick={() => void post('guest-response', { response: 'DISPUTED', ...(b.trim() ? { note: b.trim() } : {}) })}>{t('dm.r.DISPUTED')}</button></div><label>{t('dm.responseNote')}<input value={b} onChange={(e) => setB(e.target.value)} /></label></>}
          {form === 'approve' && <><p className="muted small">{t('dm.approveHelp')}</p><label>{t('dm.chargeAmount')}<input value={a} onChange={(e) => setA(e.target.value)} inputMode="decimal" dir="ltr" /></label><label>{t('dm.reason')} ({t('common.optional')})<input value={b} onChange={(e) => setB(e.target.value)} /></label><button className="primary" disabled={busy || !a.trim()} onClick={() => void post('approve-charge', { amount: a.trim(), ...(b.trim() ? { reason: b.trim() } : {}) }, true)}>{t('dm.approve')}</button></>}
          {form === 'waive' && <><label>{t('dm.waiveAmount')} ({t('dm.waiveAll')})<input value={a} onChange={(e) => setA(e.target.value)} inputMode="decimal" dir="ltr" /></label><label>{t('dm.reason')}<input value={b} onChange={(e) => setB(e.target.value)} /></label><button className="primary" disabled={busy || b.trim().length < 3} onClick={() => void post('waive', { ...(a.trim() ? { amount: a.trim() } : {}), reason: b.trim() }, true)}>{t('dm.waive')}</button></>}
          {form === 'dismiss' && <><label>{t('dm.reason')}<input value={b} onChange={(e) => setB(e.target.value)} /></label><button className="primary" disabled={busy || b.trim().length < 3} onClick={() => void post('dismiss', { reason: b.trim() })}>{t('dm.dismiss')}</button></>}
          {form === 'resolve' && <><label>{t('dm.resolution')}<input value={b} onChange={(e) => setB(e.target.value)} /></label><button className="primary" disabled={busy || b.trim().length < 3} onClick={() => void post('resolve', { note: b.trim() })}>{t('dm.resolve')}</button></>}
          {form === 'note' && <><label>{t('dm.note')}<input value={b} onChange={(e) => setB(e.target.value)} /></label><button className="primary" disabled={busy || b.trim().length < 2} onClick={() => void post('note', { note: b.trim() })}>{t('common.save')}</button></>}
          <button type="button" className="link" onClick={() => setForm(null)}>{t('common.cancel')}</button>
        </div>)}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <h3>{t('dm.history')}</h3><Timeline events={d.events} label={(x) => t(`dm.e.${x}` as Key)} />
    </Sheet>
  );
}
