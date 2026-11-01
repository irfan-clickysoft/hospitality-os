import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAction } from '../lib/action.js';
import { addDays, money, newKey, nightsBetween, shortDate } from '../lib/format.js';
import { checkOccupant, hasErrors } from '../lib/occupants.js';
import { useAuth, useLive } from '../state.js';
import { Banner } from '../ui/ds.js';
import { ErrorLine, Sheet } from '../ui/kit.js';
import { useStepUp } from '../lib/stepup.js';
import { ApprovalBox } from './ComplianceBits.js';
import { PurposeField } from './RegExtras.js';
import { NegotiateBox, negotiationParams, noNegotiation, type Negotiation } from './Negotiate.js';
import { blankOccupant, OccupantsForm, occupantBody, type Occupant } from './CheckInSheet.js';
import type { Matrix } from '../lib/occupants.js';
import type { Amount, RackData } from './types.js';

interface PlanOption { roomType: { id: string }; plan: { id: string; name: string; mealPlan: string }; totalExTax: Amount; subtotal: Amount; bookable: boolean; quoteToken: string | null; discount: { pct: number; amount: string } | null }
interface Known { id: string; fullName: string; phone: string | null; nationality: string | null; residency: 'RESIDENT' | 'NON_RESIDENT'; vip: boolean; doNotRent: boolean; stays: number; lastStay: string | null; matchedById: boolean }

/** A guest at the desk with no booking: find them if they have stayed before, price it, book it and check them in as one step. */
export function WalkIn({ businessDate, onClose, onOpenReservation }: { businessDate: string; onClose: () => void; onOpenReservation: (id: string) => void }) {
  const { t, locale } = useT();
  const { property } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const rack = useLive<RackData>(`${base}/rack?days=1`, 30_000);
  const matrix = useLive<Matrix>(`${base}/registration/requirements`, 600_000).data;
  const key = useMemo(newKey, []);
  const [typeId, setTypeId] = useState(''); const [nights, setNights] = useState(1); const [adults, setAdults] = useState(2); const [children, setChildren] = useState(0); const [extraBeds, setExtraBeds] = useState(0); const [foreign, setForeign] = useState(false);
  const [planId, setPlanId] = useState(''); const [neg, setNeg] = useState<Negotiation>(noNegotiation);
  const [purpose, setPurpose] = useState('');
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [occ, setOcc] = useState<Occupant[]>([blankOccupant('', false)]);
  const [options, setOptions] = useState<PlanOption[]>([]); const [done, setDone] = useState<{ id: string; confirmationNo: string } | null>(null);
  const [known, setKnown] = useState<Known | null>(null); const [q, setQ] = useState(''); const [hits, setHits] = useState<Known[]>([]); const [searched, setSearched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const { busy, problem, run } = useAction();
  const withStepUp = useStepUp();
  const types = rack.data?.roomTypes ?? [];
  const free = (id: string) => (types.find((x) => x.id === id)?.availability[0]?.available ?? 0);
  useEffect(() => { if (!typeId && types[0]) setTypeId((types.find((x) => free(x.id) > 0) ?? types[0]).id); }, [types]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setOcc((o) => o.map((x, i) => (i === 0 ? { ...x, fullName: name } : x))); }, [name]);
  useEffect(() => { setOcc((o) => o.map((x, i) => (i === 0 ? { ...x, idType: foreign ? 'PASSPORT' : 'CNIC', nationality: foreign ? '' : 'PK' } : x))); }, [foreign]);

  // returning guests: any part of the name, a phone number, a CNIC or a passport
  useEffect(() => {
    const text = q.trim();
    if (known || text.length < 3) { setHits([]); setSearched(false); return; }
    let dead = false;
    const h = setTimeout(() => { api<{ items: Known[] }>('GET', `/v1/guests/search?q=${encodeURIComponent(text)}`).then((r) => { if (!dead) { setHits(r.items); setSearched(true); } }).catch(() => { if (!dead) { setHits([]); setSearched(true); } }); }, 300);
    return () => { dead = true; clearTimeout(h); };
  }, [q, known]);
  const pick = (g: Known) => { setKnown(g); setName(g.fullName); setPhone(g.phone ?? ''); setForeign(g.residency === 'NON_RESIDENT'); setQ(''); setHits([]); if (g.nationality) setOcc((o) => o.map((x, i) => (i === 0 ? { ...x, nationality: g.nationality! } : x))); };
  const clearKnown = () => { setKnown(null); };

  const negQ = JSON.stringify(negotiationParams(neg, businessDate));
  const quoteBody = () => ({ arrival: businessDate, departure: addDays(businessDate, nights), adults, children, extraBeds, channel: 'WALKIN', residency: foreign ? 'NON_RESIDENT' : 'RESIDENT', roomTypeId: typeId, ...(JSON.parse(negQ) as object) });
  useEffect(() => {
    if (!typeId) return;
    let dead = false;
    const h = setTimeout(() => {
      api<{ options: PlanOption[] }>('POST', `${base}/quotes`, quoteBody())
        .then((r) => { if (dead) return; setOptions(r.options); setPlanId((cur) => (r.options.some((x) => x.plan.id === cur) ? cur : r.options.find((x) => x.bookable)?.plan.id ?? r.options[0]?.plan.id ?? '')); }).catch(() => !dead && setOptions([]));
    }, neg.kind === 'none' ? 0 : 400);
    return () => { dead = true; clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeId, nights, adults, children, extraBeds, foreign, base, businessDate, negQ]);
  const chosen = options.find((x) => x.plan.id === planId) ?? null;

  const errors = occ.map((o, i) => checkOccupant(o, i, foreign, businessDate));
  const submit = async (approval?: string) => {
    if (!approval) {
      setAttempted(true);
      if (name.trim().length < 2 || hasErrors(errors)) { window.setTimeout(() => (document.querySelector('.sheet [aria-invalid="true"]') as HTMLElement | null)?.focus(), 30); return; }
    }
    const body = { ...(known ? { guestId: known.id } : { guest: { fullName: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}), nationality: foreign ? (occ[0]?.nationality || 'XX') : 'PK' } }),
      roomTypeId: typeId, nights, adults, children, extraBeds, ...(planId ? { ratePlanId: planId } : {}), occupants: occ.map((o, i) => occupantBody(o, i === 0)), ...(purpose.trim() ? { purposeOfVisit: purpose.trim() } : {}), ...(approval ? { complianceApproval: { reason: approval } } : {}) };
    // a negotiated price: price it again now (the signed quote lasts only a few minutes) and book at exactly that
    const call = async () => {
      let quoteToken: string | undefined;
      if (negQ !== '{}') { const fresh = await api<{ options: PlanOption[] }>('POST', `${base}/quotes`, quoteBody()); const o = fresh.options.find((x) => x.plan.id === planId) ?? fresh.options[0]; if (!o?.quoteToken) throw new ApiError(403, 'APPROVAL_REQUIRED', t('ng.needsApproval')); quoteToken = o.quoteToken; }
      return api<{ id: string; confirmationNo: string }>('POST', `${base}/front-desk/walk-ins`, { ...body, ...(quoteToken ? { quoteToken } : {}) }, { 'idempotency-key': key });
    };
    const r = await run(() => (approval ? withStepUp(call) : call()));
    if (r) setDone(r);
  };
  const stepper = (label: string, value: number, set: (n: number) => void, min: number, max: number) => <label>{label}<input type="number" min={min} max={max} value={value} onChange={(e) => set(Math.min(max, Math.max(min, Math.floor(Number(e.target.value)) || min)))} dir="ltr" /></label>;
  return (
    <Sheet title={t('wi.title')} onClose={onClose}>
      {done ? (<><p className="ok big" role="status">✓ {done.confirmationNo}</p><div className="actions"><button className="primary" onClick={() => onOpenReservation(done.id)}>{t('bk.open')}</button><button onClick={onClose}>{t('common.close')}</button></div></>) : (<>
        {known ? (
          <div className="card inner stack" role="status">
            <div className="row between"><strong>{known.fullName}{known.vip ? ' ★' : ''}</strong><button className="link" onClick={clearKnown}>{t('wi.notThem')}</button></div>
            <p className="muted small">{t('wi.returning')} · {known.stays > 0 ? t('wi.stays', { n: known.stays }) : t('wi.noStays')}{known.lastStay ? ` · ${t('wi.last')} ${shortDate(known.lastStay, locale)}` : ''}{known.phone ? ` · ${known.phone}` : ''}</p>
            {known.doNotRent && <Banner level="BLOCKER" title={t('bl.GUEST_FLAGGED')}>{t('bl.d.GUEST_FLAGGED')}</Banner>}
          </div>
        ) : (
          <div className="stack">
            <label>{t('wi.find')}<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('wi.findHint')} autoComplete="off" /></label>
            {hits.length > 0 && <ul className="plain" aria-label={t('wi.results')}>{hits.map((g) => <li key={g.id}><button className="wide pick" onClick={() => pick(g)}><strong>{g.fullName}</strong> <span className="muted small">{[g.phone, g.nationality, g.stays > 0 ? t('wi.stays', { n: g.stays }) : null, g.matchedById ? t('wi.byId') : null].filter(Boolean).join(' · ')}</span></button></li>)}</ul>}
            {searched && hits.length === 0 && <p className="muted small">{t('wi.noMatch')}</p>}
          </div>
        )}
        <label>{t('wi.type')}<select value={typeId} onChange={(e) => setTypeId(e.target.value)}>{types.map((x) => <option key={x.id} value={x.id} disabled={free(x.id) <= 0}>{x.name} ({t('bk.left', { n: free(x.id) })})</option>)}</select></label>
        <label>{t('bk.departure')}<input type="date" value={addDays(businessDate, nights)} min={addDays(businessDate, 1)} max={addDays(businessDate, 30)} onChange={(e) => { if (e.target.value) setNights(Math.min(30, Math.max(1, nightsBetween(businessDate, e.target.value)))); }} dir="ltr" /></label>
        <div className="grid2">{stepper(t('bk.nights'), nights, setNights, 1, 30)}{stepper(t('d.adults'), adults, setAdults, 1, 6)}{stepper(t('d.children'), children, setChildren, 0, 6)}{stepper(t('wi.mattress'), extraBeds, setExtraBeds, 0, 3)}</div>
        <p className="muted small">{t('wi.mattressHint')}</p>
        <label className="check"><input type="checkbox" checked={foreign} onChange={(e) => setForeign(e.target.checked)} /> {t('bk.foreign')}</label>
        {options.length > 1 && <label>{t('wi.plan')}<select value={planId} onChange={(e) => setPlanId(e.target.value)}>{options.map((x) => <option key={x.plan.id} value={x.plan.id}>{x.plan.name} — {money(x.totalExTax)}</option>)}</select></label>}
        <NegotiateBox value={neg} onChange={setNeg} />
        <div className="card inner stack"><div className="row between"><span>{t('wi.price')}{chosen ? ` · ${chosen.plan.name}` : ''}</span><strong className="big">{chosen ? money(chosen.totalExTax) : '—'}</strong></div>
          {chosen && chosen.discount && Number(chosen.discount.amount) > 0 && <p className="small">{t('ng.was')}: <s dir="ltr">{money(chosen.subtotal)}</s> · {t('ng.saves', { amt: money({ amount: chosen.discount.amount, currency: chosen.totalExTax.currency }) })}</p>}
          {chosen && !chosen.bookable && <p className="warnbox small" role="alert">{t('ng.needsApproval')}</p>}</div>
        <p className="muted small">{t('bk.exTaxNote')}</p>
        {!known && <>
          <label>{t('ci.name')}<input value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-invalid={attempted && name.trim().length < 2 ? true : undefined} /></label>
          <label>{t('bk.phone')}<input value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" inputMode="tel" /></label>
        </>}
        <h3>{t('ci.guests')}</h3>
        <p className="muted small">{t('wi.idNote')}</p>
        <OccupantsForm occupants={occ} onChange={setOcc} foreign={foreign} businessDate={businessDate} attempted={attempted} matrix={matrix} />
        <PurposeField value={purpose} onChange={setPurpose} />
        {attempted && hasErrors(errors) && <Banner level="ACTION" title={t('ci.e.fix')} />}
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        <ApprovalBox problem={problem} busy={busy} onApprove={(r) => void submit(r)} />
        <div className="actions"><button className="primary" disabled={busy || !chosen || !chosen.bookable || known?.doNotRent} onClick={() => void submit()}>{t('wi.go')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
      </>)}
    </Sheet>
  );
}
