import { useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive, useWork } from '../state.js';
import type { RackRoom } from '../desk/types.js';
import { Banner, Field, RoomState, SidePanel } from '../ui/ds.js';
import { Icon } from '../ui/icons.js';
import { ErrorLine } from '../ui/kit.js';
import type { Stay } from './useStay.js';

type Group = 'ready' | 'cleaning' | 'unavailable';
interface Option { room: RackRoom; group: Group; why?: Key }
const REASONS: Key[] = ['mv.r.notReady', 'mv.r.repair', 'mv.r.request', 'mv.r.noise'];

/**
 * Choose another room for this guest, in a panel beside the booking so the guest, dates and bill stay in view.
 * The same panel serves an in-house move (a recorded action with a reason) and a room (re)assignment before arrival.
 */
export function MovePanel({ stay, onClose, onDone }: { stay: Stay; onClose: () => void; onDone: (kind: 'move') => void }) {
  const { t } = useT();
  const { property, can } = useAuth();
  const work = useWork(); const withStepUp = useStepUp();
  const { r, line, businessDate, rack } = stay;
  const res = r!, ln = line!;
  const inHouse = ln.status === 'CHECKED_IN';
  const from = inHouse && businessDate > ln.arrival ? businessDate : ln.arrival;
  const free = useLive<{ items: Array<{ id: string }> }>(from < ln.departure ? `/v1/properties/${property!.id}/available-rooms?roomTypeId=${ln.roomType.id}&arrival=${from}&departure=${ln.departure}` : null, 20_000);
  const [pick, setPick] = useState<string | null>(null); const [reason, setReason] = useState(''); const [accept, setAccept] = useState(false);
  const { busy, problem, run, clear } = useAction();
  const allowed = inHouse ? can('frontdesk.check_in') : can('reservation.modify');
  const canOverride = can('frontdesk.override_room');

  const options = useMemo<Option[]>(() => {
    const ids = new Set((free.data?.items ?? []).map((x) => x.id));
    return (rack.data?.rooms ?? []).filter((x) => x.roomTypeId === ln.roomType.id && x.id !== ln.assignedRoom?.id).map((room): Option => {
      if (room.blocks.some((b) => b.from < ln.departure && b.to > from)) return { room, group: 'unavailable', why: 'mv.w.outOfService' };
      if (!ids.has(room.id)) return { room, group: 'unavailable', why: room.occupancy === 'OCCUPIED' ? 'mv.w.occupied' : 'mv.w.booked' };
      return { room, group: room.hkStatus === 'DIRTY' || room.hkStatus === 'CLEANING' ? 'cleaning' : 'ready' };
    }).sort((a, b) => a.room.number.localeCompare(b.room.number, undefined, { numeric: true }));
  }, [free.data, rack.data, ln, from]);
  const chosen = options.find((o) => o.room.id === pick) ?? null;
  const needAccept = !!chosen && chosen.group === 'cleaning';
  const dueOut = (rack.data?.rooms ?? []).filter((x) => x.roomTypeId === ln.roomType.id && x.dueOutToday).length;
  const age = rack.updatedAt ? Math.max(0, Math.round((Date.now() - rack.updatedAt) / 1000)) : null;
  const conflict = stay.changes.length > 0;
  const gone = problem?.code === 'ROOM_NOT_FREE' || problem?.code === 'ROOM_OCCUPIED' || problem?.code === 'ROOM_BLOCKED';
  const submitOk = !!chosen && allowed && work.online && !conflict && !busy && (!inHouse || reason.trim().length >= 3) && (!needAccept || (accept && (!inHouse || canOverride)));

  const go = async () => {
    if (!chosen) return; clear();
    const base = `/v1/properties/${property!.id}/reservations/${res.id}/rooms/${ln.id}`;
    const out = await run(() => withStepUp(() => inHouse
      ? api('POST', `${base}/move`, { roomId: chosen.room.id, reason: reason.trim(), allowNotReady: needAccept && accept })
      : api('PUT', `${base}/assignment`, { roomId: chosen.room.id })));
    if (out) onDone('move');
    else if (problem === null) { /* error already shown */ }
  };
  const reload = () => { rack.reload(); free.reload(); };
  const where = (o: Option) => o.room.floor ?? '';

  const groupTitle: Record<Group, Key> = { ready: 'mv.g.ready', cleaning: 'mv.g.cleaning', unavailable: 'mv.g.unavailable' };
  const title = inHouse ? t('mv.titleMove', { name: res.guest.fullName }) : t('mv.titleAssign', { name: res.guest.fullName });
  return (
    <SidePanel title={title} subtitle={`${ln.roomType.name} · ${t('d.nights', { n: ln.nights })}${ln.assignedRoom ? ` · ${t('mv.current', { room: ln.assignedRoom.number })}` : ''}`} onClose={onClose}
      footer={<div className="actions">
        <button className="primary" disabled={!submitOk} onClick={() => void go()}>{chosen ? t(inHouse ? 'mv.confirmMove' : 'mv.confirmAssign', { room: chosen.room.number }) : t('mv.choose')}</button>
        <button onClick={onClose}>{t('common.cancel')}</button>
      </div>}>
      {!allowed && <Banner level="INFO" title={t('mv.readOnly')}>{inHouse ? t('perm.needFrontDesk') : t('perm.needModify')}</Banner>}
      {conflict && <Banner level="BLOCKER" title={t('conflict.title')} action={<button className="primary" onClick={stay.acknowledge}>{t('conflict.review')}</button>}>{t('mv.conflictText')}</Banner>}
      {!work.online && <Banner level="ACTION" title={t('sys.offlineShort')}>{t('mv.offline')}</Banner>}
      {gone && <Banner level="BLOCKER" title={t(`err.${problem!.code}` as Key)}>{t('mv.taken')}</Banner>}
      <div className="row between"><span className="muted small" role="status">{age !== null ? t('mv.updated', { s: age }) : ''}</span><button className="small" onClick={reload}><Icon name="clock" size={14} /> {t('common.refresh')}</button></div>
      {from >= ln.departure && <Banner level="INFO" title={t('mv.endsToday')} />}
      {(!rack.data || (!free.data && from < ln.departure)) ? <p className="muted" role="status">{t('common.loading')}</p> : (<>
        {!options.some((o) => o.group !== 'unavailable') && from < ln.departure && (
          <Banner level="ACTION" title={t('mv.noneFree', { type: ln.roomType.name })}>{dueOut > 0 ? t('mv.dueOut', { n: dueOut }) : t('mv.noneDue')}</Banner>)}
        {(['ready', 'cleaning', 'unavailable'] as const).map((g) => {
          const list = options.filter((o) => o.group === g); if (!list.length) return null;
          return (
            <section key={g} aria-labelledby={`g-${g}`}><h3 id={`g-${g}`}>{t(groupTitle[g])} <span className="muted">({list.length})</span></h3>
              <ul className="plain roomlist" aria-label={t(groupTitle[g])}>{list.map((o) => {
                const disabled = o.group === 'unavailable' || !allowed || (inHouse && o.group === 'cleaning' && !canOverride);
                return (
                  <li key={o.room.id}><button aria-pressed={pick === o.room.id} disabled={disabled} className={`roomopt${pick === o.room.id ? ' on' : ''}`} onClick={() => { setPick(o.room.id); setAccept(false); clear(); }}>
                    <strong>{o.room.number}</strong><span className="muted small">{where(o)}</span><RoomState hk={o.room.hkStatus} />
                    {o.why && <span className="muted small">{t(o.why)}</span>}{inHouse && o.group === 'cleaning' && !canOverride && <span className="muted small">{t('mv.needsManager')}</span>}
                  </button></li>);
              })}</ul></section>);
        })}
        <div className="upgrade"><button disabled aria-describedby="why-upg"><Icon name="lock" size={14} /> {t('mv.upgrade')}</button><p id="why-upg" className="muted small">{t('mv.upgradeWhy')}</p></div>
        {chosen && (
          <section className="consequence" aria-labelledby="h-cons"><h3 id="h-cons">{t('mv.summary')}</h3>
            <ul className="plain">
              <li><Icon name="swap" size={16} /> {ln.assignedRoom ? t('mv.sum.from', { from: ln.assignedRoom.number, to: chosen.room.number }) : t('mv.sum.assign', { to: chosen.room.number })}</li>
              <li><Icon name="check" size={16} /> {t('mv.sum.rate')}</li>
              {inHouse && ln.assignedRoom && <li><Icon name="housekeeping" size={16} /> {t('mv.sum.release', { from: ln.assignedRoom.number })}</li>}
              <li><Icon name="info" size={16} /> {t('mv.sum.notify')}</li>
            </ul>
            {needAccept && <label className="check warnbox"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> {t('mv.accept', { room: chosen.room.number })}</label>}
            {inHouse && (<>
              <Field label={t('common.reason')} required>{(p) => <input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
              <div className="chips" role="group" aria-label={t('mv.suggest')}>{REASONS.map((k) => <button key={k} type="button" className="chip" onClick={() => setReason(t(k))}>{t(k)}</button>)}</div>
            </>)}
          </section>)}
      </>)}
      {problem && !gone && <ErrorLine code={problem.code} detail={problem.detail} />}
    </SidePanel>
  );
}
