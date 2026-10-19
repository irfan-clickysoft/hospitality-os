import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth, useLive } from '../state.js';
import type { FolioView, Line, RackData, RackRoom, ReservationDetail } from '../desk/types.js';
import type { Blocker } from './Today.js';

interface TodayRow { reservationId: string; lineId: string; blockers: Blocker[] }
interface TodayData { businessDate: string; arrivals: TodayRow[]; departures: TodayRow[] }

/** What was true when the person started this piece of work. If the live record stops matching it, someone else changed it. */
interface Baseline { version: number; lines: Record<string, { status: string; roomId: string | null; version: number }> }
const snap = (r: ReservationDetail): Baseline => ({ version: r.version, lines: Object.fromEntries(r.lines.map((l) => [l.id, { status: l.status, roomId: l.assignedRoom?.id ?? null, version: l.version }])) });

export interface Changed { kind: 'status' | 'room' | 'other'; lineId?: string; status?: string; room?: string | null }

/**
 * Everything the reservation workspace and its workflows share: the live record, its bill, the room's housekeeping state and the blockers the server worked out.
 * `changes` lists what moved underneath the person since they started (or last pressed "Review"), so a stale screen can never submit silently.
 */
export function useStay(reservationId: string, lineParam: string | null) {
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const res = useLive<ReservationDetail>(`${base}/reservations/${reservationId}`, 10_000);
  const folio = useLive<FolioView>(can('folio.view') ? `${base}/reservations/${reservationId}/folio` : null, 15_000);
  const rack = useLive<RackData>(`${base}/rack?days=1`, 15_000, `rack1-${property!.id}`);
  const today = useLive<TodayData>(can('reservation.view') ? `${base}/today` : null, 15_000, `today-${property!.id}`);
  const r = res.data;
  const businessDate = today.data?.businessDate ?? rack.data?.businessDate ?? property!.businessDate;

  const line: Line | null = useMemo(() => {
    if (!r) return null;
    return r.lines.find((l) => l.id === lineParam) ?? r.lines.find((l) => l.allowedActions.includes('CHECK_OUT')) ?? r.lines.find((l) => l.allowedActions.includes('CHECK_IN')) ?? r.lines.find((l) => l.status !== 'CANCELLED') ?? r.lines[0] ?? null;
  }, [r, lineParam]);
  const room: RackRoom | null = useMemo(() => (line?.assignedRoom ? rack.data?.rooms.find((x) => x.id === line.assignedRoom!.id) ?? null : null), [line, rack.data]);
  const blockers: Blocker[] = useMemo(() => {
    if (!line || !today.data) return [];
    return [...today.data.arrivals, ...today.data.departures].find((x) => x.lineId === line.id)?.blockers ?? [];
  }, [line, today.data]);

  const baseline = useRef<Baseline | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { if (r && !baseline.current) baseline.current = snap(r); }, [r]);
  const changes: Changed[] = useMemo(() => {
    const b = baseline.current; if (!r || !b) return [];
    const out: Changed[] = [];
    for (const l of r.lines) {
      const was = b.lines[l.id]; if (!was) continue;
      if (was.status !== l.status) out.push({ kind: 'status', lineId: l.id, status: l.status });
      else if (was.roomId !== (l.assignedRoom?.id ?? null)) out.push({ kind: 'room', lineId: l.id, room: l.assignedRoom?.number ?? null });
      else if (was.version !== l.version || b.version !== r.version) out.push({ kind: 'other', lineId: l.id });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r, tick]);
  /** Accept what changed: it becomes the new starting point. */
  const acknowledge = useCallback(() => { if (res.data) baseline.current = snap(res.data); setTick((n) => n + 1); }, [res.data]);
  const refresh = useCallback(() => { res.reload(); folio.reload(); rack.reload(); today.reload(); }, [res, folio, rack, today]);
  /** For our own successful actions: reload and make the server's answer the new baseline, so we never report our own change as someone else's. */
  const settle = useCallback((next?: ReservationDetail) => { baseline.current = next && Array.isArray(next.lines) ? snap(next) : null; setTick((n) => n + 1); refresh(); }, [refresh]);

  return { res, r, line, folio, rack, room, blockers, businessDate, changes, acknowledge, refresh, settle, offline: res.offline };
}
export type Stay = ReturnType<typeof useStay>;
