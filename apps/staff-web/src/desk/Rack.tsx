import { useMemo, useState } from 'react';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { addDays, dayRange, shortDate, weekday } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Chip, HkBadge, Sheet, Spinner } from '../ui/kit.js';
import { NewBooking } from './NewBooking.js';
import { navigate } from '../shell/router.js';
import { RoomPicker } from './RoomPicker.js';
import type { RackData, RackRoom } from './types.js';
import { api } from '../api/client.js';
import { useAction } from '../lib/action.js';
import { ErrorLine } from '../ui/kit.js';
import { useStepUp } from '../lib/stepup.js';

const DAYS = 14;

/** The room rack (tape chart): rooms down the side, days across, each stay a bar. Tap a bar for the booking; tap a free night to book it. */
export function Rack() {
  const { t, locale } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const [from, setFrom] = useState<string | null>(null);
  const live = useLive<RackData>(`${base}/rack?days=${DAYS}${from ? `&from=${from}` : ''}`, 20_000);
  const open = (id: string) => navigate(`/reservations/${id}`); const [book, setBook] = useState<{ arrival: string; roomTypeId?: string } | null>(null); const [assign, setAssign] = useState<RackData['unassigned'][number] | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const d = live.data;
  const days = useMemo(() => (d ? dayRange(d.from, DAYS) : []), [d]);
  if (!d) return <Spinner />;
  const rooms = d.rooms.filter((r) => typeFilter === 'ALL' || r.roomTypeId === typeFilter);
  const col = (date: string) => Math.max(0, Math.min(DAYS, Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${d.from}T00:00:00Z`)) / 86_400_000)));
  /** A night already taken by a stay or a block has no "book here" button underneath the bar (it could be reached by keyboard but not seen). */
  const covered = (r: RackRoom, i: number) => r.stays.some((s) => col(s.from) <= i && i < col(s.to)) || r.blocks.some((k) => col(k.from) <= i && i < col(k.to));
  const typeOf = (id: string) => d.roomTypes.find((x) => x.id === id);

  return (
    <section>
      <div className="row between"><h2>{t('nav.rack')}</h2><div className="row">
        <button className="small" onClick={() => setFrom(addDays(d.from, -7))} aria-label={t('rack.prev')}>‹</button>
        <button className="small" onClick={() => setFrom(null)}>{t('rack.today')}</button>
        <button className="small" onClick={() => setFrom(addDays(d.from, 7))} aria-label={t('rack.next')}>›</button>
        {can('reservation.create') && <button className="primary small" onClick={() => setBook({ arrival: d.businessDate })}>{t('bk.new')}</button>}
      </div></div>
      <div className="chips"><Chip active={typeFilter === 'ALL'} onClick={() => setTypeFilter('ALL')}>{t('board.filter.all')}</Chip>{d.roomTypes.map((rt) => <Chip key={rt.id} active={typeFilter === rt.id} onClick={() => setTypeFilter(rt.id)}>{rt.name}</Chip>)}</div>

      {d.unassigned.length > 0 && (
        <div className="card inner"><h3>{t('rack.needsRoom', { n: d.unassigned.length })}</h3>
          <ul className="plain small">{d.unassigned.map((u) => <li key={u.lineId} className="row between"><button className="link" onClick={() => open(u.reservationId)}>{u.guestName} · {u.confirmationNo} · {typeOf(u.roomTypeId)?.code} · {shortDate(u.arrival, locale)} → {shortDate(u.departure, locale)}</button>{can('reservation.modify') && <button className="small" onClick={() => setAssign(u)}>{t('d.assignRoom')}</button>}</li>)}</ul></div>
      )}

      <div className="rack-scroll" role="region" aria-label={t('nav.rack')} tabIndex={0}>
        <div className="rack" style={{ ['--days' as string]: DAYS }}>
          <div className="rack-head"><div className="rack-corner" />
            <div className="rack-days">{days.map((x) => <div key={x} className={`rack-day${x === d.businessDate ? ' today' : ''}`}><span>{weekday(x, locale)}</span><strong>{shortDate(x, locale)}</strong></div>)}</div></div>
          {d.roomTypes.filter((rt) => typeFilter === 'ALL' || rt.id === typeFilter).map((rt) => (
            <div key={rt.id}>
              <div className="rack-type"><div className="rack-name"><strong>{rt.name}</strong></div>
                <div className="rack-days avail">{days.map((x) => { const a = rt.availability.find((v) => v.date === x); return <div key={x} className={`rack-day${a && a.available <= 0 ? ' full' : ''}`} title={a ? `${t('rack.sellable')} ${a.sellable} · ${t('rack.reserved')} ${a.reserved}` : ''}>{a ? a.available : ''}</div>; })}</div></div>
              {rooms.filter((r) => r.roomTypeId === rt.id).map((r) => (
                <div key={r.id} className="rack-row">
                  <div className="rack-name"><strong>{r.number}</strong><HkBadge status={r.hkStatus} /></div>
                  <div className="rack-lane">
                    {days.map((x, i) => (covered(r, i) || !can('reservation.create')) ? null : <button key={x} className={`cell${x === d.businessDate ? ' today' : ''}`} style={{ gridColumn: i + 1 }} aria-label={`${t('d.room')} ${r.number} ${x}`} onClick={() => setBook({ arrival: x, roomTypeId: r.roomTypeId })} />)}
                    {r.blocks.map((b) => <div key={b.id} className="bar block" style={{ gridColumn: `${col(b.from) + 1} / ${col(b.to) + 1}` }} title={b.reason}>{t(`occ.${b.type}` as Key)}</div>)}
                    {r.stays.map((s) => {
                      const a = col(s.from), z = col(s.to);
                      if (z <= a) return null;
                      return <button key={`${s.lineId}-${s.from}`} className={`bar st-${s.status.toLowerCase()}${s.atRisk ? ' risk' : ''}`} style={{ gridColumn: `${a + 1} / ${z + 1}` }} onClick={() => open(s.reservationId)} title={`${s.guestName} · ${s.confirmationNo}`} dir="auto">{s.vip ? '★ ' : ''}{s.guestName}</button>;
                    })}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="legend small muted">{(['CONFIRMED', 'CHECKED_IN', 'DEPARTED'] as const).map((k) => <span key={k} className={`bar-key st-${k.toLowerCase()}`}>{t(`rack.l.${k}` as Key)}</span>)}<span className="bar-key block">{t('occ.OUT_OF_ORDER')}</span></p>
      {book && <NewBooking initial={book} businessDate={d.businessDate} onClose={() => { setBook(null); live.reload(); }} onOpenReservation={(id) => { setBook(null); open(id); }} />}
      {assign && <AssignFromRack u={assign} onClose={() => { setAssign(null); live.reload(); }} />}
    </section>
  );
}

function AssignFromRack({ u, onClose }: { u: RackData['unassigned'][number]; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const withStepUp = useStepUp();
  const [room, setRoom] = useState<string | null>(null);
  const { busy, problem, run } = useAction();
  const go = async () => { const x = await run(() => withStepUp(() => api('PUT', `/v1/properties/${property!.id}/reservations/${u.reservationId}/rooms/${u.lineId}/assignment`, { roomId: room }))); if (x) onClose(); };
  return (
    <Sheet title={`${t('d.assignRoom')} · ${u.guestName}`} onClose={onClose}>
      <RoomPicker roomTypeId={u.roomTypeId} arrival={u.arrival} departure={u.departure} value={room} onChange={(id) => setRoom(id)} />
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || !room} onClick={go}>{t('act.confirm')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}
