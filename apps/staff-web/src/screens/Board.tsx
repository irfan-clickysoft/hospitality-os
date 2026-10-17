import { useMemo, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, ErrorLine, HkBadge, PriorityBadge, Sheet, Spinner } from '../ui/kit.js';

interface BoardTask { id: string; type: string; priority: number; status: string; assignee: { id: string; name: string | null } | null; inspection: string | null; reworkCount: number; notes: string | null }
interface BoardRoom { id: string; number: string; type: string; floor: string | null; hkStatus: string; dnd: boolean; occupancy: string; departingToday: boolean; arrivingToday: boolean; vipArrival: boolean; tasks: BoardTask[] }
interface BoardData {
  businessDate: string; requireInspection: boolean; rooms: BoardRoom[];
  summary: { byStatus: Record<string, number>; openTasks: number; unassigned: number; awaitingInspection: number; doneToday: number; avgMinutesPerRoom: number | null };
  workload: Array<{ userId: string; name: string | null; tasks: number; credits: number; done: number }>;
}
type Filter = 'ALL' | 'DIRTY' | 'CLEANING' | 'CLEAN' | 'INSPECTED' | 'UNASSIGNED' | 'INSPECT';

export function Board() {
  const { t } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/housekeeping`;
  const live = useLive<BoardData>(`${base}/board`, 20_000, `board-${property!.id}`);
  const team = useLive<{ items: Array<{ id: string; name: string }> }>(can('housekeeping.assign') ? `${base}/attendants` : null, 300_000, `team-${property!.id}`);
  const sup = can('housekeeping.assign');
  const [filter, setFilter] = useState<Filter>('ALL'); const [sel, setSel] = useState<Set<string>>(new Set()); const [selecting, setSelecting] = useState(false);
  const [room, setRoom] = useState<BoardRoom | null>(null); const [assignOpen, setAssignOpen] = useState(false); const [err, setErr] = useState<string>(); const [msg, setMsg] = useState<string>();
  const [failFor, setFailFor] = useState<string | null>(null); const [failNote, setFailNote] = useState('');

  const rooms = useMemo(() => (live.data?.rooms ?? []).filter((r) => {
    if (filter === 'ALL') return true;
    if (filter === 'UNASSIGNED') return r.tasks.some((x) => x.status === 'PENDING' && !x.assignee);
    if (filter === 'INSPECT') return r.tasks.some((x) => x.status === 'DONE' && x.inspection === 'PENDING');
    return r.hkStatus === filter;
  }), [live.data, filter]);
  const current = room ? live.data?.rooms.find((r) => r.id === room.id) ?? room : null;

  const call = async (fn: () => Promise<unknown>) => { setErr(undefined); try { await fn(); live.reload(); } catch (e) { setErr(e instanceof ApiError ? e.code : 'generic'); } };
  const generate = () => call(async () => { const r = await api<{ stayovers: number; arrivalPrep: number; deepClean: number }>('POST', `${base}/generate`, {}); setMsg(t('board.generated', { a: r.stayovers, b: r.arrivalPrep, c: r.deepClean })); });
  const assignTo = (assigneeId: string) => call(async () => {
    const ids = [...sel].flatMap((rid) => live.data!.rooms.find((r) => r.id === rid)?.tasks.filter((x) => x.status === 'PENDING').map((x) => x.id) ?? []);
    if (ids.length) await api('POST', `${base}/tasks/assign`, { taskIds: ids, assigneeId });
    setSel(new Set()); setSelecting(false); setAssignOpen(false);
  });
  const tap = (r: BoardRoom) => { if (selecting) { const n = new Set(sel); n.has(r.id) ? n.delete(r.id) : n.add(r.id); setSel(n); } else setRoom(r); };
  const s = live.data?.summary;

  return (
    <section>
      <div className="row between"><h2>{t('board.title')}</h2><button className="link" onClick={live.reload}>{t('common.refresh')}</button></div>
      {live.data && <p className="muted small">{t('property.businessDate')}: {live.data.businessDate}{s?.avgMinutesPerRoom ? ` · ${t('board.avg', { n: s.avgMinutesPerRoom })}` : ''}</p>}
      <ErrorLine code={err} />{msg && <p className="ok" role="status">{msg}</p>}
      {!live.data ? <Spinner /> : (<>
        <div className="chips" role="group">
          <Chip active={filter === 'ALL'} onClick={() => setFilter('ALL')}>{t('board.filter.all')} {live.data.rooms.length}</Chip>
          {(['DIRTY', 'CLEANING', 'CLEAN', 'INSPECTED'] as const).map((k) => <Chip key={k} active={filter === k} onClick={() => setFilter(k)}>{t(`hk.${k}` as Key)} {s!.byStatus[k] ?? 0}</Chip>)}
          <Chip active={filter === 'UNASSIGNED'} onClick={() => setFilter('UNASSIGNED')}>{t('board.unassigned')} {s!.unassigned}</Chip>
          {live.data.requireInspection && <Chip active={filter === 'INSPECT'} onClick={() => setFilter('INSPECT')}>{t('board.awaiting')} {s!.awaitingInspection}</Chip>}
        </div>
        {sup && (
          <div className="actions">
            <button onClick={generate}>{t('board.generate')}</button>
            <button className={selecting ? 'primary' : ''} onClick={() => { setSelecting(!selecting); setSel(new Set()); }}>{t('board.selectMode')}</button>
            {selecting && sel.size > 0 && <button className="primary" onClick={() => setAssignOpen(true)}>{t('board.assign')} ({sel.size})</button>}
          </div>
        )}
        <ul className="tiles">
          {rooms.map((r) => {
            const open = r.tasks.find((x) => x.status !== 'DONE' || x.inspection === 'PENDING');
            return (
              <li key={r.id}>
                <button className={`tile ${r.hkStatus.toLowerCase()}${sel.has(r.id) ? ' selected' : ''}${r.occupancy.startsWith('OUT') ? ' ooo' : ''}`} onClick={() => tap(r)} aria-label={`${t('common.room')} ${r.number} ${t(`hk.${r.hkStatus}` as Key)}`}>
                  <span className="tile-no">{r.number}</span>
                  <span className="tile-st">{t(`hk.${r.hkStatus}` as Key)}</span>
                  <span className="tile-meta">
                    {r.occupancy === 'OCCUPIED' ? '●' : r.occupancy.startsWith('OUT') ? '✕' : '○'}{r.departingToday ? ' ↑' : ''}{r.arrivingToday ? ' ↓' : ''}{r.vipArrival ? ' ★' : ''}{r.dnd ? ' ☾' : ''}
                  </span>
                  {open && <span className="tile-who">{open.assignee?.name?.split(' ')[0] ?? '—'}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {live.data.workload.length > 0 && (
          <div className="card"><h3>{t('board.team')}</h3>
            <ul className="plain">{live.data.workload.map((w) => <li key={w.userId} className="row between"><span>{w.name}</span><span className="muted">{w.done}/{w.tasks} · {t('board.credits', { n: w.credits })}</span></li>)}</ul>
          </div>
        )}
      </>)}

      {current && (
        <Sheet title={`${t('common.room')} ${current.number}`} onClose={() => setRoom(null)}>
          <div className="row"><HkBadge status={current.hkStatus} /><Badge tone="neutral">{t(`occ.${current.occupancy}` as Key)}</Badge>{current.dnd && <Badge tone="warn">{t('room.dnd')}</Badge>}{current.arrivingToday && <Badge tone="neutral">{t('room.arriving')}</Badge>}{current.departingToday && <Badge tone="neutral">{t('room.departing')}</Badge>}{current.vipArrival && <Badge tone="urgent">{t('room.vip')}</Badge>}</div>
          <ErrorLine code={err} />
          {current.tasks.length === 0 && <p className="muted">{t('common.none')}</p>}
          {current.tasks.map((x) => (
            <div key={x.id} className="card inner">
              <div className="row between"><strong>{t(`task.${x.type}` as Key)}</strong><PriorityBadge p={x.priority} /></div>
              <p className="small">{t(`task.status.${x.status}` as Key)} · {x.assignee?.name ?? t('task.unassigned')}{x.reworkCount ? ` · ↻${x.reworkCount}` : ''}</p>
              {x.notes && <p className="small">{x.notes}</p>}
              {sup && x.status === 'DONE' && x.inspection === 'PENDING' && (failFor === x.id ? (
                <div className="stack"><label>{t('board.failNote')}<input value={failNote} onChange={(e) => setFailNote(e.target.value)} autoFocus /></label>
                  <div className="actions"><button className="primary" onClick={() => call(async () => { await api('POST', `${base}/tasks/${x.id}/inspect`, { pass: false, note: failNote }); setFailFor(null); setFailNote(''); })}>{t('board.fail')}</button><button onClick={() => setFailFor(null)}>{t('common.cancel')}</button></div></div>
              ) : <div className="actions"><button className="primary" onClick={() => call(() => api('POST', `${base}/tasks/${x.id}/inspect`, { pass: true }))}>{t('board.pass')}</button><button onClick={() => setFailFor(x.id)}>{t('board.fail')}</button></div>)}
              {sup && (x.status === 'PENDING' || x.status === 'IN_PROGRESS') && <div className="actions"><button className="link" onClick={() => call(() => api('POST', `${base}/tasks/${x.id}/cancel`, { reason: 'Cancelled by supervisor' }))}>{t('board.cancelTask')}</button></div>}
            </div>
          ))}
          {sup && <div className="actions">
            <button onClick={() => call(() => api('POST', `${base}/tasks`, { roomId: current.id }))}>{t('board.newTask')}</button>
            {(['DIRTY', 'CLEAN', 'INSPECTED'] as const).filter((k) => k !== current.hkStatus).map((k) => <button key={k} className="link" onClick={() => call(() => api('PUT', `${base}/rooms/${current.id}/status`, { status: k }))}>{t('board.override')}: {t(`hk.${k}` as Key)}</button>)}
          </div>}
          {can('housekeeping.update') && <div className="actions"><button onClick={() => call(() => api('PUT', `${base}/rooms/${current.id}/dnd`, { dnd: !current.dnd }))}>{current.dnd ? t('act.dndOff') : t('act.dndOn')}</button></div>}
        </Sheet>
      )}
      {assignOpen && (
        <Sheet title={t('board.assignTo', { n: sel.size })} onClose={() => setAssignOpen(false)}>
          <ul className="plain">{(team.data?.items ?? []).map((m) => <li key={m.id}><button className="wide" onClick={() => assignTo(m.id)}>{m.name}</button></li>)}</ul>
        </Sheet>
      )}
    </section>
  );
}
