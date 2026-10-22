import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { policyLines } from '../desk/policy.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { clock12 } from '../lib/confirmation.js';
import { addDays } from '../lib/format.js';
import { GuestSlipUpload } from '../desk/Documents.js';

interface Room {
  roomType: { name: string; description: string | null; bedConfig: string | null; sizeSqm: string | null; maxOccupancy: number }; adults: number; children: number; arrival: string; departure: string; status: string;
  policy?: Parameters<typeof policyLines>[1]; roomNumber: string | null; floor: string | null; amenities: Array<{ en: string; ur: string | null; category: string }>; media: Array<{ kind: 'IMAGE' | 'VIDEO'; url: string; caption: string | null }>;
}
interface Req { id: string; kind: string; neededOn: string | null; neededTime: string | null; flightNo: string | null; passengers: number | null; note: string | null; status: string; staffNote: string | null }
interface Page {
  property: { name: string; city: string | null; mapsUrl: string | null; checkInTime: string; checkOutTime: string; terms: string | null };
  booking: { confirmationNo: string; status: string; guestName: string; arrival: string | null; departure: string | null; canRequest: boolean; specialRequests: string | null };
  rooms: Room[]; requests: Req[]; slips?: Array<{ id: string; status: string; claimed: { amount: string; currency: string } | null; reference: string | null; rejectReason: string | null; submittedAt: string }>;
}
const KINDS = ['AIRPORT_PICKUP', 'AIRPORT_DROP', 'GROUND_FLOOR', 'WHEELCHAIR', 'EARLY_CHECKIN', 'LATE_CHECKOUT', 'EXTRA_BED', 'OTHER'] as const;
type Kind = (typeof KINDS)[number];

/** The guest's own booking page, opened from the link in the WhatsApp message. No sign-in; everything on it belongs to this one booking. */
export function GuestBooking({ token }: { token: string }) {
  const { t, locale, setLocale } = useT();
  const [page, setPage] = useState<Page | null>(null); const [failed, setFailed] = useState(false);
  const load = useCallback(() => { api<Page>('GET', `/v1/guest/booking/${token}`).then(setPage).catch((e) => { if (e instanceof ApiError || e) setFailed(true); }); }, [token]);
  useEffect(load, [load]);
  const date = (d: string) => new Intl.DateTimeFormat(locale === 'ur' ? 'ur-PK' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
  const [kind, setKind] = useState<Kind | null>(null);

  if (failed) return <main className="gb"><p className="warnbox">{t('gp.notFound')}</p></main>;
  if (!page) return <main className="gb"><p className="muted">{t('common.loading')}</p></main>;
  const { property: p, booking: b } = page;
  const where = p.city ? `${p.name}, ${p.city}` : p.name;
  const cancelled = b.status === 'CANCELLED' || b.status === 'NO_SHOW';
  const nights = b.arrival && b.departure ? Math.round((Date.parse(b.departure) - Date.parse(b.arrival)) / 86_400_000) : 0;
  const guests = page.rooms.reduce((a, r) => a + r.adults + r.children, 0);
  return (
    <main className="gb">
      <header className="gb-head">
        <div><h1>{where}</h1><p className="muted">{t('gp.title')}</p></div>
        <div className="gb-tools noprint">
          <button className="link" onClick={() => setLocale(locale === 'ur' ? 'en' : 'ur')}>{t('nav.language')}</button>
          <button className="primary" onClick={() => window.print()}>{t('gp.download')}</button>
        </div>
      </header>

      <section className="gb-ticket" aria-labelledby="gb-ref">
        <p className={cancelled ? 'warnbox' : 'okbox'}>{cancelled ? t('gp.cancelled') : b.status === 'OPTION' ? t('gp.option') : t('gp.confirmed')}</p>
        <p className="muted small">{t('gp.reference')}</p>
        <p id="gb-ref" className="gb-ref" dir="ltr">{b.confirmationNo}</p>
        <p><strong>{b.guestName}</strong></p>
        <dl className="gb-grid">
          <div><dt>{t('gp.checkIn')}</dt><dd>{b.arrival && date(b.arrival)}<br /><span className="muted" dir="ltr">{t('gp.from')} {clock12(p.checkInTime)}</span></dd></div>
          <div><dt>{t('gp.checkOut')}</dt><dd>{b.departure && date(b.departure)}<br /><span className="muted" dir="ltr">{t('gp.until')} {clock12(p.checkOutTime)}</span></dd></div>
          <div><dt>{t('gp.stay')}</dt><dd>{t('d.nights', { n: nights })} · {t('gp.guests', { n: guests })}</dd></div>
        </dl>
      </section>

      {page.rooms.map((r, i) => (
        <section key={i} className="gb-room" aria-label={r.roomType.name}>
          <h2>{r.roomType.name}</h2>
          <p className="gb-roomno">{r.roomNumber ? <>{t('gp.yourRoom')}: <strong dir="ltr">{r.roomNumber}</strong>{r.floor ? ` · ${r.floor}` : ''}</> : <span className="muted">{t('gp.roomLater')}</span>}</p>
          {r.media.length > 0 && <div className="gb-media">{r.media.map((m, k) => m.kind === 'IMAGE' ? <img key={k} src={m.url} alt={m.caption ?? r.roomType.name} loading="lazy" /> : <video key={k} src={m.url} controls preload="metadata" />)}</div>}
          {r.roomType.description && <p>{r.roomType.description}</p>}
          <p className="muted small">{[r.roomType.bedConfig, r.roomType.sizeSqm ? `${r.roomType.sizeSqm} m²` : null, t('gp.sleeps', { n: r.roomType.maxOccupancy })].filter(Boolean).join(' · ')}</p>
          {r.amenities.length > 0 && <ul className="chips" aria-label={t('gp.amenities')}>{r.amenities.map((a) => <li key={a.en} className="chip">{locale === 'ur' && a.ur ? a.ur : a.en}</li>)}</ul>}
        </section>
      ))}

      <section className="gb-block" aria-labelledby="gb-dir"><h2 id="gb-dir">{t('gp.directions')}</h2>
        <p>{where}</p>
        {p.mapsUrl ? <a className="button primary" href={p.mapsUrl} target="_blank" rel="noreferrer">{t('gp.openMap')}</a> : <p className="muted small">{t('gp.callForDirections')}</p>}
        {p.mapsUrl && <p className="muted small print-only" dir="ltr">{p.mapsUrl}</p>}
      </section>

      {b.canRequest && (
        <section className="gb-block noprint" aria-labelledby="gb-req"><h2 id="gb-req">{t('gp.services')}</h2>
          <p className="muted small">{t('gp.servicesHint')}</p>
          <div className="gb-kinds">{KINDS.map((k) => <button key={k} className={kind === k ? 'primary' : ''} aria-pressed={kind === k} onClick={() => setKind(kind === k ? null : k)}>{t(`gp.k.${k}` as Key)}</button>)}</div>
          {kind && <RequestForm key={kind} token={token} kind={kind} arrival={b.arrival ?? ''} departure={b.departure ?? ''} onSent={() => { setKind(null); load(); }} />}
        </section>
      )}
      {page.requests.length > 0 && (
        <section className="gb-block" aria-labelledby="gb-mine"><h2 id="gb-mine">{t('gp.yourRequests')}</h2>
          <ul className="plain">{page.requests.map((q) => (
            <li key={q.id} className="gb-reqrow"><strong>{t(`gp.k.${q.kind}` as Key)}</strong>
              {q.neededOn && <span className="muted small"> · {date(q.neededOn)}{q.neededTime ? ` ${clock12(q.neededTime)}` : ''}{q.flightNo ? ` · ${q.flightNo}` : ''}</span>}
              <span className={`st st-${q.status === 'DONE' ? 'ok' : q.status === 'DECLINED' ? 'danger' : 'warn'}`}>{t(`gp.s.${q.status}` as Key)}</span>
              {q.staffNote && <p className="small">{q.staffNote}</p>}</li>))}</ul>
        </section>
      )}

      {b.canRequest && (
        <section className="gb-block noprint" aria-labelledby="gb-slip"><h2 id="gb-slip">{t('doc.guestTitle')}</h2>
          {(page.slips ?? []).length > 0 && <ul className="plain">{page.slips!.map((x) => <li key={x.id} className="gb-reqrow"><strong>{x.claimed ? `${x.claimed.currency} ${x.claimed.amount}` : t('doc.slipSent')}</strong>{x.reference ? <span className="muted small"> · {x.reference}</span> : null}<span className={`st st-${x.status === 'LINKED' ? 'ok' : x.status === 'REJECTED' ? 'danger' : 'warn'}`}>{t(`doc.gs.${x.status}` as Key)}</span>{x.rejectReason && <p className="small">{x.rejectReason}</p>}</li>)}</ul>}
          <GuestSlipUpload token={token} onSent={load} />
        </section>
      )}

      <section className="gb-block" aria-labelledby="gb-terms"><h2 id="gb-terms">{t('gp.terms')}</h2>
        {page.rooms.some((r) => policyLines(t, r.policy).length > 0) && <ul>{[...new Set(page.rooms.flatMap((r) => policyLines(t, r.policy)))].map((l) => <li key={l}>{l}</li>)}</ul>}
        {p.terms ? <p className="gb-terms">{p.terms}</p> : <p className="muted small">{t('gp.noTerms')}</p>}
      </section>
      <footer className="muted small gb-foot">{where} · {t('gp.footer')}</footer>
    </main>
  );
}

function RequestForm({ token, kind, arrival, departure, onSent }: { token: string; kind: Kind; arrival: string; departure: string; onSent: () => void }) {
  const { t } = useT();
  const transfer = kind === 'AIRPORT_PICKUP' || kind === 'AIRPORT_DROP';
  const [f, setF] = useState({ neededOn: kind === 'AIRPORT_DROP' ? departure : arrival, neededTime: '', flightNo: '', passengers: '2', note: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const need = kind === 'OTHER' && f.note.trim().length < 3;
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      await api('POST', `/v1/guest/booking/${token}/requests`, { kind, ...(transfer ? { neededOn: f.neededOn, neededTime: f.neededTime, ...(f.flightNo.trim() ? { flightNo: f.flightNo.trim() } : {}), passengers: Number(f.passengers) || 1 } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}) });
      onSent();
    } catch (e) { setErr(e instanceof ApiError ? e.code : 'ERROR'); } finally { setBusy(false); }
  };
  return (
    <div className="card inner stack">
      <p className="muted small">{t(`gp.h.${kind}` as Key)}</p>
      {transfer && (<div className="grid2">
        <label>{t('gp.date')}<input type="date" value={f.neededOn} min={addDays(arrival, -7)} onChange={(e) => setF({ ...f, neededOn: e.target.value })} dir="ltr" /></label>
        <label>{t('gp.time')}<input type="time" value={f.neededTime} onChange={(e) => setF({ ...f, neededTime: e.target.value })} dir="ltr" /></label>
        <label>{t('gp.flight')}<input value={f.flightNo} maxLength={20} onChange={(e) => setF({ ...f, flightNo: e.target.value.toUpperCase() })} dir="ltr" placeholder="PK 301" /></label>
        <label>{t('gp.passengers')}<input type="number" min={1} max={20} value={f.passengers} onChange={(e) => setF({ ...f, passengers: e.target.value })} dir="ltr" /></label>
      </div>)}
      <label>{kind === 'OTHER' ? t('gp.whatNeed') : t('gp.noteOpt')}<textarea rows={3} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
      {err && <p className="warnbox" role="alert">{t(`err.${err}` as Key) === `err.${err}` ? t('err.generic') : t(`err.${err}` as Key)}</p>}
      <div className="actions"><button className="primary" disabled={busy || need || (transfer && (!f.neededOn || !f.neededTime))} onClick={() => void send()}>{t('gp.send')}</button></div>
    </div>
  );
}
