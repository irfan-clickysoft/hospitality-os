import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, NetworkError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { StepUpSlot, useStepUp } from '../lib/stepup.js';
import { useAuth, useLive, useWork } from '../state.js';
import { ApprovalBox } from '../desk/ComplianceBits.js';
import { blankOccupant, occupantBody } from '../desk/CheckInSheet.js';
import { checkOccupant, formatId, gapsFor, type Matrix, type OccErrors, type Occupant } from '../lib/occupants.js';
import { PurposeField, RelationshipField } from '../desk/RegExtras.js';
import { OccupantDocs } from '../desk/OccupantDocs.js';
import { TimingFeeBox } from '../desk/TimingFee.js';
import { RoomPicker } from '../desk/RoomPicker.js';
import type { ReservationDetail } from '../desk/types.js';
import { Banner, Field, RoomState, SaveState, StatusBadge, type SaveStatus } from '../ui/ds.js';
import { Icon } from '../ui/icons.js';
import { ErrorLine } from '../ui/kit.js';
import { Link, navigate, useSetQuery } from '../shell/router.js';
import type { Stay } from './useStay.js';

const ID_TYPES = ['CNIC', 'NICOP', 'PASSPORT', 'DRIVING_LICENSE', 'OTHER'] as const;
type Errors = OccErrors;
const LABEL: Record<keyof Errors, Key> = { fullName: 'ci.name', idType: 'ci.idType', idNumber: 'ci.idNumber', nationality: 'ci.nationality', idExpiry: 'ci.expiry' };

const draftKey = (lineId: string) => `hos.draft.checkin.v1.${lineId}`;
/** The draft lives on this device. ID numbers are never written to it: they are sensitive, and a shared desk PC is not a safe place for them. */
const loadDraft = (lineId: string): Occupant[] | null => { try { const d = JSON.parse(localStorage.getItem(draftKey(lineId)) ?? 'null') as { occupants: Omit<Occupant, 'idNumber'>[] } | null; return d ? d.occupants.map((o) => ({ ...blankOccupant(), ...o, idNumber: '' })) : null; } catch { return null; } };

/** Full-page check-in inside the workspace: room, guests, confirm. The context rail stays on screen; problems are shown where they are and before anything is submitted. */
export function CheckIn({ stay }: { stay: Stay }) {
  const { t } = useT();
  const { property, can } = useAuth();
  const work = useWork(); const withStepUp = useStepUp(); const setQuery = useSetQuery();
  const { r, line, room: rackRoom, businessDate, blockers } = stay;
  const res = r!, ln = line!;
  const foreign = res.residency === 'NON_RESIDENT';
  const [purpose, setPurpose] = useState('');
  const [occ, setOcc] = useState<Occupant[]>(() => loadDraft(ln.id) ?? [blankOccupant(res.guest.fullName, foreign)]);
  const matrix = useLive<Matrix>(`/v1/properties/${property!.id}/registration/requirements`, 600_000).data ?? null;
  const [picked, setPicked] = useState<{ id: string; hk: string } | null>(null); const [changeRoom, setChangeRoom] = useState(false); const [pickerKey, setPickerKey] = useState(0);
  const [override, setOverride] = useState(false); const [attempted, setAttempted] = useState(false); const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [save, setSave] = useState<SaveStatus>({ kind: 'idle' });
  const { busy, problem, run, clear } = useAction();
  const ask = useAction(); const [asked, setAsked] = useState(false);
  const prioritise = async () => { if (!roomId) return; const r = await ask.run(() => api('POST', `/v1/properties/${property!.id}/housekeeping/rooms/${roomId}/prioritise`)); if (r) { setAsked(true); stay.refresh(); } };
  const edited = useRef(false);

  useEffect(() => { setPicked(null); setChangeRoom(false); }, [ln.assignedRoom?.id]);          // the room was (re)assigned elsewhere, e.g. from the move panel: follow it
  const roomId = picked?.id ?? ln.assignedRoom?.id ?? null;
  const hk = picked ? picked.hk : rackRoom?.hkStatus ?? 'CLEAN';
  const blocked = !picked && !!rackRoom && rackRoom.blocks.some((b) => b.from <= businessDate && businessDate < b.to);
  const notReady = !!roomId && (hk === 'DIRTY' || hk === 'CLEANING');
  const flagged = blockers.some((b) => b.code === 'GUEST_FLAGGED') || problem?.code === 'GUEST_BLOCKED';
  const roomNumber = picked ? undefined : ln.assignedRoom?.number;

  const errors = useMemo(() => occ.map((o, i) => checkOccupant(o, i, foreign, businessDate)), [occ, foreign, businessDate]);
  const missing = errors.flatMap((e, i) => (Object.keys(e) as Array<keyof Errors>).map((k) => `${t(LABEL[k])}${occ.length > 1 ? ` (${occ[i]!.fullName.trim() || i + 1})` : ''}`));
  const roomProblems = !roomId ? [t('ci.step.room')] : [];
  const offline = !work.online;
  const conflict = stay.changes.length > 0;
  const needsOverride = notReady && !override;
  const reasons = [...(roomProblems.length ? [t('ci.m.room')] : []), ...(blocked ? [t('ci.m.blocked')] : []), ...(needsOverride ? [t('ci.m.notReady')] : []), ...(missing.length ? [t('ci.m.missing', { n: missing.length })] : []), ...(offline ? [t('ci.m.offline')] : []), ...(conflict ? [t('ci.m.conflict')] : []), ...(flagged ? [t('ci.m.flagged')] : [])];
  const [feeBlocked, setFeeBlocked] = useState(false);
  const canSubmit = can('frontdesk.check_in') && reasons.length === 0 && !busy && !feeBlocked;

  // autosave the draft on this device
  useEffect(() => {
    if (!edited.current) return;
    setSave({ kind: 'saving' });
    const id = window.setTimeout(() => {
      try { localStorage.setItem(draftKey(ln.id), JSON.stringify({ occupants: occ.map(({ idNumber: _omit, ...rest }) => rest), savedAt: Date.now() })); setSave(offline ? { kind: 'offline' } : { kind: 'saved', at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) }); }
      catch { setSave({ kind: 'failed' }); }
    }, 600);
    return () => window.clearTimeout(id);
  }, [occ, ln.id, offline]);
  useEffect(() => { if (conflict) setSave({ kind: 'conflict' }); else if (offline) setSave({ kind: 'offline' }); }, [conflict, offline]);

  const set = (i: number, patch: Partial<Occupant>) => { edited.current = true; setOcc((x) => x.map((o, k) => (k === i ? { ...o, ...patch } : o))); };
  const submit = async (approval?: string) => {
    setAttempted(true); if (!approval && !canSubmit) return;
    clear();
    const body = { roomId: roomId ?? undefined, allowNotReady: notReady && override, occupants: occ.map((o, i) => occupantBody(o, i === 0)), ...(purpose.trim() ? { purposeOfVisit: purpose.trim() } : {}), ...(approval ? { complianceApproval: { reason: approval } } : {}) };
    const out = await run(() => withStepUp(() => api<ReservationDetail>('POST', `/v1/properties/${property!.id}/reservations/${res.id}/rooms/${ln.id}/check-in`, body)));
    if (out) { try { localStorage.removeItem(draftKey(ln.id)); } catch { /* ignore */ } stay.settle(out); navigate(`/reservations/${res.id}?done=checkin${res.lines.length > 1 ? `&line=${ln.id}` : ''}`, { replace: true }); return; }
  };
  useEffect(() => { if (problem && ['ROOM_NOT_FREE', 'ROOM_OCCUPIED', 'ROOM_BLOCKED', 'ROOM_NOT_READY', 'INVALID_STATE_TRANSITION'].includes(problem.code)) { stay.refresh(); setPickerKey((k) => k + 1); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [problem?.code]);

  const roomErr = problem && ['ROOM_NOT_FREE', 'ROOM_OCCUPIED', 'ROOM_BLOCKED', 'ROOM_NOT_READY', 'ROOM_REQUIRED'].includes(problem.code);
  const outage = problem && (problem.code === 'network' || problem.code === 'SERVER_ERROR' || problem.code === 'generic' || problem.code === 'ERROR');

  return (
    <div className="flow">
      <div className="flow-head"><h2>{t('ci.title')}</h2><SaveState s={save} onRetry={() => { edited.current = true; setOcc((x) => [...x]); }} /></div>
      <p className="muted small">{t('ci.draftNote')}</p>
      {flagged && <Banner level="BLOCKER" title={t('bl.GUEST_FLAGGED')}>{t('bl.d.GUEST_FLAGGED')}</Banner>}
      {!can('frontdesk.check_in') && <Banner level="INFO" title={t('perm.needFrontDesk')}>{t('perm.askColleague')}</Banner>}

      <section className="step" aria-labelledby="s-room"><h3 id="s-room"><span className="stepno">1</span> {t('ci.step.room')}</h3>
        {roomErr && problem && <Banner level="BLOCKER" title={t(`err.${problem.code}` as Key)}>{t('ci.roomChanged')}</Banner>}
        {!roomId ? (<><Banner level="ACTION" title={t('bl.NO_ROOM')}>{t('bl.d.NO_ROOM')}</Banner>
          <RoomPicker key={pickerKey} roomTypeId={ln.roomType.id} arrival={businessDate} departure={ln.departure} value={null} onChange={(id, h) => setPicked({ id, hk: h })} /></>)
          : blocked ? (<Banner level="BLOCKER" title={t('bl.ROOM_OUT_OF_SERVICE')} action={<button onClick={() => setQuery({ panel: 'move' })}>{t('d.moveRoom')}</button>}>{t('bl.d.ROOM_OUT_OF_SERVICE', { room: roomNumber ?? '' })}</Banner>)
          : notReady ? (
            <Banner level="BLOCKER" title={t('ci.roomNotReady', { room: roomNumber ?? '' })} action={<button className="primary" onClick={() => setQuery({ panel: 'move' })}>{t('ci.moveGuest')}</button>}>
              <p>{hk === 'CLEANING' ? t('ci.cleaning') : t('ci.dirty')} <RoomState hk={hk} /></p>
              {asked ? <p role="status"><StatusBadge tone="ok" icon="check">{t('ci.asked')}</StatusBadge></p> : <p><button disabled={ask.busy || offline} onClick={() => void prioritise()}>{t('ci.prioritise')}</button></p>}
              <ErrorLine code={ask.problem?.code} detail={ask.problem?.detail} />
              {can('frontdesk.override_room') ? <label className="check"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> {t('ci.notReady')}</label> : <p className="small muted"><Icon name="lock" size={14} /> {t('ci.overrideManager')}</p>}
            </Banner>)
          : <div className="okrow"><StatusBadge tone="ok" icon="check">{t('ci.roomReady', { room: roomNumber ?? '' })}</StatusBadge>{rackRoom && <RoomState hk={hk} />}</div>}
        {roomId && !changeRoom && !blocked && <button className="link" onClick={() => setChangeRoom(true)}>{t('ci.pickOther')}</button>}
        {roomId && changeRoom && <><RoomPicker key={pickerKey} roomTypeId={ln.roomType.id} arrival={businessDate} departure={ln.departure} value={roomId} onChange={(id, h) => { setPicked({ id, hk: h }); setOverride(false); setChangeRoom(false); }} /></>}
      </section>

      <section className="step" aria-labelledby="s-guests"><h3 id="s-guests"><span className="stepno">2</span> {t('ci.guests')}</h3>
        {foreign && <p className="hint">{t('ci.foreignNote')}</p>}
        {!res.guest.phone && <PhoneCapture guestId={res.guest.id} onSaved={stay.refresh} />}
        {occ.map((o, i) => {
          const e = errors[i]!; const show = (k: keyof Errors) => (attempted || touched[`${i}.${k}`]) && e[k] ? t(e[k]!) : undefined;
          const blur = (k: string) => setTouched((x) => ({ ...x, [`${i}.${k}`]: true }));
          return (
            <fieldset className="guestcard" key={i}><legend>{i === 0 ? t('ci.primary') : t('ci.companion', { n: i })}</legend>
              <Field label={t('ci.name')} required error={show('fullName')}>{(p) => <input {...p} value={o.fullName} onChange={(x) => set(i, { fullName: x.target.value })} onBlur={() => blur('fullName')} autoComplete="off" />}</Field>
              {i > 0 && <RelationshipField id={`c${i}`} value={o.relationship} onChange={(v) => set(i, { relationship: v })} />}
              <div className="grid2">
                <Field label={t('ci.idType')} required error={show('idType')}>{(p) => <select {...p} value={o.idType} onChange={(x) => set(i, { idType: x.target.value })} onBlur={() => blur('idType')}>{ID_TYPES.map((k) => <option key={k} value={k}>{t(`ci.id.${k}` as Key)}</option>)}</select>}</Field>
                <Field label={t('ci.idNumber')} required={i === 0} hint={i === 0 ? (o.idType === 'CNIC' ? t('ci.cnicHint') : undefined) : o.ageGroup === 'CHILD' ? t('ci.h.childNoId') : t('ci.h.sharedId')} error={show('idNumber')}>{(p) => <input {...p} value={o.idNumber} dir="ltr" inputMode={o.idType === 'CNIC' || o.idType === 'NICOP' ? 'numeric' : 'text'} placeholder={o.idType === 'CNIC' ? '35202-1234567-1' : ''} autoComplete="off" onChange={(x) => set(i, { idNumber: x.target.value })} onBlur={() => { set(i, { idNumber: formatId(o.idType, o.idNumber) }); blur('idNumber'); }} />}</Field>
              </div>
              <div className="grid2">
                <Field label={t('ci.nationality')} required={i === 0} hint={t('ci.nationalityHint')} error={show('nationality')}>{(p) => <input {...p} value={o.nationality} maxLength={2} dir="ltr" placeholder="PK" onChange={(x) => set(i, { nationality: x.target.value.toUpperCase() })} onBlur={() => blur('nationality')} />}</Field>
                {o.idType === 'PASSPORT' && <Field label={t('ci.expiry')} error={show('idExpiry')}>{(p) => <input {...p} type="date" value={o.idExpiry} dir="ltr" onChange={(x) => set(i, { idExpiry: x.target.value })} onBlur={() => blur('idExpiry')} />}</Field>}
              </div>
              <OccupantDocs index={i} all={occ} matrix={matrix} corporate={!!res.companyId} onChange={(patch) => set(i, patch)} />
              {i > 0 && <div className="row between"><label className="check"><input type="checkbox" checked={o.ageGroup === 'CHILD'} onChange={(x) => set(i, { ageGroup: x.target.checked ? 'CHILD' : 'ADULT' })} /> {t('ci.child')}</label><button className="link" onClick={() => { edited.current = true; setOcc((x) => x.filter((_, k) => k !== i).map((y) => ({ ...y, guardian: y.guardian === null ? null : y.guardian === i ? null : y.guardian > i ? y.guardian - 1 : y.guardian }))); }}>{t('ci.remove')}</button></div>}
            </fieldset>);
        })}
        <button type="button" onClick={() => { edited.current = true; setOcc((x) => [...x, blankOccupant('', foreign)]); }}>{t('ci.addGuest')}</button>
        <PurposeField value={purpose} onChange={setPurpose} />
      </section>

      <section className="step" aria-labelledby="s-confirm"><h3 id="s-confirm"><span className="stepno">3</span> {t('ci.step.confirm')}</h3>
        <TimingFeeBox kind="EARLY_CHECKIN" reservationId={res.id} lineId={ln.id} onState={setFeeBlocked} onDecided={() => stay.refresh()} />
        <dl className="summary">
          <div><dt>{t('ws.guest')}</dt><dd>{res.guest.fullName}</dd></div>
          <div><dt>{t('d.room')}</dt><dd>{roomNumber ?? (picked ? '✓' : t('d.noRoom'))}</dd></div>
          <div><dt>{t('ws.stay')}</dt><dd>{ln.arrival} → {ln.departure} · {t('d.nights', { n: ln.nights })}</dd></div>
          <div><dt>{t('ci.guests')}</dt><dd>{occ.length}</dd></div>
        </dl>
        {blockers.some((b) => b.code === 'AT_RISK') && <Banner level="ACTION" title={t('bl.AT_RISK')}>{t('ci.depositWarn')}</Banner>}
        {outage && <Banner level="BLOCKER" title={t('ci.outageTitle')} action={<button onClick={() => void submit()}>{t('common.retry')}</button>}>{t('ci.outageText')}</Banner>}
        {problem && !roomErr && !outage && <ErrorLine code={problem.code} detail={problem.detail} />}
        <ApprovalBox problem={problem} busy={busy} onApprove={(reason) => void submit(reason)} />
      </section>

      <StepUpSlot />
      <div className="actionbar" role="region" aria-label={t('ci.title')}>
        <div className="ab-msg" role="status" aria-live="polite">
          {reasons.length ? <><Icon name="alert" size={16} /> <span>{reasons.join(' · ')}</span>{attempted && missing.length > 0 && <ul className="plain small">{missing.map((m) => <li key={m}>{m}</li>)}</ul>}</> : <><Icon name="check" size={16} /> <span>{t('ci.ready')}</span></>}
        </div>
        <Link className="button" to={`/reservations/${res.id}`}>{t('common.cancel')}</Link>
        <button className={`primary${canSubmit ? '' : ' is-disabled'}`} disabled={busy} aria-disabled={!canSubmit} onClick={() => void submit()}>{busy ? t('common.loading') : t('ci.confirm')}</button>
      </div>
    </div>
  );
}

/** A missing phone number can be filled in here without leaving the check-in; it saves when you leave the field. */
function PhoneCapture({ guestId, onSaved }: { guestId: string; onSaved: () => void }) {
  const { t } = useT();
  const { can } = useAuth();
  const [v, setV] = useState(''); const [s, setS] = useState<SaveStatus>({ kind: 'idle' }); const [err, setErr] = useState<string>();
  const save = async () => {
    if (!v.trim()) return; setS({ kind: 'saving' }); setErr(undefined);
    try {
      const g = await api<{ version: number }>('GET', `/v1/guests/${guestId}`);
      await api('PATCH', `/v1/guests/${guestId}`, { phone: v.trim(), version: g.version });
      setS({ kind: 'saved', at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) }); onSaved();
    } catch (e) { setS(e instanceof NetworkError ? { kind: 'offline' } : e instanceof ApiError && e.status === 412 ? { kind: 'conflict' } : { kind: 'failed' }); if (e instanceof ApiError) setErr(e.code); }
  };
  return (
    <div className="guestcard">
      <Field label={t('ci.phone')} hint={t('ci.phoneHint')} error={err ? t(`err.${err}` as Key) === `err.${err}` ? t('err.generic') : t(`err.${err}` as Key) : undefined}>
        {(p) => <input {...p} type="tel" dir="ltr" value={v} disabled={!can('guest.manage')} placeholder="0300 1234567" onChange={(e) => setV(e.target.value)} onBlur={() => void save()} />}
      </Field>
      {can('guest.manage') ? <SaveState s={s} onRetry={() => void save()} /> : <p className="muted small"><Icon name="lock" size={14} /> {t('perm.readOnly')}</p>}
    </div>
  );
}
