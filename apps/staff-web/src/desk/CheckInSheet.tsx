import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth } from '../state.js';
import { ErrorLine, Sheet } from '../ui/kit.js';
import { ApprovalBox } from './ComplianceBits.js';
import { RoomPicker } from './RoomPicker.js';
import type { Line, ReservationDetail } from './types.js';

export interface Occupant { fullName: string; idType: string; idNumber: string; nationality: string; idExpiry: string; ageGroup: 'ADULT' | 'CHILD' }
const ID_TYPES = ['CNIC', 'NICOP', 'PASSPORT', 'DRIVING_LICENSE', 'OTHER'] as const;
export const blankOccupant = (name = '', foreign = false): Occupant => ({ fullName: name, idType: foreign ? 'PASSPORT' : 'CNIC', idNumber: '', nationality: foreign ? '' : 'PK', idExpiry: '', ageGroup: 'ADULT' });
export const occupantBody = (o: Occupant, primary: boolean) => ({ fullName: o.fullName.trim(), isPrimary: primary, ageGroup: o.ageGroup, idType: o.idType, idNumber: o.idNumber.trim(), ...(o.nationality.trim() ? { nationality: o.nationality.trim().toUpperCase() } : {}), ...(o.idExpiry ? { idExpiry: o.idExpiry } : {}) });

/** The registration card: who is staying, with their identity documents. */
export function OccupantsForm({ occupants, onChange, foreign }: { occupants: Occupant[]; onChange: (o: Occupant[]) => void; foreign: boolean }) {
  const { t } = useT();
  const set = (i: number, patch: Partial<Occupant>) => onChange(occupants.map((o, k) => (k === i ? { ...o, ...patch } : o)));
  return (
    <div className="stack">
      {occupants.map((o, i) => (
        <div key={i} className="card inner stack">
          <div className="row between"><strong>{i === 0 ? t('ci.primary') : t('ci.companion', { n: i })}</strong>{i > 0 && <button className="link" onClick={() => onChange(occupants.filter((_, k) => k !== i))}>{t('ci.remove')}</button>}</div>
          <label>{t('ci.name')}<input value={o.fullName} onChange={(e) => set(i, { fullName: e.target.value })} /></label>
          <div className="grid2">
            <label>{t('ci.idType')}<select value={o.idType} onChange={(e) => set(i, { idType: e.target.value })}>{ID_TYPES.map((x) => <option key={x} value={x}>{t(`ci.id.${x}` as Key)}</option>)}</select></label>
            <label>{t('ci.idNumber')}<input value={o.idNumber} onChange={(e) => set(i, { idNumber: e.target.value })} dir="ltr" inputMode={o.idType === 'CNIC' || o.idType === 'NICOP' ? 'numeric' : 'text'} placeholder={o.idType === 'CNIC' ? '35202-1234567-1' : ''} /></label>
          </div>
          <div className="grid2">
            <label>{t('ci.nationality')}<input value={o.nationality} maxLength={2} onChange={(e) => set(i, { nationality: e.target.value.toUpperCase() })} dir="ltr" placeholder="PK" /></label>
            {o.idType === 'PASSPORT' && <label>{t('ci.expiry')}<input type="date" value={o.idExpiry} onChange={(e) => set(i, { idExpiry: e.target.value })} dir="ltr" /></label>}
          </div>
          {i > 0 && <label className="check"><input type="checkbox" checked={o.ageGroup === 'CHILD'} onChange={(e) => set(i, { ageGroup: e.target.checked ? 'CHILD' : 'ADULT' })} /> {t('ci.child')}</label>}
        </div>
      ))}
      <button type="button" onClick={() => onChange([...occupants, blankOccupant('', foreign)])}>{t('ci.addGuest')}</button>
      {foreign && <p className="muted small">{t('ci.foreignNote')}</p>}
    </div>
  );
}

export function CheckInSheet({ res, line, onDone, onClose }: { res: ReservationDetail; line: Line; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const withStepUp = useStepUp();
  const foreign = res.residency === 'NON_RESIDENT';
  const [room, setRoom] = useState<{ id: string; hk: string } | null>(line.assignedRoom ? { id: line.assignedRoom.id, hk: 'CLEAN' } : null);
  const [occ, setOcc] = useState<Occupant[]>([blankOccupant(res.guest.fullName, foreign)]);
  const [override, setOverride] = useState(false);
  const { busy, problem, run } = useAction();
  const notReady = room && (room.hk === 'DIRTY' || room.hk === 'CLEANING');

  const submit = async (approval?: string) => {
    const body = { roomId: room?.id, allowNotReady: !!(override && notReady), occupants: occ.map((o, i) => occupantBody(o, i === 0)), ...(approval ? { complianceApproval: { reason: approval } } : {}) };
    const r = await run(() => withStepUp(() => api('POST', `/v1/properties/${property!.id}/reservations/${res.id}/rooms/${line.id}/check-in`, body)));
    if (r) { onDone(); onClose(); }
  };
  return (
    <Sheet title={`${t('ci.title')} · ${res.guest.fullName}`} onClose={onClose}>
      <p className="muted">{res.confirmationNo} · {line.roomType.name} · {line.arrival} → {line.departure}</p>
      <h3>{t('d.room')}</h3>
      <RoomPicker roomTypeId={line.roomType.id} arrival={line.arrival} departure={line.departure} value={room?.id ?? null} onChange={(id, hk) => { setRoom({ id, hk }); setOverride(false); }} />
      {notReady && <label className="check warnbox"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> {t('ci.notReady')}</label>}
      <h3>{t('ci.guests')}</h3>
      <OccupantsForm occupants={occ} onChange={setOcc} foreign={foreign} />
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <ApprovalBox problem={problem} busy={busy} onApprove={(r) => void submit(r)} />
      <div className="actions"><button className="primary" disabled={busy || !room || occ.some((o) => !o.fullName.trim() || !o.idNumber.trim()) || (!!notReady && !override)} onClick={() => void submit()}>{t('ci.confirm')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}
