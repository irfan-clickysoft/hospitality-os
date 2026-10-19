import { useMemo } from 'react';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAuth, useLive } from '../state.js';
import { HkBadge, Spinner } from '../ui/kit.js';
import type { RackData } from './types.js';

/** Rooms of one type that can take the stay, with their housekeeping state. A room that is not free for the dates is shown but cannot be chosen. */
export function RoomPicker({ roomTypeId, arrival, departure, value, onChange }: { roomTypeId: string; arrival: string; departure: string; value: string | null; onChange: (id: string, hk: string) => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const free = useLive<{ items: Array<{ id: string; number: string }> }>(`/v1/properties/${property!.id}/available-rooms?roomTypeId=${roomTypeId}&arrival=${arrival}&departure=${departure}`, 60_000);
  const rack = useLive<RackData>(`/v1/properties/${property!.id}/rack?days=1`, 30_000);
  const rooms = useMemo(() => (rack.data?.rooms ?? []).filter((r) => r.roomTypeId === roomTypeId), [rack.data, roomTypeId]);
  if (!free.data || !rack.data) return <Spinner />;
  const ids = new Set(free.data.items.map((i) => i.id));
  return (
    <ul className="plain room-picker" role="listbox" aria-label={t('d.chooseRoom')}>
      {rooms.map((r) => {
        const isFree = ids.has(r.id); const busyNow = r.occupancy !== 'VACANT';
        return (
          <li key={r.id}>
            <button type="button" role="option" aria-selected={value === r.id} className={`wide pick${value === r.id ? ' on' : ''}`} disabled={!isFree} onClick={() => onChange(r.id, r.hkStatus)}>
              <strong>{r.number}</strong> <HkBadge status={r.hkStatus} /> {busyNow && isFree && <span className="muted small">{t(`occ.${r.occupancy}` as Key)}</span>} {!isFree && <span className="muted small">{t('d.notFree')}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
