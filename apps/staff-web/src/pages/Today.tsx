import { lazy, useMemo } from 'react';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { money, shortDate } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Banner, LevelBadge, ResStatus, Skeleton, type Level } from '../ui/ds.js';
import { Icon } from '../ui/icons.js';
import { useInbox } from '../shell/context.js';
import { Link, useRoute, useSetQuery } from '../shell/router.js';
import { inboxTarget } from './Inbox.js';
import { personaOf } from '../shell/sections.js';
import { Chip, Empty } from '../ui/kit.js';
import type { Amount, ListItem } from '../desk/types.js';

const MyRooms = lazy(() => import('../screens/MyRooms.js').then((m) => ({ default: m.MyRooms })));
const Gate = lazy(() => import('../desk/Gate.js').then((m) => ({ default: m.Gate })));
const Maintenance = lazy(() => import('../desk/Maintenance.js').then((m) => ({ default: m.Maintenance })));

export interface Blocker { code: string; level: Level; amount?: Amount }
interface Arrival { expectedArrival: string | null; reservationId: string; lineId: string; confirmationNo: string; status: string; guest: { name: string; vip: boolean }; roomType: { code: string; name: string }; adults: number; children: number; room: { id: string; number: string; hkStatus: string } | null; specialRequests: string | null; blockers: Blocker[]; nights: number }
interface Departure { reservationId: string; lineId: string; confirmationNo: string; status: string; guest: { name: string; vip: boolean }; roomType: { code: string }; room: string | null; departure: string; balance: Amount; blockers: Blocker[] }
interface TodayData { businessDate: string; summary: { arrivalsPending: number; arrivalsDone: number; departuresPending: number; departuresDone: number; inHouse: number; noShowCandidates: number; arrivalsWithProblems: number; departuresWithProblems: number }; arrivals: Arrival[]; departures: Departure[] }

const RANK: Record<Level, number> = { BLOCKER: 0, ACTION: 1, INFO: 2 };
const worst = (b: Blocker[]) => b.reduce((m, x) => Math.min(m, RANK[x.level]), 3);

/** What the person at the desk should do next, in words, for the row's call to action. */
function BlockerBadges({ blockers }: { blockers: Blocker[] }) {
  const { t } = useT();
  return <>{blockers.map((b) => <LevelBadge key={b.code} level={b.level}>{b.code === 'BALANCE_DUE' || b.code === 'OVERPAID' ? t(`bl.${b.code}` as Key, { amount: b.amount ? money(b.amount) : '' }) : t(`bl.${b.code}` as Key)}</LevelBadge>)}</>;
}

/** Arrivals by the hour they expect to come (earliest first); guests who gave no time come last. */
function hourGroups(rows: Arrival[]): Array<[string, Arrival[]]> {
  const by = new Map<string, Arrival[]>();
  for (const a of [...rows].sort((x, y) => (x.expectedArrival ?? '99:99').localeCompare(y.expectedArrival ?? '99:99') || x.guest.name.localeCompare(y.guest.name))) {
    const h = a.expectedArrival ? a.expectedArrival.slice(0, 2) : ''; by.set(h, [...(by.get(h) ?? []), a]);
  }
  return [...by.entries()];
}
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
function QueueRow({ to, name, vip, sub, status, blockers, next, done, room }: { to: string; name: string; vip: boolean; sub: string; status: string; blockers: Blocker[]; next: string; done: boolean; room?: string | null }) {
  const { t } = useT();
  return (
    <li>
      <Link to={to} className={`qrow${done ? ' done' : ''}`}>
        <span className={`avatar${vip ? ' vip-av' : ''}`} aria-hidden="true">{initials(name) || '·'}</span>
        <span className="q-main"><strong>{name}{vip && <span className="vip" aria-label={t('q.vip')}> ★</span>}</strong><span className="muted small">{sub}</span></span>
        <span className="q-badges"><ResStatus status={status} /><BlockerBadges blockers={blockers} /></span>
        {room && <span className="room-pill" aria-hidden="true">{room}</span>}
        <span className="q-next">{!done && <span>{next}</span>}<Icon name="chevron" size={18} /></span>
      </Link>
    </li>
  );
}

/** Rows that need a person first, then the ones that are simply ready, then what is already done: so the top of the list is always the next thing to do. */
function Grouped<T>({ rows, group, render }: { rows: T[]; group: (r: T) => 'attention' | 'ready' | 'done'; render: (r: T) => React.ReactNode }) {
  const { t } = useT();
  const parts = (['attention', 'ready', 'done'] as const).map((g) => ({ g, items: rows.filter((r) => group(r) === g) })).filter((x) => x.items.length > 0);
  return <>{parts.map(({ g, items }) => (
    <div key={g} className="qgroup">
      {parts.length > 1 && <h3 className={`qgroup-h ${g}`}>{t(`today.g.${g}` as Key)} <span className="qgroup-n">{items.length}</span></h3>}
      <ul className="plain queue">{items.map(render)}</ul>
    </div>))}</>;
}

const MANAGER_KINDS = new Set(['PAYMENT_TO_VERIFY', 'COMPLIANCE_TASKS', 'CHARGE_REVIEWS', 'WORK_ORDER_URGENT', 'NO_SHOW_CANDIDATES', 'GUEST_FLAGGED']);
/** What only a manager can decide today, pulled out of the inbox so it sits above the desk queue. */
function ManagerQueue() {
  const { t } = useT();
  const inbox = useInbox();
  const items = (inbox.data?.items ?? []).filter((i) => MANAGER_KINDS.has(i.kind) && i.level !== 'INFO').slice(0, 6);
  if (!items.length) return null;
  return (
    <section className="block" aria-labelledby="h-mgr"><h2 id="h-mgr">{t('today.mgrQueue')}</h2>
      <ul className="plain queue">{items.map((i) => (
        <li key={i.id}><Link to={inboxTarget(i)} className="qrow slim"><span className="q-main"><strong>{t(`ib.${i.kind}` as Key, { guest: i.guest ?? '', room: i.roomNumber ?? '', n: i.count ?? 0, title: i.title ?? '' })}</strong></span>
          <span className="q-badges"><LevelBadge level={i.level}>{t(`lvl.${i.level}` as Key)}</LevelBadge></span><span className="q-next"><Icon name="chevron" size={18} /></span></Link></li>))}</ul>
    </section>
  );
}

function StatCard({ on, onClick, icon, tone, n, label, done, total, flag }: { on: boolean; onClick: () => void; icon: 'key' | 'swap' | 'rooms'; tone: 'arrive' | 'leave' | 'stay'; n: number; label: string; done?: number; total?: number; flag?: number }) {
  const { t } = useT();
  const pct = total && total > 0 ? Math.round(((done ?? 0) / total) * 100) : null;
  return (
    <button className={`kpi stat-card tone-${tone}${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick}>
      <span className="stat-ico" aria-hidden="true"><Icon name={icon} size={20} /></span>
      <strong>{n}</strong><span className="stat-label">{label}</span>
      {pct !== null && <span className="stat-prog"><span className="bar-track" aria-hidden="true"><span className="bar-fill" style={{ inlineSize: `${pct}%` }} /></span><span className="small muted">{t('today.progress', { done: done ?? 0, total: total ?? 0 })}</span></span>}
      {!!flag && flag > 0 && <span className="kpi-flag"><Icon name="alert" size={14} /> {t('today.withProblems', { n: flag })}</span>}
    </button>
  );
}

function DeskToday() {
  const { t, locale } = useT();
  const { property, can, me } = useAuth(); const user = me!.user;
  const route = useRoute(); const setQuery = useSetQuery();
  const base = `/v1/properties/${property!.id}`;
  const today = useLive<TodayData>(`${base}/today`, 20_000, `today-${property!.id}`);
  const inbox = useInbox();
  const view = (['arrivals', 'departures', 'inhouse'] as const).find((v) => v === route.query.get('view')) ?? 'arrivals';
  const inhouse = useLive<{ items: ListItem[] }>(view === 'inhouse' ? `${base}/reservations?view=in-house&limit=100` : null, 20_000);
  const q = route.query.get('q') ?? '';
  const order = route.query.get('order') === 'time' ? 'time' : 'priority';
  const d = today.data; const s = d?.summary;

  const arrivals = useMemo(() => (d?.arrivals ?? []).filter((a) => !q || `${a.guest.name} ${a.confirmationNo} ${a.room?.number ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.status === 'CHECKED_IN' ? 1 : 0) - (b.status === 'CHECKED_IN' ? 1 : 0) || worst(a.blockers) - worst(b.blockers) || a.guest.name.localeCompare(b.guest.name)), [d, q]);
  const departures = useMemo(() => (d?.departures ?? []).filter((x) => !q || `${x.guest.name} ${x.confirmationNo} ${x.room ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.status === 'CHECKED_OUT' ? 1 : 0) - (b.status === 'CHECKED_OUT' ? 1 : 0) || worst(a.blockers) - worst(b.blockers) || a.guest.name.localeCompare(b.guest.name)), [d, q]);

  const nextFor = (a: Arrival): string => {
    const codes = a.blockers.map((b) => b.code);
    if (codes.includes('GUEST_FLAGGED')) return t('q.askManager');
    if (codes.includes('NO_ROOM') || codes.includes('ROOM_NOT_READY') || codes.includes('ROOM_OUT_OF_SERVICE')) return t('q.fixRoom');
    return can('frontdesk.check_in') ? t('q.checkIn') : t('q.open');
  };
  const nextOut = (x: Departure): string => (x.blockers.some((b) => b.code === 'BALANCE_DUE') ? t('q.settle') : can('frontdesk.check_out') ? t('q.checkOut') : t('q.open'));
  const stale = today.offline;
  const arrivalRow = (a: Arrival) => (
    
            <QueueRow key={a.lineId} to={`/reservations/${a.reservationId}`} name={a.guest.name} vip={a.guest.vip} done={a.status === 'CHECKED_IN'} status={a.status} blockers={a.blockers} next={nextFor(a)} room={a.room?.number}
      sub={`${a.expectedArrival ? `${t('eta.at', { time: a.expectedArrival })} · ` : ''}${a.confirmationNo} · ${a.roomType.name} · ${a.room ? `${t('d.room')} ${a.room.number}` : t('d.noRoom')} · ${t('d.nights', { n: a.nights })}`} />
  );

  return (
    <section aria-labelledby="h-today">
      <header className="today-hero">
        <div>
          <div className="today-date"><h1 id="h-today">{t('nav.today')}</h1>{d && <span> · {shortDate(d.businessDate, locale)}</span>}</div>
          <p className="today-hello">{t(`today.hello.${new Date().getHours() < 12 ? 'm' : new Date().getHours() < 18 ? 'a' : 'e'}` as Key, { name: user.fullName.split(' ')[0] ?? '' })}</p>
        </div>
        {(can('reservation.create') || can('frontdesk.check_in')) && (
          <div className="head-actions">
            {can('frontdesk.check_in') && can('reservation.create') && <Link className="button" to="/reservations?tab=bookings&new=walkin">{t('wi.title')}</Link>}
            {can('reservation.create') && <Link className="button primary" to="/reservations?tab=bookings&new=1">{t('bk.new')}</Link>}
          </div>)}
      </header>
      {stale && <Banner level="ACTION" title={t('state.staleTitle')}>{t('state.staleText')}</Banner>}
      {today.error && !d && <Banner level="BLOCKER" title={t('state.errorTitle')} action={<button onClick={today.reload}>{t('common.retry')}</button>}>{t(`err.${today.error.code}` as Key) === `err.${today.error.code}` ? t('err.generic') : t(`err.${today.error.code}` as Key)}</Banner>}
      {inbox.data && inbox.data.summary.blockers > 0 && can('management.view') && <Banner level="BLOCKER" title={t('today.mgrBlockers', { n: inbox.data.summary.blockers })} action={<Link className="button" to="/inbox">{t('shell.openInbox')}</Link>} />}
      {can('management.view') && <ManagerQueue />}
      {!d ? <Skeleton rows={5} /> : (<>
        <div className="kpis stat-cards" role="group" aria-label={t('today.summary')}>
          <StatCard on={view === 'arrivals'} onClick={() => setQuery({ view: 'arrivals' })} icon="key" tone="arrive" n={s!.arrivalsPending} label={t('today.toArrive')} done={s!.arrivalsDone} total={s!.arrivalsDone + s!.arrivalsPending} flag={s!.arrivalsWithProblems} />
          <StatCard on={view === 'departures'} onClick={() => setQuery({ view: 'departures' })} icon="swap" tone="leave" n={s!.departuresPending} label={t('today.toLeave')} done={s!.departuresDone} total={s!.departuresDone + s!.departuresPending} flag={s!.departuresWithProblems} />
          <StatCard on={view === 'inhouse'} onClick={() => setQuery({ view: 'inhouse' })} icon="rooms" tone="stay" n={s!.inHouse} label={t('today.inHouse')} />
          {s!.noShowCandidates > 0 && <Link to="/reservations?tab=bookings&view=arrivals" className="kpi static warn"><strong>{s!.noShowCandidates}</strong><span>{t('today.noShowsShort')}</span></Link>}
        </div>
        <div className="toolbar">
          <div className="chips" role="group" aria-label={t('today.show')}>
            <Chip active={view === 'arrivals'} onClick={() => setQuery({ view: 'arrivals' })}>{t('today.v.arrivals')}</Chip>
            <Chip active={view === 'departures'} onClick={() => setQuery({ view: 'departures' })}>{t('today.v.departures')}</Chip>
            <Chip active={view === 'inhouse'} onClick={() => setQuery({ view: 'inhouse' })}>{t('today.v.in-house')}</Chip>
          </div>
          <input type="search" value={q} onChange={(e) => setQuery({ q: e.target.value || null })} placeholder={t('today.filter')} aria-label={t('today.filter')} className="filter" />
        </div>
        {view === 'arrivals' && (arrivals.length === 0 ? <Empty text={q ? t('d.nothing') : t('today.noArrivals')} /> : (<>
          <div className="seg" role="group" aria-label={t('today.order')}>
            <button type="button" className={order === 'priority' ? 'on' : ''} aria-pressed={order === 'priority'} onClick={() => setQuery({ order: null })}>{t('today.order.priority')}</button>
            <button type="button" className={order === 'time' ? 'on' : ''} aria-pressed={order === 'time'} onClick={() => setQuery({ order: 'time' })}>{t('today.order.time')}</button>
          </div>
          {order === 'priority' ? (
            <Grouped rows={arrivals} group={(a) => (a.status === 'CHECKED_IN' ? 'done' : worst(a.blockers) < 2 ? 'attention' : 'ready')} render={arrivalRow} />
          ) : (
            <ol className="timeline-day" aria-label={t('today.order.time')}>{hourGroups(arrivals).map(([hour, rows]) => (
              <li key={hour} className="tl-slot"><span className="tl-hour">{hour === '' ? t('today.noTime') : `${hour}:00`}</span>
                <ul className="plain queue">{rows.map(arrivalRow)}</ul></li>))}</ol>
          )}
        </>))}
        {view === 'departures' && (departures.length === 0 ? <Empty text={q ? t('d.nothing') : t('today.noDepartures')} /> : (
          <Grouped rows={departures} group={(x) => (x.status === 'CHECKED_OUT' ? 'done' : worst(x.blockers) < 2 ? 'attention' : 'ready')} render={(x) => (
            <QueueRow key={x.lineId} to={`/reservations/${x.reservationId}${x.status === 'CHECKED_IN' ? '/check-out' : ''}`} name={x.guest.name} vip={x.guest.vip} done={x.status === 'CHECKED_OUT'} status={x.status} blockers={x.blockers} next={nextOut(x)} room={x.room}
              sub={`${x.confirmationNo} · ${x.room ? `${t('d.room')} ${x.room}` : t('d.noRoom')} · ${t('today.leaves', { date: shortDate(x.departure, locale) })}`} />)} />))}
        {view === 'inhouse' && (!inhouse.data ? <Skeleton rows={3} /> : (() => {
          const rows = inhouse.data.items.filter((i) => !q || `${i.guest.fullName} ${i.confirmationNo} ${i.assignedRoom ?? ''}`.toLowerCase().includes(q.toLowerCase()));
          return rows.length === 0 ? <Empty text={t('d.nothing')} /> : (
            <ul className="plain queue" aria-label={t('today.v.in-house')}>{rows.map((i) => (
              <QueueRow key={i.lineId} to={`/reservations/${i.reservationId}`} name={i.guest.fullName} vip={i.guest.vip} done={false} status={i.status} blockers={[]} next={t('q.open')} room={i.assignedRoom}
                sub={`${i.confirmationNo} · ${i.assignedRoom ? `${t('d.room')} ${i.assignedRoom}` : t('d.noRoom')} · ${t('today.leaves', { date: shortDate(i.departure, locale) })}`} />))}</ul>);
        })())}
        {(can('reservation.create') || can('frontdesk.check_in')) && <p className="muted small tip">{t('today.tip')}</p>}
      </>)}
    </section>
  );
}

/** Today is a different page for different people: a front-desk queue, a housekeeper's rooms, a technician's repairs. */
export function Today() {
  const { t } = useT();
  const { can } = useAuth();
  const persona = personaOf(can);
  if (can('reservation.view')) return <DeskToday />;
  if (can('housekeeping.update')) return <section><div className="page-head"><h1>{t('nav.today')}</h1></div><MyRooms /></section>;
  if (can('visitor.log') || can('arrivals.view_masked')) return <section><div className="page-head"><h1>{t('nav.today')}</h1></div><Gate /></section>;
  if (can('maintenance.view')) return <section><div className="page-head"><h1>{t('nav.today')}</h1></div><Maintenance /></section>;
  return (
    <section><div className="page-head"><h1>{t('nav.today')}</h1></div>
      <Banner level="INFO" title={t('today.nothingAssigned')} action={<Link className="button" to="/inbox">{t('shell.openInbox')}</Link>}>{t(`role.${persona}` as Key)}</Banner>
    </section>
  );
}
