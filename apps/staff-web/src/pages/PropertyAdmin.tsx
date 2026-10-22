import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { useAuth, useLive } from '../state.js';
import { Banner, ConfirmCard, Field, SidePanel, Skeleton, StatusBadge } from '../ui/ds.js';
import { Icon } from '../ui/icons.js';
import { Empty, ErrorLine } from '../ui/kit.js';
import { Link, navigate, useRoute } from '../shell/router.js';
import { ShortStayRule } from './ShortStayRule.js';

interface Prop { id: string; code: string; name: string; status: string; timezone: string; currency?: string; businessDate?: string; weekendDays?: number[]; version?: number; city?: string | null; mapsUrl?: string | null; terms?: string | null; checkInTime?: string; checkOutTime?: string }
interface Status { property: Prop & { version: number; weekendDays: number[] }; steps: Record<string, boolean>; counts: { floors: number; roomTypes: number; rooms: number }; blockers: string[]; readyToGoLive: boolean }
interface Floor { id: string; name: string }
interface RoomType { id: string; code: string; name: string; description: string | null; maxAdults: number; maxChildren: number; maxOccupancy: number; baseOccupancy: number; bedConfig: string | null; sizeSqm: number | null; status: string; version: number; amenityIds: string[] }
interface Amenity { id: string; code: string; nameEn: string; nameUr: string | null; category: string }
const ZONES = ['Asia/Karachi', 'Asia/Dubai', 'Asia/Riyadh', 'Europe/London', 'America/New_York', 'UTC'];
const DAYS: Array<[number, Key]> = [[1, 'ps.d1'], [2, 'ps.d2'], [3, 'ps.d3'], [4, 'ps.d4'], [5, 'ps.d5'], [6, 'ps.d6'], [7, 'ps.d7']];
const codeFrom = (name: string) => name.replace(/[^A-Za-z0-9]+/g, '').toUpperCase().slice(0, 6);

/** Administration → Properties: every property with its state, and a way to add one. */
export function PropertiesTab() {
  const { t } = useT();
  const route = useRoute();
  const open = route.query.get('p');
  const list = useLive<{ items: Prop[] }>('/v1/properties', 60_000);
  const [adding, setAdding] = useState(false);
  if (open) return <PropertySetup id={open} />;
  return (
    <section aria-labelledby="h-props">
      <div className="page-head"><h2 id="h-props">{t('ps.title')}</h2><button className="primary" onClick={() => setAdding(true)}><Icon name="rooms" size={16} /> {t('ps.add')}</button></div>
      <p className="muted">{t('ps.intro')}</p>
      {!list.data ? <Skeleton rows={3} /> : list.data.items.length === 0 ? <Empty text={t('common.none')} /> : (
        <ul className="plain queue" aria-label={t('ps.title')}>{list.data.items.map((p) => (
          <li key={p.id}><Link to={`/admin?tab=properties&p=${p.id}`} className="qrow"><span className="q-main"><strong>{p.name}</strong><span className="muted small">{p.code} · {p.timezone}</span></span>
            <span className="q-badges">{p.status === 'LIVE' ? <StatusBadge tone="ok" icon="check">{t('ps.live')}</StatusBadge> : <StatusBadge tone="warn" icon="alert">{t('ps.setup')}</StatusBadge>}</span><span className="q-next"><Icon name="chevron" size={18} /></span></Link></li>))}</ul>)}
      {adding && <AddProperty onClose={() => setAdding(false)} />}
    </section>
  );
}

function AddProperty({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const { refreshProperties, setPropertyId } = useAuth();
  const ents = useLive<{ items: Array<{ id: string; name: string }> }>('/v1/property-owners', 600_000);
  const [f, setF] = useState({ name: '', code: '', timezone: 'Asia/Karachi', currency: 'PKR', legalEntityId: '' }); const [codeTouched, setCodeTouched] = useState(false);
  const { busy, problem, run } = useAction();
  const entity = f.legalEntityId || ents.data?.items[0]?.id || '';
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const valid = f.name.trim().length >= 2 && /^[A-Za-z0-9_-]{2,20}$/.test(f.code) && /^[A-Z]{3}$/.test(f.currency) && !!entity;
  const go = async () => {
    const p = await run(() => api<Prop>('POST', '/v1/properties', { name: f.name.trim(), code: f.code, timezone: f.timezone.trim(), currency: f.currency, legalEntityId: entity }));
    if (p) { await refreshProperties().catch(() => undefined); setPropertyId(p.id); onClose(); navigate(`/admin?tab=properties&p=${p.id}`); }
  };
  return (
    <SidePanel title={t('ps.add')} subtitle={t('ps.addSub')} onClose={onClose}
      footer={<div className="actions"><button className="primary" disabled={busy || !valid} onClick={() => void go()}>{t('ps.create')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>}>
      <Field label={t('ps.name')} required>{(p) => <input {...p} data-autofocus value={f.name} onChange={(e) => set({ name: e.target.value, ...(codeTouched ? {} : { code: codeFrom(e.target.value) }) })} />}</Field>
      <Field label={t('ps.code')} required hint={t('ps.codeHint')}>{(p) => <input {...p} dir="ltr" value={f.code} maxLength={20} onChange={(e) => { setCodeTouched(true); set({ code: e.target.value.toUpperCase() }); }} />}</Field>
      <div className="grid2">
        <Field label={t('ps.zone')} required>{(p) => <><input {...p} dir="ltr" list="zones" value={f.timezone} onChange={(e) => set({ timezone: e.target.value })} /><datalist id="zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist></>}</Field>
        <Field label={t('ps.currency')} required>{(p) => <input {...p} dir="ltr" maxLength={3} value={f.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />}</Field>
      </div>
      {(ents.data?.items.length ?? 0) > 1 && <Field label={t('ps.entity')} required>{(p) => <select {...p} value={entity} onChange={(e) => set({ legalEntityId: e.target.value })}>{ents.data!.items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}</Field>}
      <p className="muted small">{t('ps.afterCreate')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </SidePanel>
  );
}

/** One property's setup, top to bottom: what is missing, its details, floors, room types, rooms, and going live. */
function PropertySetup({ id }: { id: string }) {
  const { t } = useT();
  const { refreshProperties } = useAuth();
  const base = `/v1/properties/${id}`;
  const st = useLive<Status>(`${base}/setup-status`, 20_000);
  const structure = useLive<{ floors: Floor[] }>(`${base}/structure`, 20_000);
  const types = useLive<RoomType[]>(`${base}/room-types`, 20_000);
  const amenities = useLive<{ items: Amenity[] }>('/v1/amenities', 120_000);
  const [typePanel, setTypePanel] = useState<RoomType | 'new' | null>(null); const [bulk, setBulk] = useState(false);
  const reload = () => { st.reload(); structure.reload(); types.reload(); void refreshProperties().catch(() => undefined); };
  if (!st.data || !structure.data || !types.data) return <Skeleton rows={5} />;
  const p = st.data.property; const live = p.status === 'LIVE';
  const steps: Array<[boolean, string]> = [[st.data.counts.floors > 0, t('ps.s.floors', { n: st.data.counts.floors })], [st.data.counts.roomTypes > 0, t('ps.s.types', { n: st.data.counts.roomTypes })], [st.data.counts.rooms > 0, t('ps.s.rooms', { n: st.data.counts.rooms })]];
  return (
    <section aria-labelledby="h-setup">
      <p className="crumbs"><Link to="/admin?tab=properties">{t('ps.title')}</Link> <Icon name="chevron" size={14} /> <span>{p.name}</span></p>
      <div className="page-head"><h2 id="h-setup">{p.name}</h2>{live ? <StatusBadge tone="ok" icon="check">{t('ps.live')}</StatusBadge> : <StatusBadge tone="warn" icon="alert">{t('ps.setup')}</StatusBadge>}</div>

      <section className="block" aria-labelledby="h-check"><h3 id="h-check">{t('ps.checklist')}</h3>
        <ul className="plain">{steps.map(([ok, label]) => <li key={label} className="row">{ok ? <StatusBadge tone="ok" icon="check">{label}</StatusBadge> : <StatusBadge tone="warn" icon="alert">{label}</StatusBadge>}</li>)}</ul>
        <p className="muted small">{t('ps.moreSteps')}</p>
        {!live && <GoLive id={id} ready={st.data.readyToGoLive} blockers={st.data.blockers} date={p.businessDate ?? ''} onDone={reload} />}
      </section>

      <Details prop={p} onSaved={reload} />

      <section className="block" aria-labelledby="h-floors"><h3 id="h-floors">{t('ps.floors')}</h3>
        <ul className="plain">{structure.data.floors.map((f) => <li key={f.id}>{f.name}</li>)}</ul>{structure.data.floors.length === 0 && <p className="muted small">{t('ps.noFloors')}</p>}
        <AddFloor base={base} onDone={reload} />
      </section>

      <section className="block" aria-labelledby="h-types"><div className="block-head"><h3 id="h-types">{t('ps.types')}</h3><button className="primary" onClick={() => setTypePanel('new')}>{t('ps.addType')}</button></div>
        {types.data.length === 0 ? <p className="muted">{t('ps.noTypes')}</p> : (
          <ul className="plain queue">{types.data.map((rt) => (
            <li key={rt.id}><button className="qrow" onClick={() => setTypePanel(rt)} aria-haspopup="dialog"><span className="q-main"><strong>{rt.name}</strong><span className="muted small">{rt.code} · {t('ps.sleeps', { n: rt.maxOccupancy })}{rt.bedConfig ? ` · ${rt.bedConfig}` : ''}{rt.sizeSqm ? ` · ${rt.sizeSqm} m²` : ''} · {t('ps.nAmenities', { n: rt.amenityIds.length })}</span></span>
              <span className="q-badges">{rt.status === 'ARCHIVED' && <StatusBadge tone="neutral" icon="x">{t('ps.archived')}</StatusBadge>}</span><span className="q-next"><Icon name="chevron" size={18} /></span></button></li>))}</ul>)}
      </section>

      <section className="block" aria-labelledby="h-rooms"><div className="block-head"><h3 id="h-rooms">{t('ps.rooms')}</h3><button onClick={() => setBulk(true)} disabled={types.data.filter((x) => x.status === 'ACTIVE').length === 0}>{t('ps.addRooms')}</button></div>
        <p className="muted small">{t('ps.roomsNote')}</p>
      </section>

      {typePanel && <RoomTypePanel base={base} rt={typePanel === 'new' ? null : typePanel} amenities={amenities.data?.items ?? []} onAmenity={() => amenities.reload()} onClose={() => setTypePanel(null)} onDone={() => { setTypePanel(null); reload(); }} />}
      {bulk && <BulkRooms base={base} types={types.data.filter((x) => x.status === 'ACTIVE')} floors={structure.data.floors} onClose={() => setBulk(false)} onDone={() => { setBulk(false); reload(); }} />}
    </section>
  );
}

function GoLive({ id, ready, blockers, date, onDone }: { id: string; ready: boolean; blockers: string[]; date: string; onDone: () => void }) {
  const { t } = useT();
  const [d, setD] = useState(date); const { busy, problem, run } = useAction(); const [done, setDone] = useState(false);
  useEffect(() => { if (date) setD(date); }, [date]);
  if (done) return <ConfirmCard title={t('ps.nowLive')}>{t('ps.nowLiveText')}</ConfirmCard>;
  return (
    <div className="stack">
      {!ready && <Banner level="ACTION" title={t('ps.notReady')}>{blockers.map((b) => <p key={b}>{b}</p>)}</Banner>}
      <Field label={t('ps.opening')} hint={t('ps.openingHint')}>{(p) => <input {...p} type="date" dir="ltr" value={d} onChange={(e) => setD(e.target.value)} />}</Field>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={!ready || busy || !d} onClick={async () => { if (await run(() => api('POST', `/v1/properties/${id}/go-live`, { openingBusinessDate: d }))) { setDone(true); onDone(); } }}>{t('ps.goLive')}</button></div>
    </div>
  );
}

function Details({ prop, onSaved }: { prop: Status['property']; onSaved: () => void }) {
  const { t } = useT();
  const [f, setF] = useState({ name: prop.name, timezone: prop.timezone, weekend: prop.weekendDays ?? [], city: prop.city ?? '', mapsUrl: prop.mapsUrl ?? '', terms: prop.terms ?? '', checkIn: prop.checkInTime ?? '14:00', checkOut: prop.checkOutTime ?? '12:00' }); const { busy, problem, run } = useAction(); const [saved, setSaved] = useState(false); const { refreshProperties } = useAuth();
  const edit = (patch: Partial<typeof f>) => { setSaved(false); setF((x) => ({ ...x, ...patch })); };
  const toggle = (d: number) => { setSaved(false); setF((x) => ({ ...x, weekend: x.weekend.includes(d) ? x.weekend.filter((y) => y !== d) : [...x.weekend, d].sort() })); };
  return (
    <section className="block" aria-labelledby="h-det"><h3 id="h-det">{t('ps.details')}</h3>
      <Field label={t('ps.name')}>{(p) => <input {...p} value={f.name} onChange={(e) => { setSaved(false); setF({ ...f, name: e.target.value }); }} />}</Field>
      <Field label={t('ps.zone')}>{(p) => <input {...p} dir="ltr" list="zones2" value={f.timezone} onChange={(e) => { setSaved(false); setF({ ...f, timezone: e.target.value }); }} />}</Field>
      <div className="grid2">
        <Field label={t('ps.city')}>{(p) => <input {...p} value={f.city} onChange={(e) => edit({ city: e.target.value })} placeholder="Karachi" />}</Field>
        <Field label={t('ps.mapsUrl')} hint={t('ps.mapsHint')}>{(p) => <input {...p} dir="ltr" inputMode="url" value={f.mapsUrl} onChange={(e) => edit({ mapsUrl: e.target.value })} placeholder="https://maps.app.goo.gl/…" />}</Field>
        <Field label={t('ps.checkIn')}>{(p) => <input {...p} type="time" dir="ltr" value={f.checkIn} onChange={(e) => edit({ checkIn: e.target.value })} />}</Field>
        <Field label={t('ps.checkOut')}>{(p) => <input {...p} type="time" dir="ltr" value={f.checkOut} onChange={(e) => edit({ checkOut: e.target.value })} />}</Field>
      </div>
      <Field label={t('ps.terms')} hint={t('ps.termsHint')}>{(p) => <textarea {...p} rows={6} maxLength={8000} value={f.terms} onChange={(e) => edit({ terms: e.target.value })} />}</Field>
      <ShortStayRule prop={prop as never} onSaved={onSaved} />
      <datalist id="zones2">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
      <fieldset className="guestcard"><legend>{t('ps.weekend')}</legend><div className="chips">{DAYS.map(([d, k]) => <label key={d} className="check"><input type="checkbox" checked={f.weekend.includes(d)} onChange={() => toggle(d)} /> {t(k)}</label>)}</div><p className="hint">{t('ps.weekendHint')}</p></fieldset>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button disabled={busy || f.name.trim().length < 2} onClick={async () => { if (await run(() => api('PATCH', `/v1/properties/${prop.id}`, { name: f.name.trim(), timezone: f.timezone.trim(), weekendDays: f.weekend, city: f.city.trim() || null, mapsUrl: f.mapsUrl.trim() || null, terms: f.terms.trim() || null, checkInTime: f.checkIn, checkOutTime: f.checkOut, version: prop.version }))) { setSaved(true); onSaved(); void refreshProperties(); } }}>{t('common.save')}</button>{saved && <StatusBadge tone="ok" icon="check">{t('ps.saved')}</StatusBadge>}</div>
    </section>
  );
}

function AddFloor({ base, onDone }: { base: string; onDone: () => void }) {
  const { t } = useT();
  const [name, setName] = useState(''); const { busy, problem, run } = useAction();
  return (
    <div className="stack">
      <div className="row"><Field label={t('ps.floorName')}>{(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('ps.floorEx')} />}</Field><button disabled={busy || !name.trim()} onClick={async () => { if (await run(() => api('POST', `${base}/floors`, { name: name.trim() }))) { setName(''); onDone(); } }}>{t('ps.addFloor')}</button></div>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </div>
  );
}

function RoomTypePanel({ base, rt, amenities, onAmenity, onClose, onDone }: { base: string; rt: RoomType | null; amenities: Amenity[]; onAmenity: () => void; onClose: () => void; onDone: () => void }) {
  const { t, locale } = useT();
  const [f, setF] = useState({ code: rt?.code ?? '', name: rt?.name ?? '', description: rt?.description ?? '', maxAdults: String(rt?.maxAdults ?? 2), maxChildren: String(rt?.maxChildren ?? 0), maxOccupancy: String(rt?.maxOccupancy ?? 2), baseOccupancy: String(rt?.baseOccupancy ?? 2), bedConfig: rt?.bedConfig ?? '', sizeSqm: rt?.sizeSqm ? String(rt.sizeSqm) : '' });
  const [picked, setPicked] = useState<string[]>(rt?.amenityIds ?? []); const [newAm, setNewAm] = useState('');
  const { busy, problem, run } = useAction(); const am = useAction();
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const n = (s: string) => Number(s);
  const valid = f.name.trim().length >= 2 && /^[A-Za-z0-9_-]{1,20}$/.test(f.code) && n(f.maxAdults) >= 1 && n(f.maxOccupancy) >= 1 && n(f.baseOccupancy) >= 1 && n(f.baseOccupancy) <= n(f.maxOccupancy);
  const groups = useMemo(() => { const m = new Map<string, Amenity[]>(); for (const a of amenities) m.set(a.category, [...(m.get(a.category) ?? []), a]); return [...m.entries()]; }, [amenities]);
  const body = () => ({ code: f.code.trim(), name: f.name.trim(), description: f.description.trim() || null, maxAdults: n(f.maxAdults), maxChildren: n(f.maxChildren) || 0, maxOccupancy: n(f.maxOccupancy), baseOccupancy: n(f.baseOccupancy), bedConfig: f.bedConfig.trim() || null, sizeSqm: f.sizeSqm ? n(f.sizeSqm) : null });
  const save = async () => {
    const out = await run(async () => {
      let id = rt?.id;
      if (rt) await api('PATCH', `${base}/room-types/${rt.id}`, { ...body(), version: rt.version }); else id = (await api<{ id: string }>('POST', `${base}/room-types`, body())).id;
      await api('PUT', `${base}/room-types/${id}/amenities`, { amenityIds: picked });
      return true;
    });
    if (out) onDone();
  };
  const archive = async () => { if (rt && await run(() => api('PATCH', `${base}/room-types/${rt.id}`, { status: rt.status === 'ARCHIVED' ? 'ACTIVE' : 'ARCHIVED', version: rt.version }))) onDone(); };
  const addAmenity = async () => {
    const nameEn = newAm.trim(); const code = nameEn.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    const a = await am.run(() => api<Amenity>('POST', '/v1/amenities', { code, nameEn, category: 'GENERAL' }));
    if (a) { setNewAm(''); onAmenity(); setPicked((x) => [...x, a.id]); }
  };
  return (
    <SidePanel title={rt ? rt.name : t('ps.addType')} subtitle={t('ps.typeSub')} onClose={onClose}
      footer={<div className="actions"><button className="primary" disabled={busy || !valid} onClick={() => void save()}>{t('common.save')}</button>{rt && <button onClick={() => void archive()} disabled={busy}>{rt.status === 'ARCHIVED' ? t('ps.restore') : t('ps.archive')}</button>}<button onClick={onClose}>{t('common.cancel')}</button></div>}>
      <div className="grid2">
        <Field label={t('ps.typeName')} required>{(p) => <input {...p} data-autofocus value={f.name} onChange={(e) => set({ name: e.target.value, ...(rt || f.code ? {} : { code: codeFrom(e.target.value).slice(0, 4) }) })} />}</Field>
        <Field label={t('ps.typeCode')} required hint={t('ps.typeCodeHint')}>{(p) => <input {...p} dir="ltr" value={f.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} />}</Field>
      </div>
      <Field label={t('ps.desc')} hint={t('ps.descHint')}>{(p) => <textarea {...p} value={f.description} maxLength={2000} onChange={(e) => set({ description: e.target.value })} />}</Field>
      <div className="grid2">
        <Field label={t('ps.maxAdults')} required>{(p) => <input {...p} inputMode="numeric" dir="ltr" value={f.maxAdults} onChange={(e) => set({ maxAdults: e.target.value })} />}</Field>
        <Field label={t('ps.maxChildren')}>{(p) => <input {...p} inputMode="numeric" dir="ltr" value={f.maxChildren} onChange={(e) => set({ maxChildren: e.target.value })} />}</Field>
        <Field label={t('ps.maxOcc')} required>{(p) => <input {...p} inputMode="numeric" dir="ltr" value={f.maxOccupancy} onChange={(e) => set({ maxOccupancy: e.target.value })} />}</Field>
        <Field label={t('ps.baseOcc')} required hint={t('ps.baseOccHint')} error={n(f.baseOccupancy) > n(f.maxOccupancy) ? t('ps.baseOccErr') : undefined}>{(p) => <input {...p} inputMode="numeric" dir="ltr" value={f.baseOccupancy} onChange={(e) => set({ baseOccupancy: e.target.value })} />}</Field>
        <Field label={t('ps.bed')}>{(p) => <input {...p} value={f.bedConfig} placeholder={t('ps.bedEx')} onChange={(e) => set({ bedConfig: e.target.value })} />}</Field>
        <Field label={t('ps.size')}>{(p) => <input {...p} inputMode="decimal" dir="ltr" value={f.sizeSqm} onChange={(e) => set({ sizeSqm: e.target.value })} />}</Field>
      </div>
      <fieldset className="guestcard"><legend>{t('ps.amenities')}</legend>
        {groups.length === 0 && <p className="muted small">{t('ps.noAmenities')}</p>}
        {groups.map(([cat, list]) => (<div key={cat}><p className="muted small">{cat}</p><div className="chips">{list.map((a) => <label key={a.id} className="check"><input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, a.id] : x.filter((y) => y !== a.id)))} /> {locale === 'ur' && a.nameUr ? a.nameUr : a.nameEn}</label>)}</div></div>))}
        <div className="row"><Field label={t('ps.newAmenity')}>{(p) => <input {...p} value={newAm} onChange={(e) => setNewAm(e.target.value)} placeholder={t('ps.newAmenityEx')} />}</Field><button disabled={am.busy || newAm.trim().length < 2} onClick={() => void addAmenity()}>{t('ps.addAmenity')}</button></div>
        <ErrorLine code={am.problem?.code} detail={am.problem?.detail} />
      </fieldset>
      {rt ? <RoomMedia base={`${base}/room-types/${rt.id}/media`} /> : <p className="muted small">{t('ps.mediaAfterSave')}</p>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </SidePanel>
  );
}

interface Media { id: string; kind: 'IMAGE' | 'VIDEO'; url: string; caption: string | null }
/** The pictures and videos guests see in their booking confirmation. Changes apply at once (no Save needed). */
function RoomMedia({ base }: { base: string }) {
  const { t } = useT();
  const list = useLive<{ items: Media[] }>(base, 600_000);
  const { busy, problem, run } = useAction();
  const items = list.data?.items ?? []; const pick = useRef<HTMLInputElement>(null);
  const upload = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) { const fd = new FormData(); fd.append('file', file); if (!(await run(() => api('POST', base, fd)))) break; }
    list.reload();
  };
  const act = async (fn: () => Promise<unknown>) => { if (await run(fn)) list.reload(); };
  return (
    <fieldset className="guestcard"><legend>{t('ps.media')}</legend>
      <p className="muted small">{t('ps.mediaHint')}</p>
      {items.length === 0 && !list.loading && <p className="muted small">{t('ps.mediaNone')}</p>}
      <div className="media-grid">
        {items.map((m, i) => (
          <figure key={m.id} className="media-tile">
            {m.kind === 'IMAGE' ? <img src={m.url} alt={m.caption ?? ''} loading="lazy" /> : <video src={m.url} controls preload="metadata" />}
            {i === 0 && <StatusBadge tone="info" icon="check">{t('ps.cover')}</StatusBadge>}
            <figcaption>
              <input aria-label={t('ps.caption')} placeholder={t('ps.caption')} defaultValue={m.caption ?? ''} maxLength={160} onBlur={(e) => { if (e.target.value !== (m.caption ?? '')) void act(() => api('PATCH', `${base}/${m.id}`, { caption: e.target.value })); }} />
              <span className="row">
                {i > 0 && <button onClick={() => void act(() => api('PATCH', `${base}/${m.id}`, { makeFirst: true }))} disabled={busy}>{t('ps.makeCover')}</button>}
                <button onClick={() => void act(() => api('DELETE', `${base}/${m.id}`))} disabled={busy}>{t('ps.removeMedia')}</button>
              </span>
            </figcaption>
          </figure>
        ))}
      </div>
      <input ref={pick} type="file" hidden accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" multiple onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
      <button type="button" disabled={busy} onClick={() => pick.current?.click()}>{busy ? t('ps.uploading') : t('ps.addMedia')}</button>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </fieldset>
  );
}

function BulkRooms({ base, types, floors, onClose, onDone }: { base: string; types: RoomType[]; floors: Floor[]; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const [f, setF] = useState({ roomTypeId: types[0]?.id ?? '', floorId: '', from: '', to: '', prefix: '', accessible: false, smoking: false }); const { busy, problem, run } = useAction(); const [made, setMade] = useState<number | null>(null);
  const from = Number(f.from), to = Number(f.to);
  const count = Number.isInteger(from) && Number.isInteger(to) && f.from !== '' && f.to !== '' && to >= from ? to - from + 1 : 0;
  const valid = !!f.roomTypeId && count > 0 && count <= 200;
  const go = async () => {
    const r = await run(() => api<{ created?: number; rooms?: unknown[] }>('POST', `${base}/rooms/bulk`, { roomTypeId: f.roomTypeId, floorId: f.floorId || null, from, to, prefix: f.prefix, accessible: f.accessible, smoking: f.smoking }));
    if (r) setMade(count);
  };
  return (
    <SidePanel title={t('ps.addRooms')} subtitle={t('ps.bulkSub')} onClose={made === null ? onClose : onDone}
      footer={made !== null ? <div className="actions"><button className="primary" onClick={onDone}>{t('common.close')}</button></div> : <div className="actions"><button className="primary" disabled={busy || !valid} onClick={() => void go()}>{t('ps.createRooms', { n: count })}</button><button onClick={onClose}>{t('common.cancel')}</button></div>}>
      {made !== null ? <ConfirmCard title={t('ps.roomsMade', { n: made })}>{t('ps.roomsMadeText')}</ConfirmCard> : (<>
        <Field label={t('ps.roomType')} required>{(p) => <select {...p} value={f.roomTypeId} onChange={(e) => setF({ ...f, roomTypeId: e.target.value })}>{types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}</Field>
        <Field label={t('ps.floor')}>{(p) => <select {...p} value={f.floorId} onChange={(e) => setF({ ...f, floorId: e.target.value })}><option value="">{t('rm.noFloor')}</option>{floors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}</Field>
        <div className="grid2">
          <Field label={t('ps.from')} required>{(p) => <input {...p} inputMode="numeric" dir="ltr" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} placeholder="101" />}</Field>
          <Field label={t('ps.to')} required>{(p) => <input {...p} inputMode="numeric" dir="ltr" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="108" />}</Field>
        </div>
        <Field label={t('ps.prefix')} hint={t('ps.prefixHint')}>{(p) => <input {...p} dir="ltr" maxLength={4} value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value })} />}</Field>
        <label className="check"><input type="checkbox" checked={f.accessible} onChange={(e) => setF({ ...f, accessible: e.target.checked })} /> {t('rm.accessible')}</label>
        <label className="check"><input type="checkbox" checked={f.smoking} onChange={(e) => setF({ ...f, smoking: e.target.checked })} /> {t('rm.smoking')}</label>
        {count > 0 && <p className="muted" role="status">{t('ps.willCreate', { n: count, first: `${f.prefix}${from}`, last: `${f.prefix}${to}` })}</p>}
        <ErrorLine code={problem?.code} detail={problem?.detail} />
      </>)}
    </SidePanel>
  );
}
