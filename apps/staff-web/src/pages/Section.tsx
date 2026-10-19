import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { api } from '../api/client.js';
import { useAction } from '../lib/action.js';
import { useAuth, useLive } from '../state.js';
import type { ListItem, RackData, RackRoom } from '../desk/types.js';
import { Banner, ResStatus, RoomState, Skeleton, StatusBadge, Tabs } from '../ui/ds.js';
import { Icon } from '../ui/icons.js';
import { Chip, Empty, ErrorLine } from '../ui/kit.js';
import { Link, useRoute, useSetQuery } from '../shell/router.js';
import type { Section } from '../shell/sections.js';

/** A section is a heading and, where it holds several screens, a row of tabs. The tab and its filters live in the address, so reload and Back come back to the same place. */
export function SectionPage({ section, missing }: { section: Section; missing?: boolean }) {
  const { t } = useT();
  const { can } = useAuth();
  const route = useRoute(); const setQuery = useSetQuery();
  const tabs = (section.tabs ?? []).filter((x) => x.show(can));
  const wanted = route.query.get('tab');
  const active = tabs.find((x) => x.id === wanted) ?? tabs[0];
  if (missing) return <Banner level="INFO" title={t('state.notFoundTitle')} action={<Link className="button" to="/today">{t('ws.backToday')}</Link>}>{t('state.notFoundText')}</Banner>;
  if (!section.show(can) || !active) return <Banner level="INFO" title={t('perm.sectionTitle', { name: t(section.label) })} action={<Link className="button" to="/today">{t('ws.backToday')}</Link>}>{t('perm.sectionText')}</Banner>;
  const Page = active.Page;
  return (
    <section aria-labelledby="h-section">
      <div className="page-head"><h1 id="h-section">{t(section.label)}</h1></div>
      {tabs.length > 1 && <Tabs label={t(section.label)} value={active.id} onChange={(id) => setQuery({ tab: id === tabs[0]!.id ? null : id })} tabs={tabs.map((x) => ({ id: x.id, label: t(x.label) }))} />}
      <div role="tabpanel" id={`panel-${active.id}`} aria-labelledby={`tab-${active.id}`} className="legacy"><Page key={active.id} /></div>
    </section>
  );
}

interface GuestHit { id: string; fullName: string; phone: string | null; email: string | null; vip: boolean; nationality: string | null }
function GuestStays({ name }: { name: string }) {
  const { t, locale } = useT();
  const { property } = useAuth();
  const stays = useLive<{ items: ListItem[] }>(`/v1/properties/${property!.id}/reservations?q=${encodeURIComponent(name)}&limit=10`, 60_000);
  if (!stays.data) return <Skeleton rows={2} />;
  if (!stays.data.items.length) return <p className="muted small">{t('guests.noStays')}</p>;
  return <ul className="plain">{stays.data.items.filter((i) => i.guest.fullName === name).map((i) => (
    <li key={i.lineId}><Link to={`/reservations/${i.reservationId}`} className="qrow slim"><span className="q-main"><strong>{i.confirmationNo}</strong><span className="muted small">{new Date(`${i.arrival}T00:00:00Z`).toLocaleDateString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })} → {i.departure} · {i.roomType?.code}</span></span><span className="q-badges"><ResStatus status={i.status} /></span><span className="q-next"><Icon name="chevron" size={18} /></span></Link></li>))}</ul>;
}

/** Find a guest by name, phone or email, and see their stays. */
export function Guests() {
  const { t } = useT();
  const route = useRoute(); const setQuery = useSetQuery();
  const q = route.query.get('q') ?? ''; const [open, setOpen] = useState<string | null>(null);
  const [d, setD] = useState(q);
  useEffect(() => { const id = setTimeout(() => setQuery({ q: d.trim() || null }), 300); return () => clearTimeout(id); }, [d, setQuery]);
  const hits = useLive<{ items: GuestHit[] }>(q.length >= 2 ? `/v1/guests/search?q=${encodeURIComponent(q)}` : null, 3_600_000);
  return (
    <section aria-labelledby="h-guests">
      <div className="page-head"><h1 id="h-guests">{t('nav.guests')}</h1></div>
      <input type="search" value={d} onChange={(e) => setD(e.target.value)} className="filter wide" placeholder={t('guests.search')} aria-label={t('guests.search')} />
      {q.length < 2 ? <Empty text={t('guests.hint')} /> : !hits.data ? <Skeleton rows={3} /> : hits.data.items.length === 0 ? <Empty text={t('d.nothing')} /> : (
        <ul className="plain queue" aria-label={t('nav.guests')}>{hits.data.items.map((g) => (
          <li key={g.id}>
            <button className="qrow" aria-expanded={open === g.id} onClick={() => setOpen(open === g.id ? null : g.id)}>
              <span className="q-main"><strong>{g.fullName}{g.vip && <span className="vip"> ★</span>}</strong><span className="muted small" dir="ltr">{[g.phone, g.email, g.nationality].filter(Boolean).join(' · ')}</span></span>
              <span className="q-next"><Icon name="chevronDown" size={18} /></span>
            </button>
            {open === g.id && <div className="qdetail"><GuestStays name={g.fullName} /></div>}
          </li>))}</ul>)}
    </section>
  );
}

type RoomFilter = 'all' | 'ready' | 'dirty' | 'occupied' | 'blocked';
const roomFilter = (r: RackRoom, f: RoomFilter): boolean => f === 'all' || (f === 'ready' && r.readyToSell) || (f === 'dirty' && (r.hkStatus === 'DIRTY' || r.hkStatus === 'CLEANING')) || (f === 'occupied' && r.occupancy === 'OCCUPIED') || (f === 'blocked' && r.blocks.length > 0);

/** The house right now, room by room. A list rather than a grid so it reads the same on a phone. */
export function RoomsLive() {
  const { t } = useT();
  const { property, can } = useAuth();
  const route = useRoute(); const setQuery = useSetQuery();
  const ask = useAction(); const [asked, setAsked] = useState<Record<string, boolean>>({});
  const prioritise = async (roomId: string) => { if (await ask.run(() => api('POST', `/v1/properties/${property!.id}/housekeeping/rooms/${roomId}/prioritise`)) !== undefined) { setAsked((m) => ({ ...m, [roomId]: true })); rack.reload(); } };
  const rack = useLive<RackData>(`/v1/properties/${property!.id}/rack?days=1`, 20_000, `rack1-${property!.id}`);
  const f = (['ready', 'dirty', 'occupied', 'blocked'] as const).find((x) => x === route.query.get('f')) ?? 'all';
  const floors = useMemo(() => {
    const m = new Map<string, RackRoom[]>();
    for (const r of (rack.data?.rooms ?? []).filter((x) => roomFilter(x, f))) { const k = r.floor ?? ''; m.set(k, [...(m.get(k) ?? []), r]); }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  }, [rack.data, f]);
  const s = rack.data?.summary.rooms;
  return (
    <section aria-labelledby="h-rooms">
      <div className="page-head"><h1 id="h-rooms">{t('nav.rooms2')}</h1></div>
      <ErrorLine code={ask.problem?.code} detail={ask.problem?.detail} />
      {rack.offline && <Banner level="ACTION" title={t('state.staleTitle')}>{t('state.staleText')}</Banner>}
      {s && <p className="muted" role="status">{t('rooms.summary', { occupied: s.occupied, clean: s.vacantClean, dirty: s.vacantDirty, out: s.outOfOrder + s.outOfService })}</p>}
      <div className="chips" role="group" aria-label={t('inbox.filter')}>{(['all', 'ready', 'dirty', 'occupied', 'blocked'] as const).map((x) => <Chip key={x} active={f === x} onClick={() => setQuery({ f: x === 'all' ? null : x })}>{t(`rooms.f.${x}` as Key)}</Chip>)}</div>
      {!rack.data ? <Skeleton rows={5} /> : floors.length === 0 ? <Empty text={t('d.nothing')} /> : floors.map(([floor, rooms]) => (
        <section key={floor} aria-label={floor || t('rm.noFloor')}><h2 className="floor">{floor || t('rm.noFloor')}</h2>
          <ul className="plain queue">{rooms.map((r) => {
            const stay = r.stays.find((x) => x.status === 'CHECKED_IN') ?? r.stays.find((x) => x.status === 'CONFIRMED');
            const inner = (<>
              <span className="room-chip" aria-hidden="true">{r.number}</span>
              <span className="q-main"><strong>{t('d.room')} {r.number}</strong><span className="muted small">{stay ? `${stay.guestName} · ${stay.confirmationNo}` : t(`occ.${r.occupancy}` as Key)}</span></span>
              <span className="q-badges"><RoomState hk={r.hkStatus} />{r.blocks.length > 0 && <StatusBadge tone="danger" icon="stop">{t('bl.ROOM_OUT_OF_SERVICE')}</StatusBadge>}{r.arrivingToday && <StatusBadge tone="info" icon="clock">{t('rooms.arriving')}</StatusBadge>}{r.dueOutToday && <StatusBadge tone="neutral" icon="clock">{t('rooms.dueOut')}</StatusBadge>}</span>
            </>);
            const dirty = r.hkStatus === 'DIRTY' || r.hkStatus === 'CLEANING';
            return (
              <li key={r.id} className="rowwrap">
                {stay ? <Link to={`/reservations/${stay.reservationId}`} className="qrow">{inner}<span className="q-next"><Icon name="chevron" size={18} /></span></Link> : <div className="qrow static">{inner}</div>}
                {dirty && can('frontdesk.check_in') && (asked[r.id] ? <StatusBadge tone="ok" icon="check">{t('ci.asked')}</StatusBadge> : <button disabled={ask.busy} onClick={() => void prioritise(r.id)}>{t('ci.prioritise')}</button>)}
              </li>);
          })}</ul></section>))}
    </section>
  );
}
