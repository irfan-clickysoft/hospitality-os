import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { money, shortDate } from '../lib/format.js';
import { Badge } from '../ui/kit.js';
import { STATUS_TONE, type ListItem } from './types.js';

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
