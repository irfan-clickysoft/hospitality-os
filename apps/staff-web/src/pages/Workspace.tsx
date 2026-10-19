import { useEffect, useRef, useState } from 'react';
import { api, ApiError, NetworkError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { isNegative, isZero, money, shortDate, whatsappNumber } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive, useWork } from '../state.js';
import { ChargeSheet } from '../desk/ChargeSheet.js';
import { ComplianceNotes, type Hit } from '../desk/ComplianceBits.js';
import { InvoicePanel } from '../desk/Invoices.js';
import { PaymentSheet } from '../desk/PaymentSheet.js';
import { CancelSheet, FolioPanel, PaymentFixSheet } from '../desk/ReservationParts.js';
import type { Line, ReservationDetail } from '../desk/types.js';
import { Banner, ConfirmCard, InlineConfirm, ResStatus, RoomState, SaveState, Skeleton, StatusBadge, Tabs, type SaveStatus } from '../ui/ds.js';
import { Icon } from '../ui/icons.js';
import { ErrorLine } from '../ui/kit.js';
import { useRegisterCommands } from '../shell/context.js';
import { Link, navigate, useRoute, useSetQuery } from '../shell/router.js';
import { CheckIn } from './CheckIn.js';
import { CheckOut } from './CheckOut.js';
import { MovePanel } from './MovePanel.js';
import type { Blocker } from './Today.js';
import { useStay, type Changed, type Stay } from './useStay.js';

const minorOf = (a: { amount: string }) => Math.round(parseFloat(a.amount) * 100);
type Dialog = null | { kind: 'pay' | 'deposit' | 'charge' | 'void' | 'refund' | 'cancel' | 'noshow'; paymentId?: string };

/** "Hira checked this guest in at 23:41" in words, for the conflict banner. */
export function ConflictBanner({ stay }: { stay: Stay }) {
  const { t, locale } = useT();
  if (!stay.changes.length) return null;
  const c: Changed = stay.changes[0]!;
  const last = stay.r?.history[stay.r.history.length - 1];
  const when = last ? new Date(last.at).toLocaleTimeString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  const what = c.kind === 'status' ? t('conflict.status', { status: t(`rs.${c.status}` as Key) }) : c.kind === 'room' ? t('conflict.room', { room: c.room ?? t('d.noRoom') }) : t('conflict.other');
  return <Banner level="BLOCKER" title={t('conflict.title')} action={<button className="primary" onClick={stay.acknowledge}>{t('conflict.review')}</button>}>{what}{when ? ` · ${t('conflict.at', { time: when })}` : ''}</Banner>;
}

function BlockerBanners({ stay, openPanel, onPay }: { stay: Stay; openPanel: (p: string) => void; onPay: () => void }) {
  const { t } = useT();
  const { can } = useAuth();
  const { line, room } = stay;
  if (!line) return null;
  const act = (b: Blocker) => {
    if (b.code === 'NO_ROOM') return can('reservation.modify') ? <button onClick={() => openPanel('move')}>{t('d.assignRoom')}</button> : null;
    if (b.code === 'ROOM_NOT_READY' || b.code === 'ROOM_OUT_OF_SERVICE') return can('reservation.modify') || can('frontdesk.check_in') ? <button onClick={() => openPanel('move')}>{t('d.moveRoom')}</button> : null;
    if (b.code === 'AT_RISK') return can('payment.take') ? <button onClick={onPay}>{t('pay.k.DEPOSIT')}</button> : null;
    if (b.code === 'BALANCE_DUE' || b.code === 'OVERDUE_DEPARTURE') return <Link className="button" to={`/reservations/${stay.r!.id}/check-out?line=${line.id}`}>{t('co.title')}</Link>;
    return null;
  };
  return <>{[...stay.blockers].map((b) => (
    <Banner key={b.code} level={b.level} title={t(`bl.${b.code}` as Key, { amount: b.amount ? money(b.amount) : '' })} action={act(b)}>{t(`bl.d.${b.code}` as Key, { room: line.assignedRoom?.number ?? room?.number ?? '', amount: b.amount ? money(b.amount) : '' })}</Banner>))}</>;
}

/** The part of the workspace that stays on screen whatever you are doing: who, when, where, how much. */
function ContextRail({ stay }: { stay: Stay }) {
  const { t, locale } = useT();
  const { can } = useAuth();
  const { r, line, room, folio } = stay;
  if (!r || !line) return <section className="rail-ctx" aria-label={t('ws.context')}><Skeleton rows={4} /></section>;
  const bal = folio.data?.folio?.balance;
  const phone = r.guest.phone; const wa = whatsappNumber(phone);
  return (
    <section className="rail-ctx" aria-label={t('ws.context')}>
      <section className="ctx-card" aria-labelledby="ctx-guest"><h2 id="ctx-guest">{t('ws.guest')}</h2>
        <p><strong>{r.guest.fullName}</strong>{r.guest.vip && <> <StatusBadge tone="info" icon="info">{t('q.vip')}</StatusBadge></>}</p>
        <p className="small muted">{[r.guest.nationality, t(`src.${r.source}` as Key)].filter(Boolean).join(' · ')}</p>
        {phone ? <p className="small"><a href={`tel:${phone}`} dir="ltr">{phone}</a>{wa && <> · <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">{t('wa.open')}</a></>}</p> : <p className="small"><StatusBadge tone="warn" icon="alert">{t('ws.noPhone')}</StatusBadge></p>}
      </section>
      <section className="ctx-card" aria-labelledby="ctx-stay"><h2 id="ctx-stay">{t('ws.stay')}</h2>
        <p><ResStatus status={line.status} /></p>
        <p className="small">{shortDate(line.arrival, locale)} → {shortDate(line.departure, locale)} · {t('d.nights', { n: line.nights })}</p>
        <p className="small">{line.roomType.name} · {line.adults} {t('d.adults')}{line.children ? `, ${line.children} ${t('d.children')}` : ''}</p>
        <p className="small muted">{r.confirmationNo} · {line.ratePlan.name}</p>
        {r.lines.length > 1 && <p className="small muted">{t('ws.lineOf', { n: line.lineNo, total: r.lines.length })}</p>}
      </section>
      <section className="ctx-card" aria-labelledby="ctx-room"><h2 id="ctx-room">{t('d.room')}</h2>
        {line.assignedRoom ? (<p><strong className="big">{line.assignedRoom.number}</strong> {room && <RoomState hk={room.hkStatus} />}{room && room.blocks.length > 0 && <> <StatusBadge tone="danger" icon="stop">{t('bl.ROOM_OUT_OF_SERVICE')}</StatusBadge></>}</p>)
          : <p><StatusBadge tone="warn" icon="alert">{t('d.noRoom')}</StatusBadge></p>}
      </section>
      {can('folio.view') && (
        <section className="ctx-card" aria-labelledby="ctx-bal"><h2 id="ctx-bal">{t('ws.balance')}</h2>
          {!bal ? (folio.loading ? <Skeleton rows={1} /> : <p className="muted small">{t('common.none')}</p>) : (<>
            <p className="big" dir="ltr">{money(bal)}</p>
            <p>{isZero(bal) ? <StatusBadge tone="ok" icon="check">{t('ws.paid')}</StatusBadge> : isNegative(bal) ? <StatusBadge tone="info" icon="info">{t('ws.credit', { amount: money({ amount: bal.amount.replace('-', ''), currency: bal.currency }) })}</StatusBadge> : <StatusBadge tone="warn" icon="alert">{t('ws.owes', { amount: money(bal) })}</StatusBadge>}</p>
            {folio.data && folio.data.projection.unpostedNights > 0 && minorOf(folio.data.projection.balanceAtEndOfStay) !== minorOf(bal) && <p className="small muted">{t('ws.afterNights', { amount: money(folio.data.projection.balanceAtEndOfStay) })}</p>}
            {r.guarantee.depositPaid.amount !== '0.00' && <p className="small muted">{t('fo.depositHeld')}: {money(r.guarantee.depositPaid)}</p>}
          </>)}
        </section>)}
    </section>
  );
}

/** Notes and preferences save by themselves. The state is always visible: saving, saved, could not save, offline, or someone else changed it. */
function Notes({ r, onSaved }: { r: ReservationDetail; onSaved: () => void }) {
  const { t } = useT();
  const { property, can } = useAuth();
  const work = useWork();
  const editable = can('reservation.modify');
  const [vals, setVals] = useState({ specialRequests: r.notes.specialRequests ?? '', notesGuest: r.notes.guest ?? '', notesInternal: r.notes.internal ?? '' });
  const [save, setSave] = useState<SaveStatus>({ kind: 'idle' });
  const version = useRef(r.version); const dirty = useRef(false); const timer = useRef<number>(); const latest = useRef(vals); latest.current = vals;
  useEffect(() => { if (!dirty.current) { version.current = r.version; setVals({ specialRequests: r.notes.specialRequests ?? '', notesGuest: r.notes.guest ?? '', notesInternal: r.notes.internal ?? '' }); } }, [r]);
  const flush = async () => {
    if (!work.online) { setSave({ kind: 'offline' }); return; }
    setSave({ kind: 'saving' });
    try {
      const out = await api<ReservationDetail>('PATCH', `/v1/properties/${property!.id}/reservations/${r.id}`, { ...latest.current, version: version.current });
      version.current = out.version; dirty.current = false; setSave({ kind: 'saved', at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) }); onSaved();
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'VERSION_CONFLICT' || e.status === 412)) { setSave({ kind: 'conflict' }); return; }
      setSave(e instanceof NetworkError ? { kind: 'offline' } : { kind: 'failed' });
    }
  };
  /** The person chose their text over the other change: take the current version number, then save theirs on top. */
  const keepMine = async () => {
    try { version.current = (await api<ReservationDetail>('GET', `/v1/properties/${property!.id}/reservations/${r.id}`)).version; await flush(); } catch { setSave({ kind: 'failed' }); }
  };
  const edit = (k: keyof typeof vals, v: string) => { setVals((x) => ({ ...x, [k]: v })); dirty.current = true; setSave({ kind: 'saving' }); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void flush(), 900); };
  useEffect(() => { if (work.online && save.kind === 'offline' && dirty.current) void flush(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [work.online]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const rows: Array<[keyof typeof vals, Key]> = [['specialRequests', 'ws.requests'], ['notesGuest', 'ws.guestNotes'], ['notesInternal', 'ws.internalNotes']];
  return (
    <section className="block" aria-labelledby="h-notes">
      <div className="block-head"><h2 id="h-notes">{t('ws.notes')}</h2>{editable && <SaveState s={save} onRetry={() => void flush()} />}</div>
      {save.kind === 'conflict' && (
        <Banner level="BLOCKER" title={t('save.conflictTitle')} action={<span className="actions"><button onClick={() => { dirty.current = false; setSave({ kind: 'idle' }); onSaved(); }}>{t('save.useTheirs')}</button><button className="primary" onClick={() => void keepMine()}>{t('save.keepMine')}</button></span>}>{t('save.conflictText')}</Banner>)}
      {rows.map(([k, label]) => (
        <div className="field" key={k}><label htmlFor={`n-${k}`}>{t(label)}</label>
          {editable ? <textarea id={`n-${k}`} value={vals[k]} maxLength={2000} onChange={(e) => edit(k, e.target.value)} /> : <p id={`n-${k}`} className="readonly">{vals[k] || <span className="muted">{t('common.none')}</span>}</p>}
        </div>))}
      {!editable && <p className="muted small"><Icon name="lock" size={14} /> {t('perm.readOnly')}</p>}
    </section>
  );
}

function Timeline({ r }: { r: ReservationDetail }) {
  const { t, locale } = useT();
  const { can } = useAuth();
  return (
    <section className="block" aria-labelledby="h-time"><h2 id="h-time">{t('ws.timeline')}</h2>
      <ol className="timeline plain">{[...r.history].reverse().map((h, i) => (
        <li key={i}><span className="tl-dot" aria-hidden="true" />
          <div><strong>{t(`hist.${h.action}` as Key) === `hist.${h.action}` ? h.action.replace(/_/g, ' ').toLowerCase() : t(`hist.${h.action}` as Key)}{h.to ? ` → ${t(`rs.${h.to}` as Key)}` : ''}</strong>
            {h.reason && <p className="small">{h.reason}</p>}
            <p className="muted small">{new Date(h.at).toLocaleString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</p></div></li>))}</ol>
      {can('audit.view') && <p><Link to="/reports?tab=trail">{t('ws.fullAudit')}</Link></p>}
    </section>
  );
}

function LineCard({ stay, l, openPanel, openDialog }: { stay: Stay; l: Line; openPanel: (p: string, line: string) => void; openDialog: (d: Dialog) => void }) {
  const { t, locale } = useT();
  const { can, property } = useAuth();
  const rack = stay.rack.data?.rooms.find((x) => x.id === l.assignedRoom?.id);
  const a = l.allowedActions;
  return (
    <li className="linecard">
      <div className="row between"><strong>{l.roomType.name}</strong><ResStatus status={l.status} /></div>
      <p className="small">{shortDate(l.arrival, locale)} → {shortDate(l.departure, locale)} · {t('d.nights', { n: l.nights })} · {l.adults} {t('d.adults')}{l.children ? `, ${l.children} ${t('d.children')}` : ''} · {l.ratePlan.name}</p>
      <p className="small">{l.assignedRoom ? <>{t('d.room')} <strong>{l.assignedRoom.number}</strong> {rack && <RoomState hk={rack.hkStatus} />}</> : <StatusBadge tone="warn" icon="alert">{t('d.noRoom')}</StatusBadge>} · <strong>{money(l.total)}</strong> <span className="muted">{t('d.exTax')}</span></p>
      <div className="actions">
        {l.status === 'CHECKED_IN' && can('frontdesk.check_in') && <button onClick={() => openPanel('move', l.id)}><Icon name="swap" size={16} /> {t('d.moveRoom')}</button>}
        {(l.status === 'CONFIRMED' || l.status === 'OPTION') && can('reservation.modify') && <button onClick={() => openPanel('move', l.id)}><Icon name="key" size={16} /> {l.assignedRoom ? t('d.changeRoom') : t('d.assignRoom')}</button>}
        {(l.status === 'CHECKED_IN' || l.status === 'CHECKED_OUT') && <a className="button" href={`/v1/properties/${property!.id}/reservations/${stay.r!.id}/rooms/${l.id}/registration-card`} target="_blank" rel="noreferrer"><Icon name="print" size={16} /> {t('d.regCard')}</a>}
        {a.includes('CANCEL') && can('reservation.cancel') && <button onClick={() => openDialog({ kind: 'cancel' })}>{t('d.cancel')}</button>}
        {a.includes('NO_SHOW') && l.arrival <= stay.businessDate && can('reservation.cancel') && <button onClick={() => openDialog({ kind: 'noshow' })}>{t('d.noShow')}</button>}
      </div>
    </li>
  );
}

/** A finished action stays on the page as a card. Undo is offered only where the system allows it. */
function Done({ stay, kind, dismiss }: { stay: Stay; kind: string; dismiss: () => void }) {
  const { t, locale } = useT();
  const { property, can } = useAuth();
  const withStepUp = useStepUp(); const a = useAction();
  const { r, line } = stay; if (!r || !line) return null;
  const entry = [...r.history].reverse().find((h) => (kind === 'checkin' ? h.action === 'CHECK_IN' : kind === 'move' ? h.action === 'ROOM_MOVED' || h.action === 'ROOM_ASSIGNED' : kind === 'checkout' ? h.action === 'CHECK_OUT' : false));
  if (!entry) return null;
  const time = new Date(entry.at).toLocaleTimeString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  const undo = (reason: string) => a.run(() => withStepUp(() => api('POST', `/v1/properties/${property!.id}/reservations/${r.id}/rooms/${line.id}/undo-check-in`, { reason }))).then((x) => { if (x) { stay.settle(x as ReservationDetail); dismiss(); } });
  return (
    <ConfirmCard title={t(`done.${kind}` as Key, { time, room: line.assignedRoom?.number ?? '' })} action={<button className="link" onClick={dismiss}>{t('common.close')}</button>}>
      {kind === 'checkout' && <><p className="small">{t('done.checkoutNote')}</p><InvoicePanel reservationId={r.id} finished /></>}
      {kind === 'checkin' && <p><a className="button" href={`/v1/properties/${property!.id}/reservations/${r.id}/rooms/${line.id}/registration-card`} target="_blank" rel="noreferrer"><Icon name="print" size={16} /> {t('d.regCard')}</a></p>}
      {kind === 'checkin' && line.status === 'CHECKED_IN' && can('frontdesk.check_in') && (
        <InlineConfirm trigger={t('done.undoCheckIn')} consequence={t('done.undoCheckInText')} confirmLabel={t('done.undoCheckIn')} needReason busy={a.busy} onConfirm={(reason) => void undo(reason)} error={<ErrorLine code={a.problem?.code} detail={a.problem?.detail} />} />)}
    </ConfirmCard>
  );
}

export function Workspace({ id, flow }: { id: string; flow?: string }) {
  const { t } = useT();
  const { property, can } = useAuth();
  const route = useRoute(); const setQuery = useSetQuery();
  const stay = useStay(id, route.query.get('line'));
  const { r, line } = stay;
  const [dialog, setDialog] = useState<Dialog>(null);
  const tab = (['overview', 'bill', 'timeline'] as const).find((x) => x === route.query.get('tab')) ?? 'overview';
  const panel = route.query.get('panel'); const done = route.query.get('done');
  const base = `/v1/properties/${property!.id}`;
  const comp = useLive<{ hits: Array<Hit & { rule: string; message: string }>; tasks: Array<{ id: string; title: string; status: string }> }>(can('compliance.view') ? `${base}/reservations/${id}/compliance` : null, 60_000);

  const canIn = !!line && line.allowedActions.includes('CHECK_IN') && line.arrival <= stay.businessDate && stay.businessDate < line.departure;
  const canOut = !!line && line.allowedActions.includes('CHECK_OUT');
  const here = `/reservations/${id}`;
  const lineQ = line && r && r.lines.length > 1 ? `?line=${line.id}` : '';
  const go = (tail: string) => navigate(`${here}${tail}${lineQ}`);
  const openPanel = (p: string, lineId?: string) => setQuery({ panel: p, ...(lineId ? { line: lineId } : {}) });

  useRegisterCommands('workspace', [
    ...(canIn && can('frontdesk.check_in') ? [{ id: 'ci', label: t('ci.title'), icon: 'key' as const, keys: 'c', run: () => go('/check-in') }] : []),
    ...(canOut && can('frontdesk.check_out') ? [{ id: 'co', label: t('co.title'), icon: 'card' as const, keys: 'o', run: () => go('/check-out') }] : []),
    ...(line && ((line.status === 'CHECKED_IN' && can('frontdesk.check_in')) || ((line.status === 'CONFIRMED' || line.status === 'OPTION') && can('reservation.modify'))) ? [{ id: 'mv', label: line.status === 'CHECKED_IN' ? t('d.moveRoom') : t('d.assignRoom'), icon: 'swap' as const, keys: 'm', run: () => openPanel('move') }] : []),
    ...(can('payment.take') ? [{ id: 'pay', label: t('pay.take'), icon: 'card' as const, keys: 'p', run: () => setDialog({ kind: 'pay' }) }] : []),
  ]);

  if (!r && stay.res.error) return <section><Banner level="BLOCKER" title={t('state.errorTitle')} action={<Link className="button" to="/today">{t('ws.backToday')}</Link>}>{stay.res.error.status === 404 ? t('ws.notFound') : stay.res.error.status === 403 ? t('err.PERMISSION_DENIED') : t('err.generic')}</Banner></section>;
  const inFlow = flow === 'check-in' || flow === 'check-out';
  const wa = r ? whatsappNumber(r.guest.phone) : null;

  return (
    <section className="ws" aria-labelledby="h-ws">
      <p className="crumbs"><Link to="/today">{t('nav.today')}</Link> <Icon name="chevron" size={14} /> <Link to="/reservations">{t('nav.reservations')}</Link> <Icon name="chevron" size={14} /> <span>{r?.confirmationNo ?? '…'}</span></p>
      <div className="page-head">
        <div><h1 id="h-ws">{r ? r.guest.fullName : t('common.loading')}{r?.guest.vip && <span className="vip" aria-label={t('q.vip')}> ★</span>}</h1>{r && <p className="muted">{r.confirmationNo} <ResStatus status={r.status} /></p>}</div>
        {r && line && !inFlow && (
          <div className="head-actions">
            {canIn && (can('frontdesk.check_in') ? <Link className="button primary" to={`${here}/check-in${lineQ}`}>{t('ci.title')} <kbd>C</kbd></Link> : <button className="primary" disabled title={t('perm.needFrontDesk')}>{t('ci.title')}</button>)}
            {canOut && (can('frontdesk.check_out') ? <Link className={`button${canIn ? '' : ' primary'}`} to={`${here}/check-out${lineQ}`}>{t('co.title')} <kbd>O</kbd></Link> : <button disabled title={t('perm.needFrontDesk')}>{t('co.title')}</button>)}
          </div>)}
      </div>
      {stay.offline && <Banner level="ACTION" title={t('state.staleTitle')}>{t('state.staleText')}</Banner>}
      {!inFlow && canIn && !can('frontdesk.check_in') && <Banner level="INFO" title={t('perm.needFrontDesk')}>{t('perm.askColleague')}</Banner>}
      <ConflictBanner stay={stay} />
      {!r ? <Skeleton rows={6} /> : (
        <div className="ws-grid">
          <div className="ws-main">
            {flow === 'check-in' && line ? <CheckIn stay={stay} /> : flow === 'check-out' && line ? <CheckOut stay={stay} /> : (<>
              {done && <Done stay={stay} kind={done} dismiss={() => setQuery({ done: null })} />}
              <BlockerBanners stay={stay} openPanel={(p) => openPanel(p)} onPay={() => setDialog({ kind: 'deposit' })} />
              <Tabs label={t('ws.sections')} value={tab} onChange={(x) => setQuery({ tab: x === 'overview' ? null : x })} tabs={[{ id: 'overview', label: t('ws.overview') }, ...(can('folio.view') ? [{ id: 'bill' as const, label: t('rs.tab.folio') }] : []), { id: 'timeline', label: t('ws.timeline') }]} />
              <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
                {tab === 'overview' && (<>
                  <section className="block" aria-labelledby="h-stay"><h2 id="h-stay">{t('ws.stayRooms')}</h2>
                    <ul className="plain">{r.lines.map((l) => <LineCard key={l.id} stay={stay} l={l} openPanel={openPanel} openDialog={setDialog} />)}</ul></section>
                  {r.guarantee.atRisk && !stay.blockers.some((b) => b.code === 'AT_RISK') && <Banner level="ACTION" title={t('rs.atRisk')} action={can('payment.take') ? <button onClick={() => setDialog({ kind: 'deposit' })}>{t('pay.k.DEPOSIT')}</button> : undefined}>{t('rs.depositNeeded')}: {money(r.guarantee.depositRequired)}</Banner>}
                  {r.penalty.amount.amount !== '0.00' && <Banner level="INFO" title={`${t('rs.penalty')}: ${money(r.penalty.amount)}${r.penalty.waived ? ` (${t('rs.waived')})` : ''}`} />}
                  <Notes r={r} onSaved={stay.refresh} />
                  <section className="block" aria-labelledby="h-msg"><h2 id="h-msg">{t('ws.messages')}</h2>
                    {r.guest.phone ? <p><a className="button" href={`tel:${r.guest.phone}`}><Icon name="user" size={16} /> {t('ws.call')}</a>{wa && <> <a className="button" target="_blank" rel="noreferrer" href={`https://wa.me/${wa}?text=${encodeURIComponent(t('wa.confirm', { name: r.guest.fullName, no: r.confirmationNo, from: r.lines[0]?.arrival ?? '', to: r.lines[0]?.departure ?? '', property: property!.name }))}`}>{t('wa.open')}</a></>}</p> : <Banner level="ACTION" title={t('ws.noPhone')}>{t('ws.noPhoneText')}</Banner>}
                    <p className="muted small">{t('ws.messagesNote')}</p></section>
                  <section className="block" aria-labelledby="h-tasks"><h2 id="h-tasks">{t('ws.tasks')}</h2>
                    {comp.data && <ComplianceNotes hits={comp.data.hits.map((h) => ({ name: h.rule, action: h.action, message: h.message, approved: h.approved }))} />}
                    {comp.data && comp.data.tasks.filter((x) => x.status === 'OPEN').map((x) => <p key={x.id} className="warnbox"><Icon name="clock" size={14} /> {x.title}</p>)}
                    {(!comp.data || (comp.data.hits.length === 0 && comp.data.tasks.every((x) => x.status !== 'OPEN'))) && <p className="muted small">{t('ws.noTasks')}</p>}
                  </section>
                </>)}
                {tab === 'bill' && <FolioPanel f={stay.folio.data} r={r} open={(kind, paymentId) => setDialog({ kind, paymentId })} onChanged={stay.refresh} />}
                {tab === 'timeline' && <Timeline r={r} />}
              </div>
            </>)}
          </div>
          <ContextRail stay={stay} />
        </div>)}

      {panel === 'move' && r && line && <MovePanel stay={stay} onClose={() => setQuery({ panel: null })} onDone={(kind) => { stay.settle(); setQuery({ panel: null, done: flow ? null : kind }); }} />}
      {r && (dialog?.kind === 'pay' || dialog?.kind === 'deposit') && <PaymentSheet asPanel reservationId={r.id} balance={stay.folio.data?.folio?.balance ?? null} defaultKind={dialog.kind === 'deposit' ? 'DEPOSIT' : 'PAYMENT'} onDone={stay.refresh} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'charge' && stay.folio.data?.folio && <ChargeSheet folioId={stay.folio.data.folio.id} onDone={stay.refresh} onClose={() => setDialog(null)} />}
      {r && (dialog?.kind === 'cancel' || dialog?.kind === 'noshow') && <CancelSheet r={r} line={line ?? undefined} noShow={dialog.kind === 'noshow'} onDone={stay.refresh} onClose={() => setDialog(null)} />}
      {dialog && (dialog.kind === 'void' || dialog.kind === 'refund') && dialog.paymentId && stay.folio.data && <PaymentFixSheet kind={dialog.kind} payment={stay.folio.data.payments.find((p) => p.id === dialog.paymentId)!} onDone={stay.refresh} onClose={() => setDialog(null)} />}
    </section>
  );
}
