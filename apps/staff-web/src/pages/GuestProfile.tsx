import { useEffect, useRef, useState } from 'react';
import { api, ApiError, NetworkError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAuth, useLive, useWork } from '../state.js';
import { Banner, Field, SaveState, SidePanel, Skeleton, StatusBadge, type SaveStatus } from '../ui/ds.js';
import { ErrorLine } from '../ui/kit.js';

interface Guest { id: string; fullName: string; phone: string | null; email: string | null; nationality: string | null; residency: string; vip: boolean; doNotRent: boolean; notes: string | null; version: number }
type Form = { phone: string; email: string; notes: string; vip: boolean };
const formOf = (g: Guest): Form => ({ phone: g.phone ?? '', email: g.email ?? '', notes: g.notes ?? '', vip: g.vip });

/** A guest's record beside the list: contact details, preference notes and VIP, saved as you type (saving / saved / could not save / offline / changed by someone else). */
export function GuestProfile({ id, stays, onClose }: { id: string; stays: React.ReactNode; onClose: () => void }) {
  const { t } = useT();
  const { can } = useAuth();
  const work = useWork();
  const g = useLive<Guest>(`/v1/guests/${id}`, 60_000);
  const editable = can('guest.manage');
  const [f, setF] = useState<Form | null>(null); const [save, setSave] = useState<SaveStatus>({ kind: 'idle' }); const [err, setErr] = useState<string>();
  const version = useRef(0); const dirty = useRef(false); const timer = useRef<number>(); const latest = useRef<Form | null>(null); latest.current = f;
  useEffect(() => { if (g.data && !dirty.current) { setF(formOf(g.data)); version.current = g.data.version; } }, [g.data]);
  const flush = async () => {
    if (!latest.current) return;
    if (!work.online) { setSave({ kind: 'offline' }); return; }
    setSave({ kind: 'saving' }); setErr(undefined);
    const v = latest.current;
    try {
      const out = await api<Guest>('PATCH', `/v1/guests/${id}`, { phone: v.phone.trim() || null, email: v.email.trim() || null, notes: v.notes.trim() || null, vip: v.vip, version: version.current });
      version.current = out.version; dirty.current = false; setSave({ kind: 'saved', at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) });
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'VERSION_CONFLICT' || e.status === 412)) { setSave({ kind: 'conflict' }); return; }
      if (e instanceof ApiError && e.status < 500) { setErr(e.code); setSave({ kind: 'failed' }); return; }
      setSave(e instanceof NetworkError ? { kind: 'offline' } : { kind: 'failed' });
    }
  };
  const edit = (patch: Partial<Form>, now = false) => { setF((x) => (x ? { ...x, ...patch } : x)); dirty.current = true; setSave({ kind: 'saving' }); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void flush(), now ? 50 : 900); };
  useEffect(() => { if (work.online && save.kind === 'offline' && dirty.current) void flush(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [work.online]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const keepMine = async () => { try { const fresh = await api<Guest>('GET', `/v1/guests/${id}`); version.current = fresh.version; await flush(); } catch { setSave({ kind: 'failed' }); } };

  return (
    <SidePanel title={g.data?.fullName ?? t('common.loading')} subtitle={g.data?.nationality ?? undefined} onClose={onClose}>
      {!g.data || !f ? <Skeleton rows={4} /> : (<>
        <div className="row between"><span>{g.data.doNotRent && <StatusBadge tone="danger" icon="stop">{t('bl.GUEST_FLAGGED')}</StatusBadge>}</span>{editable && <SaveState s={save} onRetry={() => void flush()} />}</div>
        {save.kind === 'conflict' && <Banner level="BLOCKER" title={t('gp.conflictTitle')} action={<span className="actions"><button onClick={() => { dirty.current = false; setSave({ kind: 'idle' }); g.reload(); }}>{t('save.useTheirs')}</button><button className="primary" onClick={() => void keepMine()}>{t('save.keepMine')}</button></span>}>{t('save.conflictText')}</Banner>}
        <Field label={t('ci.phone')}>{(p) => <input {...p} type="tel" dir="ltr" value={f.phone} disabled={!editable} onChange={(e) => edit({ phone: e.target.value })} />}</Field>
        <Field label={t('gp.email')}>{(p) => <input {...p} type="email" dir="ltr" value={f.email} disabled={!editable} onChange={(e) => edit({ email: e.target.value })} />}</Field>
        <Field label={t('gp.notes')} hint={t('gp.notesHint')}>{(p) => <textarea {...p} value={f.notes} maxLength={2000} disabled={!editable} onChange={(e) => edit({ notes: e.target.value })} />}</Field>
        <label className="check"><input type="checkbox" checked={f.vip} disabled={!editable} onChange={(e) => edit({ vip: e.target.checked }, true)} /> {t('gp.vip')}</label>
        <ErrorLine code={err} />
        {!editable && <p className="muted small">{t('perm.readOnly')}</p>}
        {g.data.doNotRent && <p className="muted small">{t('gp.dnrNote')}</p>}
        <h3>{t('gp.stays')}</h3>
        {stays}
      </>)}
    </SidePanel>
  );
}
