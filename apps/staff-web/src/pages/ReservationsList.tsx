import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { money, shortDate } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { NewBooking } from '../desk/NewBooking.js';
import { WalkIn } from '../desk/WalkIn.js';
import type { ListItem } from '../desk/types.js';
import { ResStatus, Skeleton, StatusBadge } from '../ui/ds.js';
import { Icon } from '../ui/icons.js';
import { Chip, Empty } from '../ui/kit.js';
import { Link, navigate, useRoute, useSetQuery } from '../shell/router.js';

const VIEWS = ['upcoming', 'arrivals', 'inhouse', 'departures', 'atrisk', 'cancelled'] as const;
type View = (typeof VIEWS)[number];
const query = (v: View, bd: string): string => ({
  upcoming: `arrivalFrom=${bd}`, arrivals: 'view=arrivals', inhouse: 'view=in-house', departures: 'view=departures', atrisk: `atRisk=true&arrivalFrom=${bd}`, cancelled: 'status=CANCELLED',
} as Record<View, string>)[v];

/** Every booking, found by what staff actually know: a name, a phone number, a confirmation number, or the kind of day it is. The filter lives in the address. */
export function ReservationsList() {
  const { t, locale } = useT();
  const { property, can } = useAuth();
  const route = useRoute(); const setQuery = useSetQuery();
  const bd = property!.businessDate; const base = `/v1/properties/${property!.id}`;
  const view = VIEWS.find((v) => v === route.query.get('view')) ?? 'upcoming';
  const q = route.query.get('q') ?? '';
  const [dlg, setDlg] = useState<'new' | 'walkin' | null>(null);
  const searching = q.trim().length >= 2;
  const list = useLive<{ items: ListItem[]; nextCursor?: string | null }>(`${base}/reservations?${searching ? `q=${encodeURIComponent(q.trim())}` : query(view, bd)}&limit=100`, 30_000);
  const key = `${view}|${q.trim()}`;
  const [more, setMore] = useState<{ key: string; items: ListItem[]; cursor: string | null } | null>(null); const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => { setMore(null); }, [key]);
  const items = [...(list.data?.items ?? []), ...(more?.key === key ? more.items : [])];
  const cursor = more?.key === key ? more.cursor : list.data?.nextCursor ?? null;
  const loadMore = async () => {
    if (!cursor) return; setLoadingMore(true);
    try { const r = await api<{ items: ListItem[]; nextCursor?: string | null }>('GET', `${base}/reservations?${searching ? `q=${encodeURIComponent(q.trim())}` : query(view, bd)}&limit=100&cursor=${encodeURIComponent(cursor)}`); setMore({ key, items: [...(more?.key === key ? more.items : []), ...r.items], cursor: r.nextCursor ?? null }); }
    catch { /* the list stays as it was; the button stays so it can be tried again */ }
    finally { setLoadingMore(false); }
  };
  return (
    <section aria-labelledby="h-res">
      <div className="page-head"><h2 id="h-res">{t('nav.bookings')}</h2>
        <div className="head-actions">
          {can('frontdesk.check_in') && can('reservation.create') && <button onClick={() => setDlg('walkin')}>{t('wi.title')}</button>}
          {can('reservation.create') && <button className="primary" onClick={() => setDlg('new')}>{t('bk.new')}</button>}</div></div>
      <div className="toolbar">
        <div className="chips" role="group" aria-label={t('rl.show')}>{VIEWS.map((v) => <Chip key={v} active={view === v && !searching} onClick={() => setQuery({ view: v === 'upcoming' ? null : v, q: null })}>{t(`rl.v.${v}` as Key)}</Chip>)}</div>
        <input type="search" className="filter" value={q} onChange={(e) => setQuery({ q: e.target.value || null })} placeholder={t('d.searchPlaceholder')} aria-label={t('d.search')} />
      </div>
      <p className="muted small" role="status">{searching ? t('bk.results') : t(`rl.h.${view}` as Key)}{list.data ? ` · ${t('rl.count', { n: items.length })}` : ''}</p>
      {list.offline && <p className="warnbox small">{t('state.staleTitle')}</p>}
      {!list.data ? <Skeleton rows={5} /> : items.length === 0 ? <Empty text={t('d.nothing')} /> : (
        <ul className="plain queue" aria-label={t('nav.bookings')}>{items.map((i) => (
          <li key={i.lineId}>
            <Link to={`/reservations/${i.reservationId}`} className="qrow">
              <span className="q-main"><strong>{i.guest.fullName}{i.guest.vip && <span className="vip"> ★</span>}</strong>
                <span className="muted small">{i.confirmationNo} · {i.roomType?.code} · {shortDate(i.arrival, locale)} → {shortDate(i.departure, locale)} · {t('d.nights', { n: i.nights })} · {i.assignedRoom ? `${t('d.room')} ${i.assignedRoom}` : t('d.noRoom')}</span></span>
              <span className="q-badges"><ResStatus status={i.status} />
                {i.atRisk && (i.status === 'OPTION' || i.status === 'CONFIRMED') && <StatusBadge tone="warn" icon="alert">{t('rs.atRiskShort')}</StatusBadge>}
                {i.deposit.paid.amount !== '0.00' && <StatusBadge tone="neutral" icon="card">{t('fo.depositHeld')} {money(i.deposit.paid)}</StatusBadge>}</span>
              <span className="q-next"><Icon name="chevron" size={18} /></span>
            </Link>
          </li>))}</ul>)}
      {cursor && <p className="center"><button disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? t('common.loading') : t('rl.more')}</button></p>}
      {dlg === 'new' && <NewBooking initial={{ arrival: bd }} businessDate={bd} onClose={() => { setDlg(null); list.reload(); }} onOpenReservation={(id) => { setDlg(null); navigate(`/reservations/${id}`); }} />}
      {dlg === 'walkin' && <WalkIn businessDate={bd} onClose={() => { setDlg(null); list.reload(); }} onOpenReservation={(id) => { setDlg(null); navigate(`/reservations/${id}`); }} />}
    </section>
  );
}
