import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { shortDate, whatsappNumber } from '../lib/format.js';
import { useAuth, useLive, useWork } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';

const CATS = ['DOCUMENT', 'ELECTRONICS', 'JEWELLERY', 'CLOTHING', 'BAG', 'KEYS', 'MONEY', 'MEDICINE', 'OTHER'] as const;
interface Row { id: string; ref: string | null; item: string; category: string; status: string; highValue: boolean; roomNumber: string | null; location: string | null; storageLocation: string | null; guestName: string | null; foundAt: string; dueForDisposal: boolean; coverPhotoId: string | null }
interface Detail extends Omit<Row, 'coverPhotoId' | 'guestName'> {
  description: string | null; roomId: string | null; foundBy: string | null; foundById: string; guest: { id: string; name: string; phone: string | null } | null; reservationRef: string | null; reservationId: string | null; disposeAfter: string | null; canDisposeNow: boolean;
  closedAt: string | null; closedBy: string | null; closedNote: string | null; receiverName: string | null; receiverIdNote: string | null; handoverMethod: string | null; courierRef: string | null; verifiedNote: string | null; photos: Array<{ id: string; phase: string }>; version: number;
  events: Array<{ action: string; note: string | null; at: string; by: string | null }>;
}
interface Suggestion { guestId: string; reservationId: string; guestName: string; confirmationNo: string; arrival: string; departure: string }
type Filter = 'OPEN' | 'RETURNED' | 'DISPOSED';
const tone = (s: string) => (s === 'RETURNED' ? 'clean' : s === 'DISPOSED' ? 'neutral' : s === 'OWNER_CONTACTED' ? 'cleaning' : 'warn') as 'clean' | 'neutral' | 'cleaning' | 'warn';
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/** Lost & found: log an item with a picture, find who it may belong to, tell them, and hand it back with a record of who took it. */
export function LostFound() {
  const { t, locale } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/lost-found`;
  const [filter, setFilter] = useState<Filter>('OPEN'); const [q, setQ] = useState('');
  const live = useLive<{ items: Row[]; counts: Record<string, number> }>(`${base}?status=${filter}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`, 60_000);
  const [creating, setCreating] = useState(false); const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="stack">
      <div className="row between"><h2>{t('lf.title')}</h2>{can('housekeeping.update') && <button className="primary small" onClick={() => setCreating(true)}>{t('lf.new')}</button>}</div>
      <div className="chips">{(['OPEN', 'RETURNED', 'DISPOSED'] as const).map((f) => <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>{t(`lfw.f.${f}` as Key)}</Chip>)}</div>
      <label>{t('lfw.search')}<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('lfw.searchEx')} /></label>
      {!live.data ? <Spinner /> : live.data.items.length === 0 ? <Empty text={t('lf.empty')} /> : (
        <ul className="plain rows">{live.data.items.map((i) => (
          <li key={i.id}><button className="row-card" onClick={() => setOpen(i.id)}>
            {i.coverPhotoId ? <img className="lf-thumb" src={`${base}/${i.id}/photos/${i.coverPhotoId}`} alt="" loading="lazy" /> : <span className="lf-thumb lf-none" aria-hidden="true">?</span>}
            <span className="rc-main"><strong>{i.item}</strong><span className="muted small">{[i.ref, t(`lfw.c.${i.category}` as Key), i.roomNumber && `${t('common.room')} ${i.roomNumber}`, i.location, shortDate(i.foundAt.slice(0, 10), locale), i.guestName, i.storageLocation].filter(Boolean).join(' · ')}</span></span>
            <span className="rc-side">{i.highValue && <Badge tone="urgent">{t('lfw.highValue')}</Badge>}{i.dueForDisposal && <Badge tone="dirty">{t('lfw.dueDisposal')}</Badge>}<Badge tone={tone(i.status)}>{t(`lfw.s.${i.status}` as Key)}</Badge></span>
          </button></li>))}</ul>)}
      {creating && <CreateSheet base={base} onDone={() => { setCreating(false); live.reload(); }} onClose={() => setCreating(false)} />}
      {open && <DetailSheet base={base} id={open} onChanged={live.reload} onClose={() => setOpen(null)} />}
    </section>
  );
}

function CreateSheet({ base, onDone, onClose }: { base: string; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const work = useWork();
  const rooms = useLive<{ items: Array<{ id: string; number: string }> }>(`/v1/properties/${property!.id}/rooms`, 600_000);
  const [f, setF] = useState({ item: '', category: 'OTHER', description: '', roomId: '', location: '', storage: '', foundAt: nowLocal(), high: false });
  const [owner, setOwner] = useState<Suggestion | null>(null); const [sug, setSug] = useState<Suggestion[]>([]);
  const [photos, setPhotos] = useState<File[]>([]); const pick = useRef<HTMLInputElement>(null);
  const { busy, problem, run } = useAction(); const [queued, setQueued] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  useEffect(() => {
    setSug([]); if (!f.roomId) return;
    let dead = false; const date = f.foundAt.slice(0, 10);
    api<{ items: Suggestion[] }>('GET', `${base}/suggest-owner?roomId=${f.roomId}&date=${date}`).then((r) => { if (!dead) setSug(r.items); }).catch(() => undefined);
    return () => { dead = true; };
  }, [f.roomId, f.foundAt, base]);
  const go = async () => {
    const body = { item: f.item.trim(), category: f.category, highValue: f.high, foundAt: new Date(f.foundAt).toISOString(), ...(f.description.trim() ? { description: f.description.trim() } : {}), ...(f.roomId ? { roomId: f.roomId } : {}), ...(f.location.trim() ? { location: f.location.trim() } : {}),
      ...(f.storage.trim() ? { storageLocation: f.storage.trim() } : {}), ...(owner ? { guestId: owner.guestId, reservationId: owner.reservationId } : {}) };
    const out = await run(async () => {
      const r = await work.run<{ id: string }>({ method: 'POST', path: base, body, effect: { kind: 'lostfound' } });
      if (r.queued) return { queued: true as const };
      for (const file of photos) { const fd = new FormData(); fd.append('file', file); await api('POST', `${base}/${r.data!.id}/photos`, fd); }
      return { queued: false as const };
    });
    if (out) { if (out.queued) setQueued(true); else onDone(); }
  };
  return (
    <Sheet title={t('lf.new')} onClose={onClose}>
      {queued ? (<><p className="ok" role="status">{t('lfw.queued')}</p><div className="actions"><button className="primary" onClick={onDone}>{t('common.close')}</button></div></>) : (<>
        <div className="stack">
          <input ref={pick} type="file" hidden accept="image/*" capture="environment" multiple onChange={(e) => { setPhotos([...photos, ...Array.from(e.target.files ?? [])].slice(0, 6)); e.target.value = ''; }} />
          <button type="button" onClick={() => pick.current?.click()}>{photos.length ? t('lfw.morePhotos', { n: photos.length }) : t('lfw.takePhoto')}</button>
          {photos.length > 0 && <div className="lf-grid">{photos.map((p, i) => <figure key={i} className="media-tile"><img src={URL.createObjectURL(p)} alt={p.name} /><figcaption><button type="button" onClick={() => setPhotos(photos.filter((_, k) => k !== i))}>{t('ci.remove')}</button></figcaption></figure>)}</div>}
        </div>
        <label>{t('lf.item')}<input value={f.item} onChange={set('item')} placeholder={t('lfw.itemEx')} autoFocus /></label>
        <div className="grid2"><label>{t('mt.category')}<select value={f.category} onChange={set('category')}>{CATS.map((c) => <option key={c} value={c}>{t(`lfw.c.${c}` as Key)}</option>)}</select></label>
          <label>{t('lfw.foundAt')}<input type="datetime-local" value={f.foundAt} max={nowLocal()} onChange={set('foundAt')} dir="ltr" /></label></div>
        <label>{t('lfw.details')}<textarea rows={2} value={f.description} onChange={set('description')} placeholder={t('lfw.descEx')} /></label>
        <div className="grid2"><label>{t('d.room')}<select value={f.roomId} onChange={set('roomId')}><option value="">—</option>{rooms.data?.items.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}</select></label>
          <label>{t('lf.location')}<input value={f.location} onChange={set('location')} placeholder={t('lfw.locEx')} /></label></div>
        {sug.length > 0 && !owner && (<div className="card inner stack small"><strong>{t('lfw.mayBe')}</strong>
          {sug.map((s) => <button key={s.reservationId} type="button" className="wide pick" onClick={() => setOwner(s)}>{s.guestName} <span className="muted">· {s.confirmationNo} · {s.arrival} → {s.departure}</span></button>)}</div>)}
        {owner && <p className="card inner small">{t('lfw.ownerIs')}: <strong>{owner.guestName}</strong> ({owner.confirmationNo}) <button type="button" className="link" onClick={() => setOwner(null)}>{t('ci.remove')}</button></p>}
        <label>{t('lfw.storage')}<input value={f.storage} onChange={set('storage')} placeholder={t('lfw.storageEx')} /></label>
        <label className="check"><input type="checkbox" checked={f.high} onChange={(e) => setF({ ...f, high: e.target.checked })} /> {t('lfw.highValueLong')}</label>
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        <div className="actions"><button className="primary" disabled={busy || f.item.trim().length < 2} onClick={() => void go()}>{t('lf.add')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
      </>)}
    </Sheet>
  );
}

function DetailSheet({ base, id, onChanged, onClose }: { base: string; id: string; onChanged: () => void; onClose: () => void }) {
  const { t, locale } = useT();
  const { can, me } = useAuth();
  const d = useLive<Detail>(`${base}/${id}`, 20_000);
  const [mode, setMode] = useState<null | 'message' | 'return' | 'dispose' | 'note' | 'reopen' | 'owner'>(null);
  const { busy, problem, run, clear } = useAction();
  const [f, setF] = useState({ receiver: '', idNote: '', method: 'HAND_OVER', courier: '', verified: '', reason: '', early: false, note: '', q: '' });
  const [hits, setHits] = useState<Array<{ guestId: string; guestName: string; reservationId: string; confirmationNo: string; arrival: string; departure: string }>>([]);
  const pick = useRef<HTMLInputElement>(null);
  const o = d.data; const open = !!o && ['FOUND', 'OWNER_CONTACTED'].includes(o.status);
  const act = async (tail: string, body: unknown) => { if (await run(() => api('POST', `${base}/${id}/${tail}`, body))) { d.reload(); onChanged(); setMode(null); setF({ receiver: '', idNote: '', method: 'HAND_OVER', courier: '', verified: '', reason: '', early: false, note: '', q: '' }); } };
  useEffect(() => {
    if (mode !== 'owner' || f.q.trim().length < 2) { setHits([]); return; }
    const h = setTimeout(() => { api<{ items: Array<{ guestId: string; guestName: string; reservationId: string; confirmationNo: string; arrival: string; departure: string }> }>('GET', `${base}/find-guest?q=${encodeURIComponent(f.q.trim())}`).then((r) => setHits(r.items)).catch(() => setHits([])); }, 250);
    return () => clearTimeout(h);
  }, [f.q, mode]);
  const upload = async (files: FileList | null, phase: 'FOUND' | 'HANDOVER') => { for (const file of Array.from(files ?? [])) { const fd = new FormData(); fd.append('file', file); if (!(await run(() => api('POST', `${base}/${id}/photos?phase=${phase}`, fd)))) break; } d.reload(); onChanged(); };
  const sameFinder = !!o && o.highValue && o.foundById === me?.user.id;
  return (
    <Sheet title={o ? `${o.ref ?? ''} · ${o.item}` : '…'} onClose={onClose}>
      {!o ? <Spinner /> : (<>
        <div className="card inner stack small">
          <div className="row between"><span>{t(`lfw.c.${o.category}` as Key)}{o.highValue ? ` · ${t('lfw.highValue')}` : ''}</span><Badge tone={tone(o.status)}>{t(`lfw.s.${o.status}` as Key)}</Badge></div>
          {o.description && <span>{o.description}</span>}
          <span className="muted">{[o.roomNumber && `${t('common.room')} ${o.roomNumber}`, o.location, shortDate(o.foundAt.slice(0, 10), locale), o.foundBy].filter(Boolean).join(' · ')}</span>
          {o.storageLocation && <span>{t('lfw.storage')}: <strong>{o.storageLocation}</strong></span>}
          <span>{o.guest ? <>{t('lfw.ownerIs')}: <strong>{o.guest.name}</strong>{o.reservationRef ? ` (${o.reservationRef})` : ''}</> : <span className="muted">{t('lfw.noOwner')}</span>}</span>
          {o.disposeAfter && open && <span className={o.canDisposeNow ? 'warnbox' : 'muted'}>{t('lfw.keepUntil')} {shortDate(o.disposeAfter, locale)}</span>}
          {o.status === 'RETURNED' && <span className="okbox">{t('lfw.returnedTo')}: {o.receiverName}{o.handoverMethod === 'COURIER' ? ` · ${t('lfw.courier')} ${o.courierRef}` : o.receiverIdNote ? ` · ${o.receiverIdNote}` : ''}<br />{o.verifiedNote}</span>}
          {o.status === 'DISPOSED' && <span className="muted">{t('lfw.disposedBecause')}: {o.closedNote}</span>}
        </div>
        <div className="lf-grid">{o.photos.map((p) => <figure key={p.id} className="media-tile"><img src={`${base}/${id}/photos/${p.id}`} alt={`${o.item} (${p.phase === 'HANDOVER' ? t('lfw.handoverPhoto') : t('lfw.foundPhoto')})`} loading="lazy" />
          {can('housekeeping.update') && open && <figcaption><button onClick={async () => { if (await run(() => api('DELETE', `${base}/${id}/photos/${p.id}`))) d.reload(); }}>{t('ci.remove')}</button></figcaption>}</figure>)}</div>
        {can('housekeeping.update') && (open || o.status === 'RETURNED') && <><input ref={pick} type="file" hidden accept="image/*" capture="environment" multiple onChange={(e) => { void upload(e.target.files, o.status === 'RETURNED' ? 'HANDOVER' : 'FOUND'); e.target.value = ''; }} />
          <button type="button" disabled={busy} onClick={() => pick.current?.click()}>{t('lfw.addPhoto')}</button></>}

        {open && can('housekeeping.update') && (
          <div className="actions">
            <button onClick={() => { setMode(mode === 'owner' ? null : 'owner'); clear(); }}>{o.guest ? t('lfw.changeOwner') : t('lfw.linkOwner')}</button>
            {o.guest && <button onClick={() => { setMode(mode === 'message' ? null : 'message'); clear(); }}>{t('lfw.tellGuest')}</button>}
            <button onClick={() => { setMode(mode === 'note' ? null : 'note'); clear(); }}>{t('lfw.addNote')}</button>
          </div>)}
        {mode === 'owner' && (
          <div className="card inner stack"><label>{t('lfw.findGuest')}<input type="search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder={t('lfw.findGuestEx')} autoFocus /></label>
            {hits.map((g) => <button key={g.guestId} className="wide pick" onClick={async () => { if (await run(() => api('PATCH', `${base}/${id}`, { guestId: g.guestId, reservationId: g.reservationId, version: o.version }))) { d.reload(); onChanged(); setMode(null); } }}>{g.guestName} <span className="muted small">· {g.confirmationNo} · {g.arrival} → {g.departure}</span></button>)}
            {o.guest && <button className="link" onClick={async () => { if (await run(() => api('PATCH', `${base}/${id}`, { guestId: null, version: o.version }))) { d.reload(); onChanged(); setMode(null); } }}>{t('lfw.unlink')}</button>}</div>)}
        {mode === 'message' && <GuestNotice base={base} id={id} phoneKnown={!!o.guest?.phone} onSent={() => act('contact', { channel: 'WHATSAPP' })} />}
        {mode === 'note' && <div className="card inner stack"><label>{t('common.note')}<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label><button disabled={busy || f.note.trim().length < 3} onClick={() => act('notes', { note: f.note.trim() })}>{t('common.save')}</button></div>}

        {open && can('housekeeping.assign') && (
          <div className="actions">
            <button className="primary" disabled={sameFinder} title={sameFinder ? t('lfw.secondPerson') : undefined} onClick={() => { setMode(mode === 'return' ? null : 'return'); clear(); }}>{t('lfw.handBack')}</button>
            <button disabled={sameFinder} onClick={() => { setMode(mode === 'dispose' ? null : 'dispose'); clear(); }}>{t('lf.disposed')}</button>
            {sameFinder && <span className="muted small">{t('lfw.secondPerson')}</span>}
          </div>)}
        {mode === 'return' && (
          <div className="card inner stack"><strong>{t('lfw.handBack')}</strong>
            <label>{t('lfw.method')}<select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="HAND_OVER">{t('lfw.m.HAND_OVER')}</option><option value="REPRESENTATIVE">{t('lfw.m.REPRESENTATIVE')}</option><option value="COURIER">{t('lfw.m.COURIER')}</option></select></label>
            <label>{t('lfw.receiver')}<input value={f.receiver} onChange={(e) => setF({ ...f, receiver: e.target.value })} /></label>
            {f.method === 'COURIER' ? <label>{t('lfw.courierRef')}<input value={f.courier} onChange={(e) => setF({ ...f, courier: e.target.value })} dir="ltr" /></label> : <label>{t('lfw.idShown')}<input value={f.idNote} onChange={(e) => setF({ ...f, idNote: e.target.value })} placeholder={t('lfw.idShownEx')} /></label>}
            <label>{t('lfw.verified')}<input value={f.verified} onChange={(e) => setF({ ...f, verified: e.target.value })} placeholder={t('lfw.verifiedEx')} /></label>
            <button className="primary" disabled={busy || f.receiver.trim().length < 2 || f.verified.trim().length < 3 || (f.method === 'COURIER' ? !f.courier.trim() : !f.idNote.trim())}
              onClick={() => act('return', { receiverName: f.receiver.trim(), method: f.method, verified: f.verified.trim(), ...(f.method === 'COURIER' ? { courierRef: f.courier.trim() } : { receiverIdNote: f.idNote.trim() }) })}>{t('lfw.confirmReturn')}</button></div>)}
        {mode === 'dispose' && (
          <div className="card inner stack"><label>{t('common.reason')}<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
            {!o.canDisposeNow && <label className="check"><input type="checkbox" checked={f.early} onChange={(e) => setF({ ...f, early: e.target.checked })} /> {t('lfw.early')}</label>}
            <button disabled={busy || f.reason.trim().length < 3 || (!o.canDisposeNow && !f.early)} onClick={() => act('dispose', { reason: f.reason.trim(), early: f.early })}>{t('lfw.confirmDispose')}</button></div>)}
        {!open && can('housekeeping.assign') && (
          <div className="row"><input value={f.reason} placeholder={t('common.reason')} onChange={(e) => setF({ ...f, reason: e.target.value })} /><button disabled={busy || f.reason.trim().length < 3} onClick={() => act('reopen', { reason: f.reason.trim() })}>{t('lfw.reopen')}</button></div>)}
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        <h3>{t('rs.tab.history')}</h3>
        <ul className="plain small">{o.events.map((e, i) => <li key={i} className="row between"><span>{t(`lfw.e.${e.action}` as Key) === `lfw.e.${e.action}` ? e.action : t(`lfw.e.${e.action}` as Key)}{e.note ? ` · ${e.note}` : ''}</span><span className="muted">{e.by} · {new Date(e.at).toLocaleString(locale === 'ur' ? 'ur-PK' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })}</span></li>)}</ul>
      </>)}
    </Sheet>
  );
}

/** The message to the guest it may belong to: editable, opens WhatsApp, and marks the owner as contacted. */
function GuestNotice({ base, id, phoneKnown, onSent }: { base: string; id: string; phoneKnown: boolean; onSent: () => void }) {
  const { t } = useT();
  const [data, setData] = useState<{ text: string; phone: string | null } | null>(null); const [text, setText] = useState(''); const [failed, setFailed] = useState(false);
  useEffect(() => { let dead = false; api<{ text: string; phone: string | null }>('POST', `${base}/${id}/message`).then((r) => { if (!dead) { setData(r); setText(r.text); } }).catch((e) => { if (!dead) setFailed(e instanceof ApiError || true); }); return () => { dead = true; }; }, [base, id]);
  if (failed) return <p className="warnbox small">{t('lfw.failed')}</p>;
  if (!data) return <p className="muted small">{t('common.loading')}</p>;
  const wa = whatsappNumber(data.phone);
  return (
    <div className="card inner stack">
      <label>{t('wa.message')}<textarea dir="ltr" rows={11} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <div className="actions">{wa ? <a className="primary button" href={`https://wa.me/${wa}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer" onClick={onSent}>{t('lfw.sendAndMark')}</a> : <p className="warnbox small">{phoneKnown ? t('ws.noPhone') : t('ws.noPhone')}</p>}
        <button onClick={() => void navigator.clipboard?.writeText(text)}>{t('wa.copy')}</button></div>
    </div>
  );
}
