import { useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAuth, useLive, useWork } from '../state.js';
import { Badge, Empty, ErrorLine, PriorityBadge, Sheet, Spinner } from '../ui/kit.js';

const CATEGORIES = ['PLUMBING', 'ELECTRICAL', 'AC', 'FURNITURE', 'APPLIANCE', 'CLEANLINESS', 'OTHER'] as const;
interface RoomOpt { id: string; number: string }
interface Issue { id: string; roomNumber: string | null; area: string | null; category: string; description: string; priority: number; reportedBy: string | null }

/** Report a problem. Works with no signal: the report waits on the phone and is sent later. */
export function ReportIssueSheet({ roomId, roomNumber, onClose }: { roomId?: string; roomNumber?: string; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const work = useWork();
  const base = `/v1/properties/${property!.id}/housekeeping`;
  const board = useLive<{ rooms: RoomOpt[] }>(roomId ? null : `${base}/board`, 600_000, `rooms-${property!.id}`);
  const [room, setRoom] = useState(roomId ?? ''); const [area, setArea] = useState(''); const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('OTHER');
  const [description, setDescription] = useState(''); const [priority, setPriority] = useState(3); const [err, setErr] = useState<string>(); const [sent, setSent] = useState(false);

  const send = async () => {
    if (description.trim().length < 3) { setErr('NOTE_REQUIRED'); return; }
    try {
      await work.run({ method: 'POST', path: `${base}/issues`, body: { ...(room ? { roomId: room } : { area: area.trim() }), category, description: description.trim(), priority }, effect: { kind: 'issue', roomId: room || undefined } });
      setSent(true); setTimeout(onClose, 900);
    } catch (e) { setErr(e instanceof ApiError ? e.code : 'generic'); }
  };
  return (
    <Sheet title={roomNumber ? `${t('common.room')} ${roomNumber} · ${t('issue.new')}` : t('issue.new')} onClose={onClose}>
      {!roomId && (
        <label>{t('issue.where')}
          <select value={room} onChange={(e) => setRoom(e.target.value)}>
            <option value="">{t('issue.area')}</option>
            {(board.data?.rooms ?? []).map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}
          </select>
        </label>
      )}
      {!room && !roomId && <label>{t('issue.area')}<input value={area} onChange={(e) => setArea(e.target.value)} /></label>}
      <label>{t('issue.category')}<select value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>{CATEGORIES.map((c) => <option key={c} value={c}>{t(`cat.${c}` as Key)}</option>)}</select></label>
      <label>{t('issue.description')}<textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label>{t('common.optional')} — {t('priority.1')}/{t('priority.3')}
        <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>{[1, 2, 3, 4].map((p) => <option key={p} value={p}>{t(`priority.${p}` as Key)}</option>)}</select>
      </label>
      <ErrorLine code={err} />
      {sent ? <p className="ok" role="status">{t('issue.sent')}</p> : <div className="actions"><button className="primary" onClick={send}>{t('issue.send')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>}
    </Sheet>
  );
}

export function Issues() {
  const { t } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/housekeeping`;
  const live = useLive<{ items: Issue[] }>(`${base}/issues?status=OPEN`, 30_000, `issues-${property!.id}`);
  const [open, setOpen] = useState(false); const [err, setErr] = useState<string>();
  const resolve = async (id: string) => { try { await api('POST', `${base}/issues/${id}/resolve`, {}); live.reload(); } catch (e) { setErr(e instanceof ApiError ? e.code : 'generic'); } };
  return (
    <section>
      <div className="row between"><h2>{t('issue.title')}</h2>{can('housekeeping.update') && <button className="primary small" onClick={() => setOpen(true)}>{t('issue.new')}</button>}</div>
      <ErrorLine code={err} />
      {live.loading && !live.data ? <Spinner /> : (live.data?.items.length ?? 0) === 0 ? <Empty text={t('issue.empty')} /> : (
        <ul className="cards">{live.data!.items.map((i) => (
          <li key={i.id} className="card">
            <div className="row between"><strong>{i.roomNumber ? `${t('common.room')} ${i.roomNumber}` : i.area}</strong><div className="row"><Badge tone="neutral">{t(`cat.${i.category}` as Key)}</Badge><PriorityBadge p={i.priority} /></div></div>
            <p>{i.description}</p>
            {can('housekeeping.assign') && <div className="actions"><button onClick={() => resolve(i.id)}>{t('issue.resolve')}</button></div>}
          </li>))}
        </ul>
      )}
      {open && <ReportIssueSheet onClose={() => { setOpen(false); live.reload(); }} />}
    </section>
  );
}
