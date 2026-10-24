import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { money } from '../lib/format.js';
import { Banner, LevelBadge, Skeleton, type Level } from '../ui/ds.js';
import { Icon } from '../ui/icons.js';
import { Empty } from '../ui/kit.js';
import { useInbox, type InboxItem } from '../shell/context.js';
import { Link, useRoute, useSetQuery } from '../shell/router.js';

const TARGET: Record<string, string> = { NO_SHOW_CANDIDATES: '/reservations?tab=bookings', COMPLIANCE_TASKS: '/tasks?tab=compliance', CHARGE_REVIEWS: '/tasks?tab=compliance', PAYMENT_TO_VERIFY: '/reservations?tab=cashier', QUOTATION_ACCEPTED: '/reservations?tab=quotes', QUOTATION_DECLINED: '/reservations?tab=quotes', WORK_ORDER_MINE: '/tasks?tab=maintenance', WORK_ORDER_URGENT: '/tasks?tab=maintenance' };
export const inboxTarget = (i: InboxItem): string => (i.reservationId ? `/reservations/${i.reservationId}${i.kind === 'BALANCE_DUE' || i.kind === 'OVERDUE_DEPARTURE' ? '/check-out' : ''}` : TARGET[i.kind] ?? '/today');

/** The shared inbox: everything that is waiting on someone, drawn from the records themselves, so an item disappears the moment its cause is fixed. */
export function Inbox() {
  const { t } = useT();
  const inbox = useInbox(); const route = useRoute(); const setQuery = useSetQuery();
  const filter = (['BLOCKER', 'ACTION', 'INFO'] as const).find((l) => l === route.query.get('level')) ?? null;
  const d = inbox.data;
  const shown = (d?.items ?? []).filter((i) => !filter || i.level === filter);
  const count = (l: Level) => (d?.items ?? []).filter((i) => i.level === l).length;
  return (
    <section aria-labelledby="h-inbox">
      <div className="page-head"><h1 id="h-inbox">{t('nav.inbox')}</h1><button onClick={inbox.reload}>{t('common.refresh')}</button></div>
      {inbox.offline && <Banner level="ACTION" title={t('state.staleTitle')}>{t('state.staleText')}</Banner>}
      {!d ? <Skeleton rows={4} /> : (<>
        <div className="chips" role="group" aria-label={t('inbox.filter')}>
          <button className={`chip${!filter ? ' on' : ''}`} aria-pressed={!filter} onClick={() => setQuery({ level: null })}>{t('inbox.all', { n: d.summary.total })}</button>
          {(['BLOCKER', 'ACTION', 'INFO'] as const).map((l) => <button key={l} className={`chip${filter === l ? ' on' : ''}`} aria-pressed={filter === l} onClick={() => setQuery({ level: l })}>{t(`lvl.${l}` as Key)} · {count(l)}</button>)}
        </div>
        {shown.length === 0 ? <Empty text={t('inbox.clear')} /> : (
          <ul className="plain queue" aria-label={t('nav.inbox')}>{shown.map((i) => (
            <li key={i.id}>
              <Link to={inboxTarget(i)} className="qrow">
                <span className="q-main"><strong>{t(`ib.${i.kind}` as Key, { guest: i.guest ?? '', room: i.roomNumber ?? '', n: i.count ?? 0, title: i.title ?? '' })}</strong>
                  <span className="muted small">{[i.guest, i.roomNumber ? `${t('d.room')} ${i.roomNumber}` : '', i.amount ? money(i.amount) : ''].filter(Boolean).join(' · ')}</span></span>
                <span className="q-badges"><LevelBadge level={i.level}>{t(`lvl.${i.level}` as Key)}</LevelBadge></span>
                <span className="q-next"><Icon name="chevron" size={18} /></span>
              </Link>
            </li>))}</ul>)}
      </>)}
    </section>
  );
}
