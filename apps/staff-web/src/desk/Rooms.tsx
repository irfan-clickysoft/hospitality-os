import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAction } from '../lib/action.js';
import { useAuth, useLive } from '../state.js';
import { Badge, ErrorLine, Sheet, Spinner } from '../ui/kit.js';

interface Room { id: string; number: string; roomTypeId: string; floorId: string | null; bedConfig: string | null; smoking: boolean; accessible: boolean; status: 'ACTIVE' | 'INACTIVE'; notes: string | null; version: number }
interface RoomType { id: string; code: string; name: string; status: string }
interface Floor { id: string; name: string; sortOrder: number }
const NUMBER = /^[A-Za-z0-9][A-Za-z0-9 -]{0,11}$/;

/** The rooms of the property: their numbers, types and floors, corrected or added by whoever manages the property. */
export function Rooms() {
  const { t } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const rooms = useLive<{ items: Room[] }>(`${base}/rooms`, 60_000);
  const types = useLive<{ items: RoomType[] }>(`${base}/room-types`, 120_000);
  const structure = useLive<{ floors: Floor[] }>(`${base}/structure`, 120_000);
  const [edit, setEdit] = useState<Room | 'new' | null>(null);
  if (!rooms.data || !types.data || !structure.data) return <Spinner />;
  const type = (id: string) => types.data!.items.find((x) => x.id === id);
  const floors = [...structure.data.floors, { id: '', name: t('rm.noFloor'), sortOrder: 999 }];
  const manage = can('property.manage');
  return (
    <section className="stack">
      <h2>{t('nav.rooms')}</h2>
      {manage && <div className="actions"><button className="primary" onClick={() => setEdit('new')}>{t('rm.add')}</button></div>}
      {floors.map((f) => { const here = rooms.data!.items.filter((r) => (r.floorId ?? '') === f.id); return here.length === 0 ? null : (
        <div key={f.id} className="stack"><h3>{f.name}</h3>
          <ul className="plain">{here.map((r) => (
            <li key={r.id} className={`card inner row between${r.status === 'INACTIVE' ? ' struck' : ''}`}>
              <span><strong>{r.number}</strong> · {type(r.roomTypeId)?.name ?? ''}{r.notes ? <span className="muted"> — {r.notes}</span> : null}</span>
              <span className="row">{r.status === 'INACTIVE' && <Badge tone="neutral">{t('rm.retired')}</Badge>}{manage && <button className="link" onClick={() => setEdit(r)}>{t('rm.edit')}</button>}</span>
            </li>))}</ul></div>); })}
      {edit && <EditRoom base={base} room={edit === 'new' ? null : edit} types={types.data.items.filter((x) => x.status === 'ACTIVE')} floors={structure.data.floors} onDone={() => { setEdit(null); rooms.reload(); }} onClose={() => setEdit(null)} />}
    </section>
  );
}

function EditRoom({ base, room, types, floors, onDone, onClose }: { base: string; room: Room | null; types: RoomType[]; floors: Floor[]; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const [f, setF] = useState({ number: room?.number ?? '', roomTypeId: room?.roomTypeId ?? types[0]?.id ?? '', floorId: room?.floorId ?? '', notes: room?.notes ?? '', accessible: room?.accessible ?? false, smoking: room?.smoking ?? false, active: (room?.status ?? 'ACTIVE') === 'ACTIVE' });
  const { busy, problem, run } = useAction();
  const go = async () => {
    const body = { number: f.number.trim(), roomTypeId: f.roomTypeId, floorId: f.floorId || null, notes: f.notes.trim() || null, accessible: f.accessible, smoking: f.smoking };
    const r = await run(() => room ? api('PATCH', `${base}/rooms/${room.id}`, { ...body, status: f.active ? 'ACTIVE' : 'INACTIVE', version: room.version }) : api('POST', `${base}/rooms`, body));
    if (r) onDone();
  };
  return (
    <Sheet title={room ? `${t('rm.edit')} · ${room.number}` : t('rm.add')} onClose={onClose}>
      <label>{t('rm.number')}<input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} dir="ltr" /></label>
      <label>{t('rm.type')}<select value={f.roomTypeId} onChange={(e) => setF({ ...f, roomTypeId: e.target.value })}>{types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label>{t('rm.floor')}<select value={f.floorId} onChange={(e) => setF({ ...f, floorId: e.target.value })}><option value="">—</option>{floors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label>{t('common.note')}<input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
      <label className="row"><input type="checkbox" checked={f.accessible} onChange={(e) => setF({ ...f, accessible: e.target.checked })} /> {t('rm.accessible')}</label>
      <label className="row"><input type="checkbox" checked={f.smoking} onChange={(e) => setF({ ...f, smoking: e.target.checked })} /> {t('rm.smoking')}</label>
      {room && <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> {t('rm.inUse')}</label>}
      <p className="muted small">{t('rm.note')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || !NUMBER.test(f.number.trim()) || !f.roomTypeId} onClick={go}>{t('rm.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}
