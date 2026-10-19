import { useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAuth, useLive, useWork } from '../state.js';
import { Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';

interface Item { id: string; roomNumber: string | null; location: string | null; item: string; description: string | null; foundBy: string | null }

export function LostFound() {
  const { t } = useT();
  const { property, can } = useAuth();
  const work = useWork();
  const base = `/v1/properties/${property!.id}/housekeeping`;
  const live = useLive<{ items: Item[] }>(`${base}/lost-found?status=FOUND`, 60_000, `lf-${property!.id}`);
  const [open, setOpen] = useState(false); const [item, setItem] = useState(''); const [location, setLocation] = useState(''); const [err, setErr] = useState<string>();

  const add = async () => {
    if (item.trim().length < 2) { setErr('NOTE_REQUIRED'); return; }
    try { await work.run({ method: 'POST', path: `${base}/lost-found`, body: { item: item.trim(), ...(location.trim() ? { location: location.trim() } : {}) }, effect: { kind: 'lostfound' } }); setOpen(false); setItem(''); setLocation(''); live.reload(); }
    catch (e) { setErr(e instanceof ApiError ? e.code : 'generic'); }
  };
  const close = async (id: string, status: 'RETURNED' | 'DISPOSED') => { try { await api('POST', `${base}/lost-found/${id}/close`, { status }); live.reload(); } catch (e) { setErr(e instanceof ApiError ? e.code : 'generic'); } };
  return (
    <section>
      <div className="row between"><h2>{t('lf.title')}</h2>{can('housekeeping.update') && <button className="primary small" onClick={() => setOpen(true)}>{t('lf.new')}</button>}</div>
      <ErrorLine code={err} />
      {live.loading && !live.data ? <Spinner /> : (live.data?.items.length ?? 0) === 0 ? <Empty text={t('lf.empty')} /> : (
        <ul className="cards">{live.data!.items.map((i) => (
          <li key={i.id} className="card">
            <strong>{i.item}</strong>
            <p className="muted small">{[i.roomNumber && `${t('common.room')} ${i.roomNumber}`, i.location, i.foundBy].filter(Boolean).join(' · ')}</p>
            {can('housekeeping.assign') && <div className="actions"><button onClick={() => close(i.id, 'RETURNED')}>{t('lf.returned')}</button><button onClick={() => close(i.id, 'DISPOSED')}>{t('lf.disposed')}</button></div>}
          </li>))}
        </ul>
      )}
      {open && (
        <Sheet title={t('lf.new')} onClose={() => setOpen(false)}>
          <label>{t('lf.item')}<input value={item} onChange={(e) => setItem(e.target.value)} autoFocus /></label>
          <label>{t('lf.location')} ({t('common.optional')})<input value={location} onChange={(e) => setLocation(e.target.value)} /></label>
          <ErrorLine code={err} />
          <div className="actions"><button className="primary" onClick={add}>{t('lf.add')}</button><button onClick={() => setOpen(false)}>{t('common.cancel')}</button></div>
        </Sheet>
      )}
    </section>
  );
}
