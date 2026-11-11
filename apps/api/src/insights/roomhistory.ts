import { sql } from 'kysely';
import type { Def, Row } from './types.js';
import { local } from './util.js';

const HK: Record<string, string> = { CLEAN: 'Clean', DIRTY: 'Dirty', CLEANING: 'Being cleaned', INSPECTED: 'Inspected' };
const READY = new Set(['CLEAN', 'INSPECTED']);
const mins = (ms: number) => Math.max(0, Math.round(ms / 60_000));
const hhmm = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

export const roomHistory: Def = {
  id: 'room-status-history', name: 'Room-status history and cleaning time', category: 'rooms', kind: 'audit', permissions: ['housekeeping.view', 'report.view'], roles: ['housekeeping', 'manager'],
  purpose: 'Every change of a room’s housekeeping state, who made it and why; how long rooms stay dirty before they are clean again; and rooms that are vacant and still not ready.',
  basis: [{ id: 'when', label: 'Date of the change' }], range: 'today',
  params: [{ key: 'group', label: 'Show', default: 'list', options: [{ value: 'list', label: 'Every change' }, { value: 'room', label: 'By room' }, { value: 'turnaround', label: 'Dirty to clean (turnaround)' }, { value: 'stale', label: 'Not ready now, vacant' }] }],
  definitions: [{ term: 'Change', text: 'A room moving between dirty, being cleaned, clean and inspected. Recorded from the day this report was introduced: earlier changes are not available.' }, { term: 'Turnaround', text: 'Minutes from the room becoming dirty to it next being marked clean or inspected, when both happened in the period.' }, { term: 'By', text: 'The person who made the change. “System” means it was set automatically, for example when a guest checked out.' }, { term: 'Not ready now', text: 'Vacant rooms that are dirty or being cleaned right now, and for how long. A room with a guest in it is not listed.' }],
  async run(c) {
    const g = c.params.group ?? 'list';
    if (g === 'stale') {
      const r = await sql<Record<string, any>>`SELECT rm.number, rt.name AS rtype, rm.hk_status AS hk, rm.hk_updated_at AS since, ${local(sql.raw('rm.hk_updated_at'), c)} AS since_l, extract(epoch FROM (now() - rm.hk_updated_at))*1000 AS ms
        FROM room rm JOIN room_type rt ON rt.id = rm.room_type_id WHERE rm.tenant_id = ${c.tenantId} AND rm.property_id = ${c.propertyId} AND rm.status = 'ACTIVE' AND rm.hk_status IN ('DIRTY','CLEANING')
          AND NOT EXISTS (SELECT 1 FROM room_assignment a WHERE a.room_id = rm.id AND a.status = 'IN_HOUSE') ORDER BY rm.hk_updated_at NULLS FIRST`.execute(c.trx);
      const rows: Row[] = r.rows.map((x): Row => { const m = x.since ? mins(Number(x.ms)) : null; return { room: x.number, rtype: x.rtype, hk: HK[x.hk] ?? x.hk, since: x.since_l ?? '', waiting: m == null ? '' : hhmm(m), state: m != null && m > 240 ? 'Over 4 hours' : '' }; });
      return { kpis: [{ key: 'n', label: 'Vacant, not ready', value: rows.length, type: 'int', tone: rows.length ? 'warn' : 'ok', definition: 'Vacant rooms that are dirty or being cleaned.' }, { key: 'old', label: 'Over 4 hours', value: rows.filter((x) => x.state).length, type: 'int', tone: rows.some((x) => x.state) ? 'bad' : 'ok', definition: 'Not ready for more than four hours.' }],
        columns: [{ key: 'room', label: 'Room' }, { key: 'rtype', label: 'Type', hidden: true }, { key: 'hk', label: 'State', type: 'badge' }, { key: 'since', label: 'Since', type: 'datetime' }, { key: 'waiting', label: 'For' }, { key: 'state', label: '', type: 'badge' }], rows };
    }
    const r = await sql<Record<string, any>>`SELECT e.room_id AS rid, rm.number, rt.name AS rtype, e.from_status AS f, e.to_status AS t, e.reason, e.occurred_at AS ts, ${local(sql.raw('e.occurred_at'), c)} AS at, u.full_name AS who
      FROM room_status_event e JOIN room rm ON rm.id = e.room_id JOIN room_type rt ON rt.id = rm.room_type_id LEFT JOIN staff_user u ON u.id = e.actor_id
      WHERE e.tenant_id = ${c.tenantId} AND e.property_id = ${c.propertyId} AND (e.occurred_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY e.occurred_at, e.id`.execute(c.trx);
    const ev = r.rows;
    // turnaround: each time a room became dirty, the next time it was marked clean or inspected
    const open = new Map<string, { ts: Date; at: string }>(); const turns: Array<{ room: string; rtype: string; from: string; to: string; mins: number; by: string }> = [];
    for (const x of ev) {
      if (x.t === 'DIRTY') { if (!open.has(x.rid)) open.set(x.rid, { ts: new Date(x.ts), at: x.at }); }
      else if (READY.has(x.t) && open.has(x.rid)) { const o = open.get(x.rid)!; turns.push({ room: x.number, rtype: x.rtype, from: o.at, to: x.at, mins: mins(new Date(x.ts).getTime() - o.ts.getTime()), by: x.who ?? 'System' }); open.delete(x.rid); }
    }
    const sorted = turns.map((t) => t.mins).sort((a, b) => a - b); const avg = sorted.length ? Math.round(sorted.reduce((s, y) => s + y, 0) / sorted.length) : 0; const med = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
    const kp = [{ key: 'n', label: 'Changes', value: ev.length, type: 'int' as const, definition: 'Room state changes in the period.' }, { key: 'rooms', label: 'Rooms involved', value: new Set(ev.map((x) => x.rid)).size, type: 'int' as const, definition: 'Different rooms.' }, { key: 'avg', label: 'Average dirty to clean (min)', value: avg, type: 'int' as const, definition: 'Mean minutes from dirty to clean, where both are in the period.' }, { key: 'med', label: 'Median (min)', value: med, type: 'int' as const, definition: 'The middle turnaround.' }];
    if (g === 'turnaround') return { kpis: kp, columns: [{ key: 'room', label: 'Room' }, { key: 'rtype', label: 'Type', hidden: true }, { key: 'from', label: 'Became dirty', type: 'datetime' }, { key: 'to', label: 'Marked clean', type: 'datetime' }, { key: 'time', label: 'Took' }, { key: 'm', label: 'Minutes', type: 'int' }, { key: 'by', label: 'Cleaned by' }], rows: turns.map((t): Row => ({ room: t.room, rtype: t.rtype, from: t.from, to: t.to, time: hhmm(t.mins), m: t.mins, by: t.by })), notes: ['Rooms still dirty at the end of the period are not counted: see “Not ready now”.'] };
    if (g === 'room') {
      const map = new Map<string, { n: number; dirty: number; last: string; hk: string }>(); const tmap = new Map<string, number[]>(); for (const t of turns) tmap.set(t.room, [...(tmap.get(t.room) ?? []), t.mins]);
      for (const x of ev) { const e = map.get(x.number) ?? { n: 0, dirty: 0, last: '', hk: '' }; e.n++; if (x.t === 'DIRTY') e.dirty++; e.last = x.at; e.hk = x.t; map.set(x.number, e); }
      return { kpis: kp, columns: [{ key: 'room', label: 'Room' }, { key: 'n', label: 'Changes', type: 'int', total: true }, { key: 'dirty', label: 'Times dirty', type: 'int', total: true }, { key: 'avg', label: 'Avg dirty to clean (min)', type: 'text' }, { key: 'last', label: 'Last change', type: 'datetime' }, { key: 'hk', label: 'Last state', type: 'badge' }],
        rows: [...map.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, e]): Row => { const t = tmap.get(k); return { room: k, n: e.n, dirty: e.dirty, avg: t?.length ? String(Math.round(t.reduce((s, y) => s + y, 0) / t.length)) : '', last: e.last, hk: HK[e.hk] ?? e.hk }; }) };
    }
    return { kpis: kp, columns: [{ key: 'at', label: 'When', type: 'datetime' }, { key: 'room', label: 'Room' }, { key: 'rtype', label: 'Type', hidden: true }, { key: 'from', label: 'From' }, { key: 'to', label: 'To', type: 'badge' }, { key: 'who', label: 'By' }, { key: 'reason', label: 'Reason' }],
      rows: [...ev].reverse().map((x): Row => ({ at: x.at, room: x.number, rtype: x.rtype, from: x.f ? HK[x.f] ?? x.f : '', to: HK[x.t] ?? x.t, who: x.who ?? 'System', reason: x.reason ?? '' })), notes: ['Changes made before this report existed were not recorded.'] };
  },
};
