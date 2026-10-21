import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { clock12 } from '../lib/confirmation.js';
import { shortDate } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { StatusBadge } from '../ui/ds.js';
import { Empty, ErrorLine } from '../ui/kit.js';
import { Link } from '../shell/router.js';

interface Item { id: string; reservationId: string; confirmationNo: string; guestName: string; kind: string; neededOn: string | null; neededTime: string | null; flightNo: string | null; passengers: number | null; note: string | null; status: string; staffNote: string | null; createdAt: string }

/** What guests have asked for from their booking page: airport transfers, ground floor, wheelchair access and so on. Each one is answered here and the guest sees the answer. */
export function GuestRequests() {
  const { t, locale } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const [all, setAll] = useState(false);
  const list = useLive<{ items: Item[] }>(`${base}/guest-requests?status=${all ? 'ALL' : 'OPEN'}`, 20_000);
  const items = list.data?.items ?? [];
  return (
    <div className="stack">
      <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t('gr.showAll')}</label>
      {list.data && items.length === 0 && <Empty text={t('gr.none')} />}
      <ul className="plain">{items.map((q) => <Row key={q.id} q={q} base={base} canAnswer={can('reservation.modify')} onDone={list.reload} locale={locale} />)}</ul>
    </div>
  );

}

function Row({ q, base: b, canAnswer, onDone, locale: loc }: { q: Item; base: string; canAnswer: boolean; onDone: () => void; locale: 'en' | 'ur' }) {
  const { t } = useT(); const [note, setNote] = useState(q.staffNote ?? ''); const { busy, problem, run } = useAction();
  const act = async (status: 'ACKNOWLEDGED' | 'DONE' | 'DECLINED') => { if (await run(() => api('PATCH', `${b}/guest-requests/${q.id}`, { status, ...(note.trim() ? { staffNote: note.trim() } : {}) }))) onDone(); };
  const tone = q.status === 'DONE' ? 'ok' : q.status === 'DECLINED' ? 'danger' : q.status === 'NEW' ? 'warn' : 'info';
  return (
    <li className="card inner stack">
      <div className="row between"><strong>{t(`gp.k.${q.kind}` as Key)}</strong><StatusBadge tone={tone} icon={tone === 'ok' ? 'check' : 'alert'}>{t(`gr.s.${q.status}` as Key)}</StatusBadge></div>
      <p className="small"><Link to={`/reservations/${q.reservationId}`}>{q.confirmationNo}</Link> · {q.guestName}</p>
      {(q.neededOn || q.flightNo || q.passengers) && <p className="small">{[q.neededOn && shortDate(q.neededOn, loc), q.neededTime && clock12(q.neededTime), q.flightNo, q.passengers && t('gp.guests', { n: q.passengers })].filter(Boolean).join(' · ')}</p>}
      {q.note && <p>{q.note}</p>}
      {canAnswer && (<>
        <label>{t('gr.reply')}<input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={t('gr.replyEx')} /></label>
        <div className="actions">
          {q.status === 'NEW' && <button disabled={busy} onClick={() => void act('ACKNOWLEDGED')}>{t('gr.seen')}</button>}
          {q.status !== 'DONE' && <button className="primary" disabled={busy} onClick={() => void act('DONE')}>{t('gr.done')}</button>}
          {q.status !== 'DECLINED' && <button disabled={busy} onClick={() => void act('DECLINED')}>{t('gr.decline')}</button>}
        </div>
        <ErrorLine code={problem?.code} detail={problem?.detail} />
      </>)}
    </li>
  );
}
