import { useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';

interface Arrival { confirmationNo: string; guest: string; roomType: string; adults: number; children: number; arrived: boolean; room: string | null }
interface Visit { id: string; kind: 'VISITOR' | 'VEHICLE' | 'DELIVERY' | 'CONTRACTOR'; name: string | null; phone: string | null; idLast4: string | null; plate: string | null; visiting: string | null; purpose: string | null; inAt: string; outAt: string | null; guestId: string | null }
const KINDS = ['VISITOR', 'VEHICLE', 'DELIVERY', 'CONTRACTOR'] as const;
const hhmm = (iso: string, locale: string) => new Date(iso).toLocaleTimeString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' });

/** The gate: who is expected today (names shortened), who is here now, and the log of visitors, vehicles and deliveries. Built for a phone, in Urdu or English. */
export function Gate() {
  const { t, locale } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/gate`;
  const arrivals = useLive<{ date: string; inHouse: number; items: Arrival[] }>(can('arrivals.view_masked') ? `${base}/arrivals` : null, 30_000);
  const visits = useLive<{ open: Visit[]; today: Visit[] }>(can('visitor.log') ? `${base}/visits` : null, 15_000);
  const [adding, setAdding] = useState(false);
  const { busy, problem, run } = useAction();
  const register = async (v: Visit) => {
    let dup = false;
    const post = (body: object) => run(async () => { try { return await api('POST', `${base}/visits/${v.id}/register`, body); } catch (e) { if (e instanceof ApiError && e.code === 'DUPLICATE_GUEST') { dup = true; return undefined; } throw e; } });
    let r = await post({});
    if (dup && window.confirm(t('gt.dupConfirm'))) r = await post({ allowDuplicate: true });
    if (r) visits.reload();
  };
  const out = async (v: Visit) => { if (await run(() => api('POST', `${base}/visits/${v.id}/out`, {}))) visits.reload(); };
  const label = (v: Visit) => [v.name, v.plate].filter(Boolean).join(' · ');
  return (
    <section className="stack">
      <h2>{t('nav.gate')}</h2>
      {can('visitor.log') && <div className="actions"><button className="primary" onClick={() => setAdding(true)}>{t('gt.log')}</button></div>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {can('arrivals.view_masked') && (<div className="stack"><h3>{t('gt.expected')}{arrivals.data ? ` · ${t('gt.inHouse', { n: arrivals.data.inHouse })}` : ''}</h3>
        {!arrivals.data ? <Spinner /> : arrivals.data.items.length === 0 ? <Empty text={t('gt.noArrivals')} /> : (
          <ul className="plain">{arrivals.data.items.map((a) => (
            <li key={a.confirmationNo} className="card inner row between small"><span><strong>{a.guest}</strong> · {a.roomType} · {a.adults + a.children} {t('gt.people')}{a.room ? ` · ${t('d.room')} ${a.room}` : ''}<br /><span className="muted" dir="ltr">{a.confirmationNo}</span></span><Badge tone={a.arrived ? 'clean' : 'warn'}>{a.arrived ? t('gt.arrived') : t('gt.coming')}</Badge></li>))}</ul>)}</div>)}
      {can('visitor.log') && (<div className="stack"><h3>{t('gt.here')}</h3>
        {!visits.data ? <Spinner /> : visits.data.open.length === 0 ? <Empty text={t('gt.nobody')} /> : (
          <ul className="plain">{visits.data.open.map((v) => (
            <li key={v.id} className="card inner stack small"><div className="row between"><strong>{t(`gt.k.${v.kind}` as Key)} · {label(v)}</strong><span className="muted" dir="ltr">{hhmm(v.inAt, locale)}</span></div>
              <span className="muted">{[v.visiting && `${t('gt.visiting')}: ${v.visiting}`, v.purpose, v.phone].filter(Boolean).join(' · ')}</span>
              <div className="row"><button disabled={busy} onClick={() => out(v)}>{t('gt.out')}</button>{v.kind === 'VISITOR' && v.name && (v.guestId ? <Badge tone="clean">{t('gt.registered')}</Badge> : can('guest.manage') && <button disabled={busy} onClick={() => register(v)}>{t('gt.register')}</button>)}</div></li>))}</ul>)}
        <h3>{t('gt.today')}</h3>
        {!visits.data ? null : visits.data.today.length === 0 ? <Empty text={t('common.none')} /> : (
          <ul className="plain small">{visits.data.today.map((v) => <li key={v.id} className="row between"><span>{t(`gt.k.${v.kind}` as Key)} · {label(v)}</span><span className="muted" dir="ltr">{hhmm(v.inAt, locale)}–{v.outAt ? hhmm(v.outAt, locale) : ''}</span></li>)}</ul>)}</div>)}
      {adding && <LogSheet base={base} onDone={() => { setAdding(false); visits.reload(); }} onClose={() => setAdding(false)} />}
    </section>
  );
}

function LogSheet({ base, onDone, onClose }: { base: string; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const [f, setF] = useState({ kind: 'VISITOR' as Visit['kind'], name: '', phone: '', idLast4: '', plate: '', visiting: '', purpose: '' });
  const { busy, problem, run } = useAction();
  const go = async () => {
    const body: Record<string, unknown> = { kind: f.kind }; for (const [k, v] of Object.entries(f)) if (k !== 'kind' && v.trim()) body[k] = v.trim();
    if (await run(() => api('POST', `${base}/visits`, body))) onDone();
  };
  const ready = f.name.trim().length >= 2 || f.plate.trim().length >= 2;
  return (
    <Sheet title={t('gt.log')} onClose={onClose}>
      <div className="chips" role="group">{KINDS.map((k) => <Chip key={k} active={f.kind === k} onClick={() => setF({ ...f, kind: k })}>{t(`gt.k.${k}` as Key)}</Chip>)}</div>
      <label>{t('gt.name')}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <div className="grid2"><label>{t('gt.plate')}<input value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value })} dir="ltr" /></label><label>{t('gt.phone')}<input inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} dir="ltr" /></label></div>
      <label>{t('gt.visiting')}<input value={f.visiting} onChange={(e) => setF({ ...f, visiting: e.target.value })} /></label>
      <label>{t('gt.purpose')}<input value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></label>
      <label>{t('gt.id4')}<input maxLength={4} value={f.idLast4} onChange={(e) => setF({ ...f, idLast4: e.target.value })} dir="ltr" /></label>
      <p className="muted small">{t('gt.privacy')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || !ready || (f.idLast4 !== '' && f.idLast4.length !== 4)} onClick={go}>{t('gt.in')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}
