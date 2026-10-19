import { lazy, useMemo } from 'react';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { money, shortDate } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Banner, LevelBadge, ResStatus, Skeleton, type Level } from '../ui/ds.js';
import { Icon } from '../ui/icons.js';
import { useInbox } from '../shell/context.js';
import { Link, useRoute, useSetQuery } from '../shell/router.js';
import { personaOf } from '../shell/sections.js';
import { Chip, Empty } from '../ui/kit.js';
import type { Amount, ListItem } from '../desk/types.js';

const MyRooms = lazy(() => import('../screens/MyRooms.js').then((m) => ({ default: m.MyRooms })));
const Gate = lazy(() => import('../desk/Gate.js').then((m) => ({ default: m.Gate })));
const Maintenance = lazy(() => import('../desk/Maintenance.js').then((m) => ({ default: m.Maintenance })));

export interface Blocker { code: string; level: Level; amount?: Amount }
interface Arrival { reservationId: string; lineId: string; confirmationNo: string; status: string; guest: { name: string; vip: boolean }; roomType: { code: string; name: string }; adults: number; children: number; room: { id: string; number: string; hkStatus: string } | null; specialRequests: string | null; blockers: Blocker[]; nights: number }
interface Departure { reservationId: string; lineId: string; confirmationNo: string; status: string; guest: { name: string; vip: boolean }; roomType: { code: string }; room: string | null; departure: string; balance: Amount; blockers: Blocker[] }
interface TodayData { businessDate: string; summary: { arrivalsPending: number; arrivalsDone: number; departuresPending: number; departuresDone: number; inHouse: number; noShowCandidates: number; arrivalsWithProblems: number; departuresWithProblems: number }; arrivals: Arrival[]; departures: Departure[] }

const RANK: Record<Level, number> = { BLOCKER: 0, ACTION: 1, INFO: 2 };
const worst = (b: Blocker[]) => b.reduce((m, x) => Math.min(m, RANK[x.level]), 3);

/** What the person at the desk should do next, in words, for the row's call to action. */
function BlockerBadges({ blockers }: { blockers: Blocker[] }) {
  const { t } = useT();
  return <>{blockers.map((b) => <LevelBadge key={b.code} level={b.level}>{b.code === 'BALANCE_DUE' || b.code === 'OVERPAID' ? t(`bl.${b.code}` as Key, { amount: b.amount ? money(b.amount) : '' }) : t(`bl.${b.code}` as Key)}</LevelBadge>)}</>;
}

function QueueRow({ to, name, vip, sub, status, blockers, next, done }: { to: string; name: string; vip: boolean; sub: string; status: string; blockers: Blocker[]; next: string; done: boolean }) {
  const { t } = useT();
  return (
    <li>
      <Link to={to} className={`qrow${done ? ' done' : ''}`}>
        <span className="q-main"><strong>{name}{vip && <span className="vip" aria-label={t('q.vip')}> ★</span>}</strong><span className="muted small">{sub}</span></span>
        <span className="q-badges"><ResStatus status={status} /><BlockerBadges blockers={blockers} /></span>
        <span className="q-next">{!done && <span>{next}</span>}<Icon name="chevron" size={18} /></span>
      </Link>
    </li>
  );
}

function DeskToday() {
  const { t, locale } = useT();
  const { property, can } = useAuth();
  const route = useRoute(); const setQuery = useSetQuery();
  const base = `/v1/properties/${property!.id}`;
  const today = useLive<TodayData>(`${base}/today`, 20_000, `today-${property!.id}`);
  const inbox = useInbox();
  const view = (['arrivals', 'departures', 'inhouse'] as const).find((v) => v === route.query.get('view')) ?? 'arrivals';
  const inhouse = useLive<{ items: ListItem[] }>(view === 'inhouse' ? `${base}/reservations?view=in-house&limit=100` : null, 20_000);
  const q = route.query.get('q') ?? '';
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

  return (
    <section aria-labelledby="h-today">
      <div className="page-head"><h1 id="h-today">{t('nav.today')}</h1>{d && <span className="muted">{t('today.queueFor', { date: shortDate(d.businessDate, locale) })}</span>}</div>
      {stale && <Banner level="ACTION" title={t('state.staleTitle')}>{t('state.staleText')}</Banner>}
      {today.error && !d && <Banner level="BLOCKER" title={t('state.errorTitle')} action={<button onClick={today.reload}>{t('common.retry')}</button>}>{t(`err.${today.error.code}` as Key) === `err.${today.error.code}` ? t('err.generic') : t(`err.${today.error.code}` as Key)}</Banner>}
      {inbox.data && inbox.data.summary.blockers > 0 && can('management.view') && <Banner level="BLOCKER" title={t('today.mgrBlockers', { n: inbox.data.summary.blockers })} action={<Link className="button" to="/inbox">{t('shell.openInbox')}</Link>} />}
      {!d ? <Skeleton rows={5} /> : (<>
        <div className="kpis" role="group" aria-label={t('today.summary')}>
          <button className={`kpi${view === 'arrivals' ? ' on' : ''}`} aria-pressed={view === 'arrivals'} onClick={() => setQuery({ view: 'arrivals' })}><strong>{s!.arrivalsPending}</strong><span>{t('today.toArrive')}</span>{s!.arrivalsWithProblems > 0 && <span className="kpi-flag"><Icon name="alert" size={14} />{t('today.withProblems', { n: s!.arrivalsWithProblems })}</span>}</button>
          <button className={`kpi${view === 'departures' ? ' on' : ''}`} aria-pressed={view === 'departures'} onClick={() => setQuery({ view: 'departures' })}><strong>{s!.departuresPending}</strong><span>{t('today.toLeave')}</span>{s!.departuresWithProblems > 0 && <span className="kpi-flag"><Icon name="alert" size={14} />{t('today.withProblems', { n: s!.departuresWithProblems })}</span>}</button>
          <button className={`kpi${view === 'inhouse' ? ' on' : ''}`} aria-pressed={view === 'inhouse'} onClick={() => setQuery({ view: 'inhouse' })}><strong>{s!.inHouse}</strong><span>{t('today.inHouse')}</span></button>
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
        {view === 'arrivals' && (arrivals.length === 0 ? <Empty text={q ? t('d.nothing') : t('today.noArrivals')} /> : (
          <ul className="plain queue" aria-label={t('today.v.arrivals')}>{arrivals.map((a) => (
            <QueueRow key={a.lineId} to={`/reservations/${a.reservationId}`} name={a.guest.name} vip={a.guest.vip} done={a.status === 'CHECKED_IN'} status={a.status} blockers={a.blockers} next={nextFor(a)}
              sub={`${a.confirmationNo} · ${a.roomType.name} · ${a.room ? `${t('d.room')} ${a.room.number}` : t('d.noRoom')} · ${t('d.nights', { n: a.nights })}`} />))}</ul>))}
        {view === 'departures' && (departures.length === 0 ? <Empty text={q ? t('d.nothing') : t('today.noDepartures')} /> : (
          <ul className="plain queue" aria-label={t('today.v.departures')}>{departures.map((x) => (
            <QueueRow key={x.lineId} to={`/reservations/${x.reservationId}${x.status === 'CHECKED_IN' ? '/check-out' : ''}`} name={x.guest.name} vip={x.guest.vip} done={x.status === 'CHECKED_OUT'} status={x.status} blockers={x.blockers} next={nextOut(x)}
              sub={`${x.confirmationNo} · ${x.room ? `${t('d.room')} ${x.room}` : t('d.noRoom')} · ${t('today.leaves', { date: shortDate(x.departure, locale) })}`} />))}</ul>))}
        {view === 'inhouse' && (!inhouse.data ? <Skeleton rows={3} /> : (() => {
          const rows = inhouse.data.items.filter((i) => !q || `${i.guest.fullName} ${i.confirmationNo} ${i.assignedRoom ?? ''}`.toLowerCase().includes(q.toLowerCase()));
          return rows.length === 0 ? <Empty text={t('d.nothing')} /> : (
            <ul className="plain queue" aria-label={t('today.v.in-house')}>{rows.map((i) => (
              <QueueRow key={i.lineId} to={`/reservations/${i.reservationId}`} name={i.guest.fullName} vip={i.guest.vip} done={false} status={i.status} blockers={[]} next={t('q.open')}
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
