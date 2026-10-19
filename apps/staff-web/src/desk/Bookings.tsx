import { useState } from 'react';
import { useT } from '../i18n/index.js';
import { useAuth, useLive } from '../state.js';
import { Empty, Spinner } from '../ui/kit.js';
import { NewBooking } from './NewBooking.js';
import { navigate } from '../shell/router.js';
import { ReservationRow } from './ReservationRow.js';
import type { ListItem } from './types.js';
import { WalkIn } from './WalkIn.js';

/** Find any booking by confirmation number, guest name, phone or OTA reference; start a new booking or a walk-in. */
export function Bookings() {
  const { t } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const [q, setQ] = useState(''); const [dlg, setDlg] = useState<'new' | 'walkin' | null>(null);
  const search = q.trim().length >= 2;
  const list = useLive<{ items: ListItem[]; date: string }>(`${base}/reservations?${search ? `q=${encodeURIComponent(q.trim())}` : 'arrivalFrom=' + property!.businessDate}&limit=50`, 30_000);
  const bd = property!.businessDate;
  return (
    <section>
      <div className="row between"><h2>{t('nav.bookings')}</h2><div className="row">
        {can('frontdesk.check_in') && can('reservation.create') && <button className="small" onClick={() => setDlg('walkin')}>{t('wi.title')}</button>}
        {can('reservation.create') && <button className="primary small" onClick={() => setDlg('new')}>{t('bk.new')}</button>}</div></div>
      <input type="search" className="searchbox" placeholder={t('d.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('d.search')} />
      <p className="muted small">{search ? t('bk.results') : t('bk.upcoming')}</p>
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('d.nothing')} /> : <ul className="plain rows">{list.data.items.map((i) => <ReservationRow key={i.lineId} i={i} onOpen={() => navigate(`/reservations/${i.reservationId}`)} />)}</ul>}
      {dlg === 'new' && <NewBooking initial={{ arrival: bd }} businessDate={bd} onClose={() => { setDlg(null); list.reload(); }} onOpenReservation={(id) => { setDlg(null); navigate(`/reservations/${id}`); }} />}
      {dlg === 'walkin' && <WalkIn businessDate={bd} onClose={() => { setDlg(null); list.reload(); }} onOpenReservation={(id) => { setDlg(null); navigate(`/reservations/${id}`); }} />}
    </section>
  );
}
