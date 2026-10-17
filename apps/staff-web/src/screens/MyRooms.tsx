import { useMemo, useState } from 'react';
import { applyPending } from '../api/queue.js';
import { ApiError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAuth, useLive, useWork } from '../state.js';
import { Badge, Empty, ErrorLine, HkBadge, PriorityBadge, Sheet, Spinner } from '../ui/kit.js';
import { ReportIssueSheet } from './Issues.js';

interface Task { id: string; roomId: string; roomNumber: string; floor: string | null; dnd: boolean; type: string; priority: number; status: string; notes: string | null; inspection: string | null; inspectionNote: string | null; reworkCount: number }

export function MyRooms() {
  const { t } = useT();
  const { property, can } = useAuth();
  const work = useWork();
  const [showDone, setShowDone] = useState(false);
  const base = `/v1/properties/${property!.id}/housekeeping`;
  const live = useLive<{ items: Task[] }>(`${base}/my-tasks?includeDone=${showDone}`, 20_000, `my-${property!.id}-${showDone}`);
  const [err, setErr] = useState<string>(); const [skipFor, setSkipFor] = useState<Task | null>(null); const [reason, setReason] = useState(''); const [reportFor, setReportFor] = useState<Task | null>(null);

  const items = useMemo(() => applyPending(live.data?.items ?? [], work.pending), [live.data, work.pending]);
  const cleaningNow = items.find((i) => i.status === 'IN_PROGRESS');

  const act = async (task: Task, kind: 'start' | 'finish' | 'release', extra: Record<string, unknown> = {}) => {
    setErr(undefined);
    try {
      const body = kind === 'release' ? {} : { at: new Date().toISOString(), ...extra };
      await work.run({ method: 'POST', path: `${base}/tasks/${task.id}/${kind}`, body, effect: { kind, taskId: task.id } });
      live.reload();
    } catch (e) { setErr(e instanceof ApiError ? e.code : 'generic'); live.reload(); }
  };
  const skip = async () => {
    if (!skipFor || reason.trim().length < 3) { setErr('NOTE_REQUIRED'); return; }
    await work.run({ method: 'POST', path: `${base}/tasks/${skipFor.id}/skip`, body: { reason: reason.trim(), at: new Date().toISOString() }, effect: { kind: 'skip', taskId: skipFor.id } }).catch((e) => setErr(e instanceof ApiError ? e.code : 'generic'));
    setSkipFor(null); setReason(''); live.reload();
  };
  const toggleDnd = async (task: Task) => {
    try { await work.run({ method: 'PUT', path: `${base}/rooms/${task.roomId}/dnd`, body: { dnd: !task.dnd }, effect: { kind: 'dnd', roomId: task.roomId, dnd: !task.dnd } }); live.reload(); } catch (e) { setErr(e instanceof ApiError ? e.code : 'generic'); }
  };

  return (
    <section>
      <div className="row between"><h2>{t('my.title')}</h2><button className="link" onClick={live.reload}>{t('common.refresh')}</button></div>
      <label className="check"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> {t('my.showDone')}</label>
      <ErrorLine code={err} />
      {live.loading && !live.data ? <Spinner /> : items.length === 0 ? <Empty text={t('my.empty')} /> : (
        <ul className="cards">
          {items.map((i) => (
            <li key={i.id} className={`card task p${i.priority}${i.status === 'IN_PROGRESS' ? ' active' : ''}`}>
              <div className="row between">
                <div><div className="room-no">{i.roomNumber}</div>{i.floor && <div className="muted small">{i.floor}</div>}</div>
                <div className="stack end">
                  <Badge tone={i.status === 'IN_PROGRESS' ? 'cleaning' : i.status === 'DONE' ? 'clean' : 'neutral'}>{t(`task.status.${i.status}` as Key)}</Badge>
                  <PriorityBadge p={i.priority} />
                </div>
              </div>
              <p className="task-type">{t(`task.${i.type}` as Key)}</p>
              {i.dnd && <p><Badge tone="warn">{t('room.dnd')}</Badge></p>}
              {i.notes && <p className="small">{i.notes}</p>}
              {i.reworkCount > 0 && i.inspectionNote && <p className="rework">{t('task.rework', { note: i.inspectionNote })}</p>}
              {i.status === 'DONE' && i.inspection === 'PENDING' && <p className="muted small">{t('task.awaitingInspection')}</p>}
              <div className="actions">
                {i.status === 'PENDING' && <button className="primary" disabled={!!cleaningNow} onClick={() => act(i, 'start')}>{t('act.start')}</button>}
                {i.status === 'IN_PROGRESS' && <button className="primary" onClick={() => act(i, 'finish')}>{t('act.finish')}</button>}
                {i.status === 'IN_PROGRESS' && <button onClick={() => act(i, 'release')}>{t('act.release')}</button>}
                {(i.type === 'STAYOVER' || i.type === 'ON_DEMAND') && (i.status === 'PENDING' || i.status === 'IN_PROGRESS') && <button onClick={() => { setSkipFor(i); setErr(undefined); }}>{t('act.skip')}</button>}
                {(i.status === 'PENDING' || i.status === 'IN_PROGRESS') && i.type === 'STAYOVER' && <button onClick={() => toggleDnd(i)}>{i.dnd ? t('act.dndOff') : t('act.dndOn')}</button>}
                {can('housekeeping.update') && <button className="link" onClick={() => setReportFor(i)}>{t('act.report')}</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {skipFor && (
        <Sheet title={`${skipFor.roomNumber} · ${t('act.skip')}`} onClose={() => setSkipFor(null)}>
          <label>{t('act.skipReason')}<input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></label>
          <ErrorLine code={err} />
          <div className="actions"><button className="primary" onClick={skip}>{t('act.confirm')}</button><button onClick={() => setSkipFor(null)}>{t('common.cancel')}</button></div>
        </Sheet>
      )}
      {reportFor && <ReportIssueSheet roomId={reportFor.roomId} roomNumber={reportFor.roomNumber} onClose={() => setReportFor(null)} />}
      {live.error && <ErrorLine code={live.error.code} />}
      <p className="muted small legend">{['DIRTY', 'CLEANING', 'CLEAN', 'INSPECTED'].map((s) => <HkBadge key={s} status={s} />)}</p>
    </section>
  );
}
