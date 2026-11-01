import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { shortDate } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { Empty, ErrorLine, Spinner } from '../ui/kit.js';

interface Item { id: string; status: string; requestedBy: string; mine: boolean; code: string; note: string | null; pct: number; amount: string; rooms: number; arrival: string; departure: string; adults: number; children: number; decidedBy: string | null; decisionNote: string | null; createdAt: string }

/** Discounts that are above what the person at the desk may give. Managers approve or reject (rejecting needs a note); everyone sees how their own requests stand. */
export function DiscountApprovals() {
  const { t, locale } = useT();
  const { property } = useAuth();
  const base = `/v1/properties/${property!.id}/discount-approvals`;
  const list = useLive<{ approver: boolean; items: Item[] }>(base, 15_000);
  const { busy, problem, run } = useAction();
  const withStepUp = useStepUp();
  const [open, setOpen] = useState<string | null>(null); const [note, setNote] = useState('');
  const decide = async (i: Item, verb: 'approve' | 'reject') => {
    if (verb === 'reject' && note.trim().length < 3) return;
    const r = await run(() => withStepUp(() => api('POST', `${base}/${i.id}/${verb}`, note.trim() ? { note: note.trim() } : {})));
    if (r !== undefined) { setOpen(null); setNote(''); list.reload(); }
  };
  if (!list.data) return <Spinner />;
  const items = list.data.items;
  return (
    <div className="stack">
      <h3>{t('da.title')}</h3>
      <p className="muted small">{list.data.approver ? t('da.helpMgr') : t('da.helpMine')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {items.length === 0 ? <Empty text={t('da.none')} /> : (
        <ul className="plain">{items.map((i) => (
          <li key={i.id} className="card inner stack small">
            <div className="row between"><strong>{t(`dr.c.${i.code}` as Key)}</strong><span className="badge">{t(`da.s.${i.status}` as Key)}</span></div>
            <span dir="ltr">{shortDate(i.arrival, locale)} → {shortDate(i.departure, locale)} · {i.rooms} × · {i.adults}+{i.children}</span>
            <span>{i.pct > 0 ? `${i.pct}%` : ''} {i.amount}</span>
            <span className="muted">{t('da.by', { name: i.requestedBy })}{i.note ? ` · ${i.note}` : ''}</span>
            {i.decidedBy && <span className="muted">{t('da.decided', { name: i.decidedBy })}{i.decisionNote ? `: ${i.decisionNote}` : ''}</span>}
            {list.data!.approver && i.status === 'PENDING' && !i.mine && (open === i.id
              ? <div className="stack"><label>{t('da.note')}<input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
                <div className="row"><button className="primary" disabled={busy} onClick={() => void decide(i, 'approve')}>{t('da.approve')}</button><button disabled={busy || note.trim().length < 3} onClick={() => void decide(i, 'reject')}>{t('da.reject')}</button><button onClick={() => { setOpen(null); setNote(''); }}>{t('common.cancel')}</button></div></div>
              : <div className="row"><button onClick={() => { setOpen(i.id); setNote(''); }}>{t('da.review')}</button></div>)}
          </li>))}</ul>)}
    </div>
  );
}
