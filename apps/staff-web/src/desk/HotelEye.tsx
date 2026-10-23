import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';

interface Row { id: string; confirmationNo: string; room: string | null; arrival: string; departure: string; name: string; ageGroup: string; guestType: string | null; nationality: string | null; idType: string | null; idLast4: string | null; entered: { at: string; by: string | null; ref: string | null } | null }
interface Detail { id: string; confirmationNo: string; fields: Array<{ key: string; value: string }>; entered: { at: string; ref: string | null } | null }

/**
 * Hotel Eye is typed in by hand on the police portal. This is the working list: who has been entered and who has not (so nobody is missed or entered twice), and for each person
 * the details laid out one value at a time with a copy button, to paste into the portal. Full document numbers need the view-ID permission and a fresh second factor.
 */
export function HotelEye() {
  const { t } = useT(); const { property } = useAuth();
  const b = `/v1/properties/${property!.id}/registration/hotel-eye`;
  const [state, setState] = useState<'pending' | 'done'>('pending'); const [open, setOpen] = useState<Row | null>(null);
  const list = useLive<{ pending: number; items: Row[] }>(`${b}?state=${state}`, 30_000);
  return (
    <section className="stack">
      <h2>{t('he.title')}</h2>
      <p className="muted small">{t('he.intro')}</p>
      <div className="row">
        <Chip active={state === 'pending'} onClick={() => setState('pending')}>{t('he.pending')}{list.data ? ` (${list.data.pending})` : ''}</Chip>
        <Chip active={state === 'done'} onClick={() => setState('done')}>{t('he.done')}</Chip>
      </div>
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t(state === 'pending' ? 'he.noneLeft' : 'common.none')} /> : (
        <ul className="plain">{list.data.items.map((r) => (
          <li key={r.id} className="card inner row between small">
            <span><strong>{r.name}</strong> · {r.room ? `${t('d.room')} ${r.room} · ` : ''}{r.confirmationNo} · {r.arrival} → {r.departure}<br /><span className="muted" dir="ltr">{[r.nationality, r.idType && `${r.idType} …${r.idLast4 ?? ''}`].filter(Boolean).join(' · ')}</span></span>
            <span className="row">{r.entered && <Badge tone="clean">{t('he.enteredBy', { who: r.entered.by ?? '' })}</Badge>}<button onClick={() => setOpen(r)}>{t('he.open')}</button></span>
          </li>))}</ul>)}
      {open && <Entry row={open} base={b} onClose={() => setOpen(null)} onChanged={() => { list.reload(); setOpen(null); }} />}
    </section>
  );
}

function Entry({ row, base, onClose, onChanged }: { row: Row; base: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useT(); const withStepUp = useStepUp(); const { busy, problem, run } = useAction();
  const [d, setD] = useState<Detail | null>(null); const [ref, setRef] = useState(row.entered?.ref ?? ''); const [copied, setCopied] = useState<string | null>(null);
  const load = async () => { const r = await run(() => withStepUp(() => api<Detail>('GET', `${base}/${row.id}`))); if (r) setD(r); };
  const copy = (k: string, v: string) => { void navigator.clipboard?.writeText(v); setCopied(k); };
  return (
    <Sheet title={row.name} onClose={onClose}>
      <div className="stack">
        {!d ? (<>
          <p className="muted small">{t('he.reveal')}</p>
          <button className="primary" disabled={busy} onClick={load}>{t('he.show')}</button>
        </>) : (<>
          <ul className="plain small">{d.fields.map((f) => (
            <li key={f.key} className="row between"><span><span className="muted">{t(`he.f.${f.key}` as Key)}</span><br /><strong dir="ltr">{f.value}</strong></span>
              <button onClick={() => copy(f.key, f.value)}>{copied === f.key ? t('wa.copied') : t('he.copy')}</button></li>))}</ul>
          {row.entered ? (
            <div className="actions"><span className="muted small">{t('he.enteredBy', { who: row.entered.by ?? '' })}{row.entered.ref ? ` · ${row.entered.ref}` : ''}</span>
              <button disabled={busy} onClick={async () => { if (await run(() => api('POST', `${base}/${row.id}/undo`, {}))) onChanged(); }}>{t('he.undo')}</button></div>
          ) : (<>
            <label>{t('he.ref')}<input value={ref} maxLength={60} onChange={(e) => setRef(e.target.value)} dir="ltr" /></label>
            <div className="actions"><button className="primary" disabled={busy} onClick={async () => { if (await run(() => api('POST', `${base}/${row.id}/entered`, ref.trim() ? { ref: ref.trim() } : {}))) onChanged(); }}>{t('he.mark')}</button></div>
          </>)}
        </>)}
        <ErrorLine code={problem?.code} detail={problem?.detail} />
      </div>
    </Sheet>
  );
}
