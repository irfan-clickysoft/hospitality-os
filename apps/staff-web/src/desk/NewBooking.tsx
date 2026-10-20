import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { addDays, money, newKey, shortDate } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { useStepUp } from '../lib/stepup.js';
import { ConfirmationMessage } from './ConfirmationMessage.js';
import { ApprovalBox, ComplianceNotes, type Hit } from './ComplianceBits.js';
import { Badge, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import { policyLines } from './policy.js';
import type { Amount } from './types.js';

interface Option {
  roomType: { id: string; code: string; name: string }; plan: { id: string; code: string; name: string; mealPlan: string }; roomsLeft: number; bookable: boolean; reasons: Array<{ code: string; message: string }>;
  nights: Array<{ date: string; total: string; discountPct: number; discount: string; payable: string }>; totalExTax: Amount; taxes?: Array<{ code: string; ratePercent: number; tax: Amount }>; taxTotal?: Amount; totalIncTax?: Amount; depositDue: Amount; policy: Parameters<typeof policyLines>[1]; quoteToken: string | null; discount: unknown;
}
interface GuestHit { id: string; fullName: string; phone: string | null; email: string | null; nationality: string | null; residency: 'RESIDENT' | 'NON_RESIDENT'; vip: boolean }
const SOURCES = ['PHONE', 'WHATSAPP', 'WEBSITE', 'CORPORATE', 'TRAVEL_AGENT', 'OTHER'] as const;
const CHANNEL: Record<string, string> = { PHONE: 'PHONE', WHATSAPP: 'DIRECT', WEBSITE: 'DIRECT', CORPORATE: 'CORPORATE', TRAVEL_AGENT: 'AGENT', OTHER: 'DIRECT' };

/** Quote → guest → book. The price shown is the one the server signed; the booking is refused if it changed. */
export function NewBooking({ initial, businessDate, onClose, onOpenReservation }: { initial: { arrival: string; roomTypeId?: string }; businessDate: string; onClose: () => void; onOpenReservation: (id: string) => void }) {
  const { t, locale } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const [step, setStep] = useState<'search' | 'options' | 'guest' | 'confirm' | 'done'>('search');
  const [arrival, setArrival] = useState(initial.arrival); const [nights, setNights] = useState(1); const [adults, setAdults] = useState(2); const [children, setChildren] = useState(0);
  const companies = useLive<{ items: Array<{ id: string; name: string; status: string }> }>(can('company.view') ? '/v1/companies' : null, 300_000);
  const [companyId, setCompanyId] = useState('');
  const [foreign, setForeign] = useState(false); const [source, setSource] = useState<(typeof SOURCES)[number]>('PHONE');
  const [options, setOptions] = useState<Option[]>([]); const [chosen, setChosen] = useState<Option | null>(null);
  const [q, setQ] = useState(''); const [hits, setHits] = useState<GuestHit[]>([]); const [guest, setGuest] = useState<GuestHit | null>(null);
  const [nf, setNf] = useState({ fullName: '', phone: '', nationality: 'PK' });
  const [hold, setHold] = useState(false); const [holdKind, setHoldKind] = useState<'half' | 'days' | 'date'>('half'); const [holdHalf, setHoldHalf] = useState(4); const [holdDays, setHoldDays] = useState(3); const [holdDate, setHoldDate] = useState(''); const [notes, setNotes] = useState(''); const [ext, setExt] = useState('');
  const holdLast = addDays(arrival, -1) < businessDate ? businessDate : addDays(arrival, -1); const holdUntil = holdDate || holdLast;     // default: keep it until the day before arrival
  const [result, setResult] = useState<{ id: string; confirmationNo: string; guarantee: { atRisk: boolean; depositRequired: Amount; deadline: string | null }; totalExTax: Amount; compliance?: Hit[] } | null>(null);
  const [discAll, setDiscAll] = useState(''); const [nightPct, setNightPct] = useState<Record<string, string>>({});
  const key = useMemo(newKey, []);
  const { busy, problem, run, clear } = useAction();
  const withStepUp = useStepUp();
  const lastBook = useState<{ g: { guestId?: string; guest?: Record<string, unknown> } } | null>(null);
  const departure = addDays(arrival, nights);

  const pct = (v: string) => Math.min(100, Math.max(0, Number(v) || 0));
  const quoteBody = () => ({ arrival, departure, adults, children, channel: CHANNEL[source], residency: foreign ? 'NON_RESIDENT' : 'RESIDENT', ...(companyId ? { companyId } : {}), ...(initial.roomTypeId ? { roomTypeId: initial.roomTypeId } : {}),
    discountPct: pct(discAll), nightDiscounts: Object.entries(nightPct).filter(([, v]) => v !== '').map(([date, v]) => ({ date, pct: pct(v) })) });
  const search = async () => {
    const r = await run(() => api<{ options: Option[] }>('POST', `${base}/quotes`, quoteBody()));
    if (r) { setOptions(r.options); setStep('options'); }
  };
  // changing a discount re-prices the options a moment later, so what is shown is always what the server will sign
  const [repricing, setRepricing] = useState(false);
  useEffect(() => {
    if (step !== 'options') return;
    setRepricing(true);
    const h = setTimeout(() => { api<{ options: Option[] }>('POST', `${base}/quotes`, quoteBody()).then((r) => setOptions(r.options)).catch(() => undefined).finally(() => setRepricing(false)); }, 450);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discAll, nightPct]);
  const stayDates = useMemo(() => Array.from({ length: nights }, (_, k) => addDays(arrival, k)), [arrival, nights]);
  useEffect(() => {
    if (step !== 'guest' || q.trim().length < 2) { setHits([]); return; }
    const h = setTimeout(() => { api<{ items: GuestHit[] }>('GET', `/v1/guests/search?q=${encodeURIComponent(q.trim())}`).then((r) => setHits(r.items)).catch(() => setHits([])); }, 250);
    return () => clearTimeout(h);
  }, [q, step]);

  const book = async (g: { guestId?: string; guest?: Record<string, unknown> }, approval?: string) => {
    lastBook[1]({ g });
    const body = { ...g, source, lines: [{ quoteToken: chosen!.quoteToken }], ...(hold ? { hold: holdKind === 'half' ? { minutes: holdHalf * 30 } : holdKind === 'days' ? { days: holdDays } : { untilDate: holdUntil } } : {}), ...(notes.trim() ? { notesInternal: notes.trim() } : {}), ...(ext.trim() ? { externalRef: ext.trim() } : {}), ...(approval ? { complianceApproval: { reason: approval } } : {}) };
    const call = () => api<NonNullable<typeof result>>('POST', `${base}/reservations`, body, { 'idempotency-key': key });
    const r = await run(() => (approval ? withStepUp(call) : call()));
    if (r) { setResult(r); setStep('done'); }
  };
  const name = guest?.fullName ?? nf.fullName;
  return (
    <Sheet title={t('bk.new')} onClose={onClose}>
      {step === 'search' && (<>
        <div className="grid2"><label>{t('bk.arrival')}<input type="date" value={arrival} min={businessDate} onChange={(e) => setArrival(e.target.value)} dir="ltr" /></label><label>{t('bk.nights')}<input type="number" min={1} max={60} value={nights} onChange={(e) => setNights(Math.max(1, Number(e.target.value) || 1))} dir="ltr" /></label></div>
        <p className="muted small">{shortDate(arrival, locale)} → {shortDate(departure, locale)}</p>
        <div className="grid2"><label>{t('d.adults')}<input type="number" min={1} max={10} value={adults} onChange={(e) => setAdults(Math.max(1, Number(e.target.value) || 1))} dir="ltr" /></label><label>{t('d.children')}<input type="number" min={0} max={10} value={children} onChange={(e) => setChildren(Math.max(0, Number(e.target.value) || 0))} dir="ltr" /></label></div>
        <label>{t('bk.source')}<select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>{SOURCES.map((s) => <option key={s} value={s}>{t(`src.${s}` as Key)}</option>)}</select></label>
        {companies.data && companies.data.items.length > 0 && <label>{t('ar.company')} ({t('common.optional')})<select value={companyId} onChange={(e) => setCompanyId(e.target.value)}><option value="">—</option>{companies.data.items.filter((c) => c.status !== 'ARCHIVED').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        <label className="check"><input type="checkbox" checked={foreign} onChange={(e) => setForeign(e.target.checked)} /> {t('bk.foreign')}</label>
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        <div className="actions"><button className="primary" disabled={busy} onClick={search}>{t('bk.search')}</button></div>
      </>)}

      {step === 'options' && (<>
        <p className="muted small">{shortDate(arrival, locale)} → {shortDate(departure, locale)} · {t('d.nights', { n: nights })} · {adults} {t('d.adults')} · {t('bk.exTaxNote')}</p>
        <fieldset className="guestcard"><legend>{t('bk.discounts')}</legend>
          <p className="muted small">{t('bk.discountsHint')}</p>
          <label>{t('bk.discAll')}<input type="number" min={0} max={100} step={0.5} inputMode="decimal" dir="ltr" value={discAll} onChange={(e) => setDiscAll(e.target.value)} placeholder="0" /></label>
          <div className="nightpct">{stayDates.map((d) => (
            <label key={d}>{shortDate(d, locale)}<input type="number" min={0} max={100} step={0.5} inputMode="decimal" dir="ltr" aria-label={`${t('bk.discOn')} ${shortDate(d, locale)} (%)`} value={nightPct[d] ?? ''} placeholder={discAll || '0'} onChange={(e) => setNightPct({ ...nightPct, [d]: e.target.value })} /></label>))}
          </div>
          {repricing && <p className="muted small" aria-live="polite">{t('bk.repricing')}</p>}
        </fieldset>
        {options.length === 0 && <p className="warnbox">{t('bk.noRooms')}</p>}
        {options.map((o) => (
          <div key={`${o.roomType.id}-${o.plan.id}`} className="card inner stack">
            <div className="row between"><strong>{o.roomType.name}</strong><span className="muted small">{o.plan.name}</span></div>
            <div className="row between"><span className="big">{money(o.totalExTax)}</span><Badge tone="neutral">{t('bk.left', { n: o.roomsLeft })}</Badge></div>
            <table className="nighttable small"><thead><tr><th scope="col">{t('bk.night')}</th><th scope="col">{t('bk.rate')}</th><th scope="col">{t('bk.discount')}</th><th scope="col">{t('bk.youCharge')}</th></tr></thead>
              <tbody>{o.nights.map((n) => <tr key={n.date}><th scope="row">{shortDate(n.date, locale)}</th><td dir="ltr">{money({ amount: n.total, currency: o.totalExTax.currency })}</td><td dir="ltr">{n.discountPct > 0 ? `−${n.discountPct}%` : '—'}</td><td dir="ltr"><strong>{money({ amount: n.payable, currency: o.totalExTax.currency })}</strong></td></tr>)}</tbody></table>
            {!o.bookable && <p className="warnbox small">{t('bk.needsApproval')}</p>}
            {o.taxes && o.taxes.length > 0 && o.taxTotal && o.totalIncTax && <div className="small">{o.taxes.map((x) => <div key={x.code + x.ratePercent} className="row between muted"><span>{x.code} {x.ratePercent}%</span><span dir="ltr">{money(x.tax)}</span></div>)}<div className="row between"><strong>{t('bk.totalIncTax')}</strong><strong>{money(o.totalIncTax)}</strong></div></div>}
            {o.depositDue.amount !== '0.00' && <p className="small">{t('bk.deposit')}: {money(o.depositDue)}</p>}
            <ul className="small muted">{policyLines(t, o.policy).map((l) => <li key={l}>{l}</li>)}</ul>
            <div className="actions"><button className="primary" disabled={!o.bookable || repricing} onClick={() => { setChosen(o); setStep('guest'); clear(); }}>{t('bk.select')}</button></div>
          </div>
        ))}
        <div className="actions"><button onClick={() => setStep('search')}>{t('common.back')}</button></div>
      </>)}

      {step === 'guest' && chosen && (<>
        <p className="muted small">{chosen.roomType.name} · {money(chosen.totalExTax)}</p>
        <label>{t('bk.findGuest')}<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('bk.findGuestHint')} autoFocus /></label>
        {hits.length > 0 && <ul className="plain">{hits.map((h) => <li key={h.id}><button className="wide pick" disabled={(h.residency === 'NON_RESIDENT') !== foreign} title={(h.residency === 'NON_RESIDENT') !== foreign ? t('bk.residencyMismatch') : undefined} onClick={() => { setGuest(h); setStep('confirm'); clear(); }}><strong>{h.fullName}{h.vip ? ' ★' : ''}</strong> <span className="muted small">{h.phone ?? ''} {h.nationality ?? ''}</span></button></li>)}</ul>}
        <h3>{t('bk.newGuest')}</h3>
        <label>{t('ci.name')}<input value={nf.fullName} onChange={(e) => setNf({ ...nf, fullName: e.target.value })} /></label>
        <div className="grid2"><label>{t('bk.phone')}<input value={nf.phone} onChange={(e) => setNf({ ...nf, phone: e.target.value })} dir="ltr" inputMode="tel" /></label><label>{t('ci.nationality')}<input value={nf.nationality} maxLength={2} onChange={(e) => setNf({ ...nf, nationality: e.target.value.toUpperCase() })} dir="ltr" /></label></div>
        {(nf.nationality.trim().toUpperCase() !== 'PK' && nf.nationality.trim() !== '') !== foreign && <p className="warnbox small">{t('bk.residencyMismatch')}</p>}
        <div className="actions"><button className="primary" disabled={nf.fullName.trim().length < 2 || (nf.nationality.trim().toUpperCase() !== 'PK' && nf.nationality.trim() !== '') !== foreign} onClick={() => { setGuest(null); setStep('confirm'); clear(); }}>{t('bk.useNew')}</button><button onClick={() => setStep('options')}>{t('common.back')}</button></div>
      </>)}

      {step === 'confirm' && chosen && (<>
        <div className="card inner"><strong>{guest ? guest.fullName : nf.fullName}</strong><p className="muted small">{chosen.roomType.name} · {shortDate(arrival, locale)} → {shortDate(departure, locale)} · <strong>{money(chosen.totalExTax)}</strong> {t('d.exTax')}</p></div>
        <label className="check"><input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} /> {t('bk.hold')}</label>
        {hold && (
          <div className="grid2">
            <label>{t('bk.holdFor')}<select value={holdKind} onChange={(e) => setHoldKind(e.target.value as typeof holdKind)}><option value="half">{t('bk.holdHalf')}</option><option value="days">{t('bk.holdDays')}</option><option value="date">{t('bk.holdDate')}</option></select></label>
            {holdKind === 'half' && <label>{t('bk.holdHalfCount')}<select value={holdHalf} onChange={(e) => setHoldHalf(Number(e.target.value))}>{[1, 2, 3, 4, 6, 8, 12, 16, 24, 36, 48].map((n) => <option key={n} value={n}>{n % 2 ? `${Math.floor(n / 2)}½` : n / 2} {t('bk.hours')}</option>)}</select></label>}
            {holdKind === 'days' && <label>{t('bk.holdDaysCount')}<input type="number" min={1} max={30} value={holdDays} onChange={(e) => setHoldDays(Math.min(30, Math.max(1, Math.floor(Number(e.target.value)) || 1)))} dir="ltr" /></label>}
            {holdKind === 'date' && <label>{t('bk.holdUntil')}<input type="date" min={businessDate} max={holdLast} value={holdUntil} onChange={(e) => setHoldDate(e.target.value)} dir="ltr" /></label>}
          </div>
        )}
        {hold && <p className="muted small">{t('bk.holdNote')}</p>}
        <label>{t('bk.extRef')} ({t('common.optional')})<input value={ext} onChange={(e) => setExt(e.target.value)} dir="ltr" /></label>
        <label>{t('common.note')} ({t('common.optional')})<input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <ErrorLine code={problem?.code === 'DUPLICATE_GUEST' ? undefined : problem?.code} detail={problem?.detail} />
        <ApprovalBox problem={problem} busy={busy} onApprove={(reason) => lastBook[0] && void book(lastBook[0].g, reason)} />
        {problem?.code === 'DUPLICATE_GUEST' && <DuplicateChoice onUse={(g) => { setGuest(g); clear(); void book({ guestId: g.id }); }} onForce={() => void book({ guest: { fullName: nf.fullName.trim(), phone: nf.phone.trim() || undefined, nationality: nf.nationality.toUpperCase() || 'PK', allowDuplicate: true } })} base={base} phone={nf.phone} name={nf.fullName} />}
        <div className="actions"><button className="primary" disabled={busy} onClick={() => (guest ? book({ guestId: guest.id }) : book({ guest: { fullName: nf.fullName.trim(), ...(nf.phone.trim() ? { phone: nf.phone.trim() } : {}), nationality: nf.nationality.toUpperCase() || 'PK' } }))}>{hold ? t('bk.holdBtn') : t('bk.confirmBtn')}</button><button onClick={() => setStep('guest')}>{t('common.back')}</button></div>
      </>)}

      {step === 'done' && result && (<>
        <p className="ok big" role="status">✓ {result.confirmationNo}</p>
        <p>{name} · {money(result.totalExTax)} {t('d.exTax')}</p>
        <ComplianceNotes hits={result.compliance ?? []} />
        {result.guarantee.atRisk && <p className="warnbox">⚠ {t('rs.atRisk')} · {t('rs.depositNeeded')}: {money(result.guarantee.depositRequired)}</p>}
        <details open className="block"><summary>{t('wa.title')}</summary><ConfirmationMessage guestName={name} phone={guest?.phone ?? nf.phone} confirmationNo={result.confirmationNo} arrival={arrival} departure={departure} /></details>
        <div className="actions">
          <button className="primary" onClick={() => onOpenReservation(result.id)}>{t('bk.open')}</button>
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
      </>)}
      {busy && step !== 'search' && <Spinner />}
    </Sheet>
  );
}

/** The server found someone with the same phone or email. Use that person, or confirm it really is a different guest. */
function DuplicateChoice({ onUse, onForce, base, phone, name }: { onUse: (g: GuestHit) => void; onForce: () => void; base: string; phone: string; name: string }) {
  const { t } = useT();
  const [cands, setCands] = useState<GuestHit[]>([]);
  useEffect(() => { api<{ items: GuestHit[] }>('GET', `/v1/guests/search?q=${encodeURIComponent(phone || name)}`).then((r) => setCands(r.items)).catch(() => undefined); }, [phone, name, base]);
  return (
    <div className="warnbox stack"><strong>{t('bk.dupTitle')}</strong>
      <ul className="plain">{cands.map((c) => <li key={c.id}><button className="wide pick" onClick={() => onUse(c)}>{c.fullName} <span className="muted small">{c.phone}</span></button></li>)}</ul>
      <button onClick={onForce}>{t('bk.dupForce')}</button></div>
  );
}
