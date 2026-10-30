import { useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { shortDate } from '../lib/format.js';
import { useAuth } from '../state.js';
import { ErrorLine } from '../ui/kit.js';

export interface Event { id: string; action: string; note: string | null; at: string; by: string | null }
export const stamp = (iso: string | null, locale: 'en' | 'ur') => (iso ? `${shortDate(iso.slice(0, 10), locale)} ${new Date(iso).toLocaleTimeString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}` : '');

/** Finds a booking by its number or the guest's name, so a case can be tied to a stay. Optional: leave it empty for something not tied to a guest. */
export function BookingPick({ value, onChange }: { value: { id: string; label: string } | null; onChange: (v: { id: string; label: string } | null) => void }) {
  const { t } = useT(); const { property } = useAuth(); const [q, setQ] = useState(''); const [hits, setHits] = useState<Array<{ reservationId: string; confirmationNo: string; guest: { fullName: string } }>>([]); const [busy, setBusy] = useState(false);
  const find = async () => { if (q.trim().length < 2) return; setBusy(true); try { setHits((await api<{ items: typeof hits }>('GET', `/v1/properties/${property!.id}/reservations?q=${encodeURIComponent(q.trim())}&limit=6`)).items); } catch { setHits([]); } setBusy(false); };
  if (value) return <p className="row between"><span><span className="muted small">{t('cb.booking')}: </span><strong>{value.label}</strong></span><button type="button" className="link" onClick={() => onChange(null)}>{t('cb.change')}</button></p>;
  return (
    <div className="stack">
      <div className="row"><label className="grow">{t('cb.booking')} ({t('common.optional')})<input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void find(); } }} placeholder={t('cb.bookingHint')} /></label><button type="button" disabled={busy || q.trim().length < 2} onClick={find}>{t('cb.find')}</button></div>
      {hits.length > 0 && <ul className="plain">{hits.map((h) => <li key={h.reservationId}><button type="button" className="wide pick" onClick={() => { onChange({ id: h.reservationId, label: `${h.confirmationNo} · ${h.guest.fullName}` }); setHits([]); }}>{h.confirmationNo} · {h.guest.fullName}</button></li>)}</ul>}
    </div>
  );
}

/** The case's history, oldest first. It only ever grows. */
export function Timeline({ events, label }: { events: Event[]; label: (a: string) => string }) {
  const { locale } = useT();
  return <ol className="plain timeline">{events.map((e) => <li key={e.id}><strong>{label(e.action)}</strong> <span className="muted small">{stamp(e.at, locale)}{e.by ? ` · ${e.by}` : ''}</span>{e.note && <div className="small">{e.note}</div>}</li>)}</ol>;
}

/** Evidence pictures. They are served only to people who may see the case, never by an open link. */
export function Photos({ base, ids, canAdd, onAdded }: { base: string; ids: Array<{ id: string }>; canAdd: boolean; onAdded: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction(); const file = useRef<HTMLInputElement>(null);
  const add = async (f: File | undefined) => { if (!f) return; const form = new FormData(); form.append('file', f); await run(() => api('POST', `${base}/photos`, form)); if (file.current) file.current.value = ''; onAdded(); };
  return (
    <div className="stack">
      {ids.length > 0 && <div className="photo-grid">{ids.map((p) => <a key={p.id} href={`${base}/photos/${p.id}`} target="_blank" rel="noreferrer"><img className="photo-thumb" src={`${base}/photos/${p.id}`} alt={t('cb.evidence')} loading="lazy" /></a>)}</div>}
      {canAdd && <label className="button">{busy ? t('common.loading') : t('cb.addPhoto')}<input ref={file} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden onChange={(e) => void add(e.target.files?.[0])} /></label>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </div>
  );
}
