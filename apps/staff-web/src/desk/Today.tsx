import { useState } from 'react';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { money, shortDate } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, Spinner } from '../ui/kit.js';
import { ReservationSheet } from './ReservationSheet.js';
import { STATUS_TONE, type ListItem, type RackData } from './types.js';

type View = 'arrivals' | 'in-house' | 'departures';

export function ReservationRow({ i, onOpen }: { i: ListItem; onOpen: () => void }) {
  const { t, locale } = useT();
  return (
    <li>
      <button className="row-card" onClick={onOpen}>
        <span className="room-chip" aria-label={i.assignedRoom ? `${t('d.room')} ${i.assignedRoom}` : t('d.noRoom')}>{i.assignedRoom ?? '—'}</span>
        <span className="rc-main">
          <strong>{i.guest.fullName}{i.guest.vip ? ' ★' : ''}</strong>
          <span className="muted small">{i.confirmationNo} · {i.roomType?.code} · {shortDate(i.arrival, locale)} → {shortDate(i.departure, locale)} · {t('d.nights', { n: i.nights })} · {i.adults}{i.children ? `+${i.children}` : ''}</span>
        </span>
        <span className="rc-side">
          <Badge tone={STATUS_TONE[i.status] ?? 'neutral'}>{t(`rs.${i.status}` as Key)}</Badge>
          {i.atRisk && (i.status === 'OPTION' || i.status === 'CONFIRMED') && <Badge tone="warn">{t('rs.atRiskShort')}</Badge>}
          {i.deposit.paid.amount !== '0.00' && <span className="muted small">{t('fo.depositHeld')} {money(i.deposit.paid)}</span>}
        </span>
      </button>
    </li>
  );
}

/** The day's work at a glance: who is arriving, who is in the house, who is leaving. Tap anyone for the full stay, the bill and the actions. */
export function Today() {
  const { t } = useT();
  const { property } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const [view, setView] = useState<View>('arrivals'); const [q, setQ] = useState(''); const [open, setOpen] = useState<string | null>(null);
  const rack = useLive<RackData>(`${base}/rack?days=1`, 20_000, `rack1-${property!.id}`);
  const search = q.trim().length >= 2;
  const list = useLive<{ items: ListItem[] }>(`${base}/reservations?${search ? `q=${encodeURIComponent(q.trim())}` : `view=${view}`}&limit=100`, 20_000);
  const s = rack.data?.summary;
  const bd = rack.data?.businessDate ?? property!.businessDate;
  const refresh = () => { list.reload(); rack.reload(); };
  return (
    <section>
      <div className="row between"><h2>{t('nav.today')}</h2><span className="muted small">{t('property.businessDate')}: {bd}</span></div>
      {s && (
        <div className="stats">
          <button className={`stat${view === 'arrivals' && !search ? ' on' : ''}`} onClick={() => { setQ(''); setView('arrivals'); }}><strong>{s.arrivals.pending}</strong><span>{t('today.toArrive')}</span></button>
          <button className={`stat${view === 'in-house' && !search ? ' on' : ''}`} onClick={() => { setQ(''); setView('in-house'); }}><strong>{s.inHouse}</strong><span>{t('today.inHouse')}</span></button>
          <button className={`stat${view === 'departures' && !search ? ' on' : ''}`} onClick={() => { setQ(''); setView('departures'); }}><strong>{s.departures.pending}</strong><span>{t('today.toLeave')}</span></button>
          <div className="stat static"><strong>{s.rooms.vacantClean}</strong><span>{t('today.ready')}</span></div>
          <div className="stat static"><strong>{s.rooms.vacantDirty}</strong><span>{t('today.dirty')}</span></div>
        </div>
      )}
      {s && (s.overdueDepartures > 0 || s.noShowCandidates > 0 || s.atRisk > 0) && (
        <p className="warnbox small">{s.overdueDepartures > 0 && <>⚠ {t('today.overdue', { n: s.overdueDepartures })} </>}{s.noShowCandidates > 0 && <>⚠ {t('today.noShows', { n: s.noShowCandidates })} </>}{s.atRisk > 0 && <>⚠ {t('today.atRisk', { n: s.atRisk })}</>}</p>
      )}
      <input type="search" className="searchbox" placeholder={t('d.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('d.search')} />
      {!search && <div className="chips">{(['arrivals', 'in-house', 'departures'] as const).map((v) => <Chip key={v} active={view === v} onClick={() => setView(v)}>{t(`today.v.${v}` as Key)}</Chip>)}</div>}
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('d.nothing')} /> : <ul className="plain rows">{list.data.items.map((i) => <ReservationRow key={i.lineId} i={i} onOpen={() => setOpen(i.reservationId)} />)}</ul>}
      {open && <ReservationSheet reservationId={open} businessDate={bd} onChanged={refresh} onClose={() => { setOpen(null); refresh(); }} />}
    </section>
  );
}
