import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { addDays, nightsBetween, whatsappNumber } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import { Link } from '../shell/router.js';
import { EmailSend } from './EmailSend.js';

interface Disc { kind: 'NONE' | 'PCT' | 'AMOUNT'; value?: string | null }
interface PLine { lineId: string | null; roomTypeName: string; planName: string; rooms: number; arrival: string; departure: string; nights: number; bands: Array<{ from: string; to: string; nights: number; rate: string; label: string }>; gross: string; discount: string; net: string; tax: string; total: string; warning: string | null }
interface Pricing { currency: string; lines: PLine[]; gross: string; discount: string; net: string; tax: string; total: string; deposit: { kind: string; amount: string } }
interface Item { id: string; number: string; status: string; expired: boolean; customerName: string; validUntil: string; total: string | null; currency: string | null; rooms: number; arrival: string | null; departure: string | null; answered: boolean; views: number }
interface Detail { id: string; number: string; status: string; expired: boolean; customerName: string; address: string | null; customerRef: string | null; balanceDueDays: number | null; companyId: string | null; guestId: string | null; contactName: string | null; phone: string | null; email: string | null; residency: 'RESIDENT' | 'NON_RESIDENT'; title: string | null; validUntil: string;
  discount: { kind: string; value?: string | null; minor?: string | null }; discountReason: string | null; deposit: { kind: string; value?: string | null; minor?: string | null }; specialRequests: string | null; amenities: string[]; terms: string | null; notesInternal: string | null; pricing: Pricing | null; version: number;
  sentAt: string | null; views: number; response: { at: string; name: string | null; note: string | null; seen: boolean } | null; convertedAt: string | null; reservationIds: string[];
  lines: Array<{ id: string; roomTypeId: string; ratePlanId: string | null; rooms: number; arrival: string; departure: string; adults: number; children: number; extraBeds: number; roomNumbers: string | null; discount: Disc; note: string | null }> }
interface RoomType { id: string; code: string; name: string; status: string }
interface Room { id: string; roomTypeId: string; status: string }

const minorMoney = (minor: string, cur: string) => { const n = BigInt(minor); const neg = n < 0n; const a = neg ? -n : n; const w = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); const f = (a % 100n).toString().padStart(2, '0'); return `${neg ? '−' : ''}${cur} ${w}${f === '00' ? '' : `.${f}`}`; };
const TONE: Record<string, 'clean' | 'warn' | 'neutral' | 'dirty' | 'cleaning'> = { DRAFT: 'neutral', SENT: 'cleaning', ACCEPTED: 'clean', DECLINED: 'dirty', CANCELLED: 'neutral', CONVERTED: 'clean' };
const STATUSES = ['OPEN', 'SENT', 'ACCEPTED', 'DECLINED', 'CONVERTED', 'ALL'] as const;
const AMENITY_IDEAS = ['Breakfast for all guests', 'Free Wi-Fi', 'Daily housekeeping', 'Airport pickup', 'Parking', 'Tea and coffee in the room', 'Laundry (weekly)', 'Late check-out', 'Meeting space'];

/** Quotations: price a stay (a few nights, a month, or the whole guest house), discount it, send it as a private page the customer can accept, and turn it into a booking. */
export function Quotations() {
  const { t } = useT(); const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/quotations`;
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('OPEN'); const [q, setQ] = useState('');
  const list = useLive<{ items: Item[]; counts: Record<string, number> }>(`${base}?status=${status}${q.trim().length >= 2 ? `&q=${encodeURIComponent(q.trim())}` : ''}`, 20_000);
  const [open, setOpen] = useState<string | null>(null); const [edit, setEdit] = useState<Detail | 'new' | null>(null); const [wording, setWording] = useState(false);
  const canWrite = can('reservation.create');
  return (
    <section className="stack">
      <div className="page-head"><h2>{t('qt.title')}</h2><div className="head-actions">{can('property.manage') && <button onClick={() => setWording(true)}>{t('qt.wording')}</button>}{canWrite && <button className="primary" onClick={() => setEdit('new')}>{t('qt.new')}</button>}</div></div>
      <p className="muted small">{t('qt.intro')}</p>
      <div className="toolbar">
        <div className="chips" role="group" aria-label={t('qt.title')}>{STATUSES.map((s) => <Chip key={s} active={status === s} onClick={() => setStatus(s)}>{t(`qt.f.${s}` as Key)}{s !== 'OPEN' && s !== 'ALL' && list.data?.counts[s] ? ` (${list.data.counts[s]})` : ''}</Chip>)}</div>
        <input type="search" className="filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('qt.search')} aria-label={t('qt.search')} />
      </div>
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('qt.none')} /> : (
        <ul className="plain queue">{list.data.items.map((x) => (
          <li key={x.id}><button className="qrow" onClick={() => setOpen(x.id)}>
            <span className="avatar" aria-hidden="true">{x.customerName.slice(0, 2).toUpperCase()}</span>
            <span className="q-main"><strong>{x.customerName}</strong><span className="muted small">{x.number} · {x.rooms} {t('qt.rooms')}{x.arrival ? ` · ${x.arrival} → ${x.departure}` : ''} · {t('qt.validUntil', { date: x.validUntil })}</span></span>
            <span className="q-badges">{x.answered && <Badge tone="warn">{t('qt.answered')}</Badge>}<Badge tone={x.expired ? 'dirty' : TONE[x.status] ?? 'neutral'}>{x.expired ? t('qt.s.EXPIRED') : t(`qt.s.${x.status}` as Key)}</Badge></span>
            {x.total && x.currency && <span className="room-pill">{minorMoney(x.total, x.currency)}</span>}
          </button></li>))}</ul>)}
      {wording && <QuotationWording base={base} onClose={() => setWording(false)} />}
      {open && <QuotationView id={open} base={base} onClose={() => { setOpen(null); list.reload(); }} onEdit={(d) => { setOpen(null); setEdit(d); }} />}
      {edit && <QuotationEditor base={base} initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={(id) => { setEdit(null); list.reload(); setOpen(id); }} />}
    </section>
  );
}

// ───────────────────────── the editor ─────────────────────────
interface LineForm { roomNumbers: string; roomTypeId: string; rooms: number; arrival: string; departure: string; adults: number; children: number; extraBeds: number; dKind: 'NONE' | 'PCT' | 'AMOUNT'; dValue: string; note: string }
const disc = (kind: string, v: string): Disc => (kind === 'NONE' || !v.trim() ? { kind: 'NONE' } : { kind: kind as 'PCT' | 'AMOUNT', value: v.trim() });

function QuotationEditor({ base, initial, onClose, onSaved }: { base: string; initial: Detail | null; onClose: () => void; onSaved: (id: string) => void }) {
  const { t } = useT(); const { property, can } = useAuth(); const { busy, problem, run } = useAction();
  const pb = `/v1/properties/${property!.id}`; const bd = property!.businessDate;
  const types = useLive<{ items: RoomType[] }>(`${pb}/room-types`, 300_000); const rooms = useLive<{ items: Room[] }>(`${pb}/rooms`, 300_000);
  const companies = useLive<{ items: Array<{ id: string; name: string; status: string }> }>(can('company.view') ? '/v1/companies' : null, 300_000);
  const tList = (types.data?.items ?? []).filter((x) => x.status === 'ACTIVE');
  const [f, setF] = useState(() => initial ? {
    customerName: initial.customerName, address: initial.address ?? '', customerRef: initial.customerRef ?? '', balanceDays: initial.balanceDueDays === null ? '' : String(initial.balanceDueDays), companyId: initial.companyId ?? '', contactName: initial.contactName ?? '', phone: initial.phone ?? '', email: initial.email ?? '', residency: initial.residency, title: initial.title ?? '', validUntil: initial.validUntil,
    dKind: (initial.discount.kind as 'NONE' | 'PCT' | 'AMOUNT'), dValue: initial.discount.kind === 'PCT' ? String(initial.discount.value ?? '') : initial.discount.kind === 'AMOUNT' ? String(Number(initial.discount.minor ?? 0) / 100) : '', dReason: initial.discountReason ?? '',
    pKind: (initial.deposit.kind as 'NONE' | 'PCT' | 'AMOUNT'), pValue: initial.deposit.kind === 'PCT' ? String(initial.deposit.value ?? '') : initial.deposit.kind === 'AMOUNT' ? String(Number(initial.deposit.minor ?? 0) / 100) : '',
    requests: initial.specialRequests ?? '', amenities: initial.amenities, terms: initial.terms ?? '', notes: initial.notesInternal ?? '' } : {
    customerName: '', address: '', customerRef: '', balanceDays: '30', companyId: '', contactName: '', phone: '', email: '', residency: 'RESIDENT' as const, title: '', validUntil: addDays(bd, 7), dKind: 'NONE' as 'NONE' | 'PCT' | 'AMOUNT', dValue: '', dReason: '', pKind: 'PCT' as 'NONE' | 'PCT' | 'AMOUNT', pValue: '30', requests: '', amenities: [] as string[], terms: '', notes: '' });
  const [lines, setLines] = useState<LineForm[]>(() => initial ? initial.lines.map((l) => ({ roomNumbers: l.roomNumbers ?? '', roomTypeId: l.roomTypeId, rooms: l.rooms, arrival: l.arrival, departure: l.departure, adults: l.adults, children: l.children, extraBeds: l.extraBeds, dKind: l.discount.kind as 'NONE' | 'PCT' | 'AMOUNT', dValue: String(l.discount.value ?? ''), note: l.note ?? '' }))
    : [{ roomNumbers: '', roomTypeId: '', rooms: 1, arrival: addDays(bd, 1), departure: addDays(bd, 4), adults: 2, children: 0, extraBeds: 0, dKind: 'NONE', dValue: '', note: '' }]);
  const [idea, setIdea] = useState(''); const [priced, setPriced] = useState<Pricing | null>(initial?.pricing ?? null); const [pricing, setPricing] = useState(false); const [priceErr, setPriceErr] = useState<string | null>(null);
  useEffect(() => { if (tList.length && lines.some((l) => !l.roomTypeId)) setLines((ls) => ls.map((l) => (l.roomTypeId ? l : { ...l, roomTypeId: tList[0]!.id }))); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [types.data]);
  const setCo = (id: string) => { const c = companies.data?.items.find((x) => x.id === id); setF((x) => ({ ...x, companyId: id, customerName: id && !x.customerName ? c?.name ?? '' : x.customerName, pKind: id ? 'NONE' : x.pKind === 'NONE' ? 'PCT' : x.pKind, pValue: id ? '' : x.pValue || '30' })); };
  const body = useMemo(() => ({
    customerName: f.customerName.trim(), address: f.address.trim() || null, customerRef: f.customerRef.trim() || null, balanceDueDays: f.balanceDays.trim() === '' ? null : Math.min(365, Math.max(0, Math.floor(Number(f.balanceDays)) || 0)), companyId: f.companyId || null, contactName: f.contactName.trim() || null, phone: f.phone.trim() || null, email: f.email.trim() || null, residency: f.residency, title: f.title.trim() || null, validUntil: f.validUntil,
    discount: disc(f.dKind, f.dValue), discountReason: f.dReason.trim() || null, deposit: disc(f.pKind, f.pValue), specialRequests: f.requests.trim() || null, amenities: f.amenities, terms: f.terms.trim() || null, notesInternal: f.notes.trim() || null,
    lines: lines.filter((l) => l.roomTypeId).map((l) => ({ roomNumbers: l.roomNumbers.trim() || null, roomTypeId: l.roomTypeId, rooms: l.rooms, arrival: l.arrival, departure: l.departure, adults: l.adults, children: l.children, extraBeds: l.extraBeds, discount: disc(l.dKind, l.dValue), note: l.note.trim() || null })) }), [f, lines]);
  const ready = body.customerName.length >= 2 && body.lines.length > 0 && body.lines.every((l) => l.departure > l.arrival && l.rooms >= 1);
  // the figures follow what is on the screen
  const sig = JSON.stringify(body);
  useEffect(() => {
    if (!ready) return;
    let dead = false; setPricing(true);
    const h = window.setTimeout(() => { api<Pricing>('POST', `${base}/price`, body).then((r) => { if (!dead) { setPriced(r); setPriceErr(null); } }).catch((e) => { if (!dead) { setPriced(null); setPriceErr(e?.message ?? 'error'); } }).finally(() => { if (!dead) setPricing(false); }); }, 600);
    return () => { dead = true; window.clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const setLine = (k: number, patch: Partial<LineForm>) => setLines((ls) => ls.map((l, i) => (i === k ? { ...l, ...patch } : l)));
  const wholeHouse = () => {
    const first = lines[0]!; const count = (id: string) => (rooms.data?.items ?? []).filter((r) => r.roomTypeId === id && r.status === 'ACTIVE').length;
    setLines(tList.filter((x) => count(x.id) > 0).map((x) => ({ ...first, roomTypeId: x.id, rooms: count(x.id) })));
  };
  const save = async () => {
    const r = await run(() => (initial ? api<Detail>('PUT', `${base}/${initial.id}`, { ...body, version: initial.version }) : api<Detail>('POST', base, body)));
    if (r) onSaved(r.id);
  };
  const addAmenity = (a: string) => { const v = a.trim(); if (v && !f.amenities.includes(v) && f.amenities.length < 30) setF((x) => ({ ...x, amenities: [...x.amenities, v] })); setIdea(''); };
  return (
    <Sheet title={initial ? `${t('qt.edit')} ${initial.number}` : t('qt.new')} onClose={onClose} wide>
      <div className="qe">
        <div className="qe-form stack">
          <fieldset className="guestcard"><legend>{t('qt.customer')}</legend>
            <div className="grid2">
              <label>{t('qt.company')}<select value={f.companyId} onChange={(e) => setCo(e.target.value)}><option value="">{t('qt.individual')}</option>{(companies.data?.items ?? []).filter((c) => c.status === 'ACTIVE').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <label>{t('qt.customerName')}<input value={f.customerName} onChange={(e) => setF({ ...f, customerName: e.target.value })} maxLength={120} /></label>
              <label>{t('qt.contact')}<input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} maxLength={120} /></label>
              <label>{t('bk.phone')}<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} dir="ltr" inputMode="tel" /></label>
              <label>{t('qt.email')}<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} dir="ltr" /></label>
              <label className="span2">{t('qt.address')}<input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} maxLength={300} /></label>
              <label>{t('qt.customerRef')}<input value={f.customerRef} onChange={(e) => setF({ ...f, customerRef: e.target.value })} maxLength={60} dir="ltr" /></label>
              <label>{t('qt.residency')}<select value={f.residency} onChange={(e) => setF({ ...f, residency: e.target.value as 'RESIDENT' | 'NON_RESIDENT' })}><option value="RESIDENT">{t('qt.resident')}</option><option value="NON_RESIDENT">{t('qt.foreign')}</option></select></label>
            </div>
            <label>{t('qt.heading')}<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={160} placeholder={t('qt.headingHint')} /></label>
          </fieldset>
          <fieldset className="guestcard"><legend>{t('qt.stay')}</legend>
            {lines.map((l, k) => (
              <div key={k} className="card inner stack">
                <div className="grid2">
                  <label>{t('qt.roomType')}<select value={l.roomTypeId} onChange={(e) => setLine(k, { roomTypeId: e.target.value })}>{tList.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
                  <label>{t('qt.roomsCount')}<input type="number" min={1} max={60} value={l.rooms} onChange={(e) => setLine(k, { rooms: Math.min(60, Math.max(1, Math.floor(Number(e.target.value)) || 1)) })} dir="ltr" /></label>
                  <label>{t('qt.arrival')}<input type="date" min={bd} value={l.arrival} onChange={(e) => setLine(k, { arrival: e.target.value, ...(l.departure <= e.target.value ? { departure: addDays(e.target.value, 1) } : {}) })} dir="ltr" /></label>
                  <label>{t('qt.departure')}<input type="date" min={addDays(l.arrival, 1)} value={l.departure} onChange={(e) => setLine(k, { departure: e.target.value })} dir="ltr" /></label>
                  <label>{t('qt.adults')}<input type="number" min={1} max={20} value={l.adults} onChange={(e) => setLine(k, { adults: Math.max(1, Math.floor(Number(e.target.value)) || 1) })} dir="ltr" /></label>
                  <label>{t('qt.children')}<input type="number" min={0} max={20} value={l.children} onChange={(e) => setLine(k, { children: Math.max(0, Math.floor(Number(e.target.value)) || 0) })} dir="ltr" /></label>
                </div>
                <div className="row"><span className="muted small">{l.departure > l.arrival ? t('d.nights', { n: nightsBetween(l.arrival, l.departure) }) : ''}</span></div>
                <div className="grid2">
                  <label>{t('qt.lineDiscount')}<select value={l.dKind} onChange={(e) => setLine(k, { dKind: e.target.value as LineForm['dKind'] })}><option value="NONE">{t('qt.noDiscount')}</option><option value="PCT">{t('qt.pct')}</option><option value="AMOUNT">{t('qt.amount')}</option></select></label>
                  {l.dKind !== 'NONE' && <label>{l.dKind === 'PCT' ? t('qt.pctValue') : t('qt.amountForLine')}<input value={l.dValue} onChange={(e) => setLine(k, { dValue: e.target.value })} dir="ltr" inputMode="decimal" /></label>}
                </div>
                <label>{t('qt.roomNumbers')}<input value={l.roomNumbers} onChange={(e) => setLine(k, { roomNumbers: e.target.value })} maxLength={200} placeholder={t('qt.roomNumbersHint')} dir="ltr" /></label>
                <label>{t('qt.lineNote')}<input value={l.note} onChange={(e) => setLine(k, { note: e.target.value })} maxLength={300} /></label>
                {lines.length > 1 && <button className="link" onClick={() => setLines((ls) => ls.filter((_, i) => i !== k))}>{t('qt.removeLine')}</button>}
              </div>))}
            <div className="actions"><button onClick={() => setLines((ls) => [...ls, { ...ls[ls.length - 1]!, rooms: 1, roomNumbers: '', dKind: 'NONE', dValue: '', note: '' }])}>{t('qt.addLine')}</button><button onClick={wholeHouse} disabled={!rooms.data}>{t('qt.wholeHouse')}</button></div>
          </fieldset>
          <fieldset className="guestcard"><legend>{t('qt.discountAdvance')}</legend>
            <div className="grid2">
              <label>{t('qt.overallDiscount')}<select value={f.dKind} onChange={(e) => setF({ ...f, dKind: e.target.value as 'NONE' | 'PCT' | 'AMOUNT' })}><option value="NONE">{t('qt.noDiscount')}</option><option value="PCT">{t('qt.pct')}</option><option value="AMOUNT">{t('qt.amount')}</option></select></label>
              {f.dKind !== 'NONE' && <label>{f.dKind === 'PCT' ? t('qt.pctValue') : t('qt.amountOff')}<input value={f.dValue} onChange={(e) => setF({ ...f, dValue: e.target.value })} dir="ltr" inputMode="decimal" /></label>}
              {f.dKind !== 'NONE' && <label className="span2">{t('qt.discountReason')}<input value={f.dReason} onChange={(e) => setF({ ...f, dReason: e.target.value })} maxLength={200} /></label>}
              <label>{t('qt.advance')}<select value={f.pKind} onChange={(e) => setF({ ...f, pKind: e.target.value as 'NONE' | 'PCT' | 'AMOUNT' })}><option value="NONE">{t('qt.noAdvance')}</option><option value="PCT">{t('qt.advPct')}</option><option value="AMOUNT">{t('qt.advAmount')}</option></select></label>
              {f.pKind !== 'NONE' && <label>{f.pKind === 'PCT' ? t('qt.pctValue') : t('qt.amountValue')}<input value={f.pValue} onChange={(e) => setF({ ...f, pValue: e.target.value })} dir="ltr" inputMode="decimal" /></label>}
            </div>
            {f.companyId && <p className="muted small">{t('qt.corpNoAdvance')}</p>}
            {f.pKind !== 'NONE' && <label>{t('qt.balanceDays')}<input type="number" min={0} max={365} value={f.balanceDays} onChange={(e) => setF({ ...f, balanceDays: e.target.value })} dir="ltr" /></label>}
            <label>{t('qt.validUntil2')}<input type="date" min={bd} value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} dir="ltr" /></label>
          </fieldset>
          <fieldset className="guestcard"><legend>{t('qt.details')}</legend>
            <div className="field"><label>{t('qt.amenities')}</label>
              <div className="chips">{f.amenities.map((a) => <button key={a} className="chip on" onClick={() => setF((x) => ({ ...x, amenities: x.amenities.filter((y) => y !== a) }))} aria-label={`${t('qt.remove')} ${a}`}>{a} ✕</button>)}</div>
              <div className="chips">{AMENITY_IDEAS.filter((a) => !f.amenities.includes(a)).map((a) => <button key={a} className="chip" onClick={() => addAmenity(a)}>+ {a}</button>)}</div>
              <div className="row"><input value={idea} onChange={(e) => setIdea(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAmenity(idea); } }} placeholder={t('qt.addAmenity')} maxLength={80} /><button onClick={() => addAmenity(idea)} disabled={!idea.trim()}>{t('qt.add')}</button></div>
            </div>
            <label>{t('qt.requests')}<textarea value={f.requests} onChange={(e) => setF({ ...f, requests: e.target.value })} maxLength={2000} rows={3} /></label>
            <label>{t('qt.terms')}<textarea value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} maxLength={4000} rows={3} placeholder={t('qt.termsHint')} /></label>
            <label>{t('qt.internal')}<textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={2000} rows={2} /></label>
          </fieldset>
        </div>
        <aside className="qe-side">
          <div className="card stack" aria-live="polite">
            <h3>{t('qt.figures')}</h3>
            {pricing && <p className="muted small">{t('common.loading')}</p>}
            {priceErr && <p className="warnbox small">{priceErr}</p>}
            {priced && <PricingView p={priced} />}
            {!priced && !priceErr && !pricing && <p className="muted small">{t('qt.fillIn')}</p>}
          </div>
          <ErrorLine code={problem?.code} detail={problem?.detail} />
          <div className="actions"><button className="primary" disabled={busy || !ready || !priced} onClick={save}>{t('qt.saveDraft')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
        </aside>
      </div>
    </Sheet>
  );
}

/** The figures as the customer will see them: each line by price band (so a season shows as its own rate), the discount, tax, total and advance. */
function PricingView({ p }: { p: Pricing }) {
  const { t } = useT(); const m = (x: string) => minorMoney(x, p.currency);
  return (
    <div className="stack small">
      {p.lines.map((l, k) => (
        <div key={k} className="pv-line">
          <div className="row between"><strong>{l.rooms} × {l.roomTypeName}</strong><span>{m(l.total)}</span></div>
          <ul className="plain muted">{l.bands.map((g, i) => <li key={i}>{g.nights} {t('qt.nightsAt')} {m(g.rate)}{g.label ? ` · ${g.label}` : ''}</li>)}</ul>
          {BigInt(l.discount) > 0n && <div className="row between ok"><span>{t('qt.discount')}</span><span>− {m(l.discount)}</span></div>}
          {l.warning && <p className="warnbox">{l.warning}</p>}
        </div>))}
      <div className="row between"><span>{t('qt.roomsNights')}</span><span>{m(p.gross)}</span></div>
      {BigInt(p.discount) > 0n && <div className="row between ok"><span>{t('qt.discount')}</span><span>− {m(p.discount)}</span></div>}
      <div className="row between"><span>{t('qt.beforeTax')}</span><span>{m(p.net)}</span></div>
      <div className="row between"><span>{t('qt.tax')}</span><span>{m(p.tax)}</span></div>
      <div className="row between big"><span>{t('qt.total')}</span><span>{m(p.total)}</span></div>
      {BigInt(p.deposit.amount) > 0n && <div className="row between"><span>{t('qt.advance')}</span><strong>{m(p.deposit.amount)}</strong></div>}
    </div>
  );
}

// ───────────────────────── one quotation ─────────────────────────
function QuotationView({ id, base, onClose, onEdit }: { id: string; base: string; onClose: () => void; onEdit: (d: Detail) => void }) {
  const { t } = useT(); const { can, property } = useAuth(); const { busy, problem, run, setProblem } = useAction();
  const d = useLive<Detail>(`${base}/${id}`, 15_000);
  const [sending, setSending] = useState(false); const [newPrice, setNewPrice] = useState<{ was: string; now: string; currency: string } | null>(null); const [made, setMade] = useState<Array<{ id: string; confirmationNo: string }> | null>(null);
  const q = d.data; const canWrite = can('reservation.create');
  const post = async (path: string, body: object = {}) => { const r = await run(() => api<Detail>('POST', `${base}/${id}/${path}`, body)); if (r) d.reload(); return r; };
  const convert = async (acceptNewPrice = false) => {
    setNewPrice(null);
    try { const r = await run(() => api<Detail & { bookings: Array<{ id: string; confirmationNo: string }> }>('POST', `${base}/${id}/convert`, { acceptNewPrice })); if (r) { setMade(r.bookings); d.reload(); } }
    catch { /* shown below */ }
  };
  useEffect(() => { if (problem?.code === 'PRICE_CHANGED') { api<Detail>('GET', `${base}/${id}`).then((x) => setNewPrice({ was: x.pricing?.total ?? '0', now: '', currency: x.pricing?.currency ?? 'PKR' })).catch(() => undefined); } }, [problem, base, id]);
  useEffect(() => { if (q?.response && !q.response.seen) void api('POST', `${base}/${id}/seen`, {}).catch(() => undefined); }, [q?.response?.at]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Sheet title={q ? `${q.number} · ${q.customerName}` : '…'} onClose={onClose} wide>
      {!q ? <Spinner /> : (
        <div className="qe">
          <div className="stack">
            <div className="row"><Badge tone={q.expired ? 'dirty' : TONE[q.status] ?? 'neutral'}>{q.expired ? t('qt.s.EXPIRED') : t(`qt.s.${q.status}` as Key)}</Badge><span className="muted small">{t('qt.validUntil', { date: q.validUntil })}{q.views ? ` · ${t('qt.viewed', { n: q.views })}` : ''}</span></div>
            {q.response && <div className={`card inner ${q.status === 'ACCEPTED' || q.status === 'CONVERTED' ? 'ok' : ''}`}><strong>{q.status === 'DECLINED' ? t('qt.declinedBy', { name: q.response.name ?? '' }) : t('qt.acceptedBy', { name: q.response.name ?? '' })}</strong>{q.response.note && <p className="small">“{q.response.note}”</p>}<p className="muted small">{new Date(q.response.at).toLocaleString()}</p></div>}
            <dl className="summary">
              <div><dt>{t('qt.contact')}</dt><dd>{q.contactName ?? '—'}</dd></div><div><dt>{t('bk.phone')}</dt><dd dir="ltr">{q.phone ?? '—'}</dd></div><div><dt>{t('qt.email')}</dt><dd dir="ltr">{q.email ?? '—'}</dd></div>
              {q.specialRequests && <div className="span2"><dt>{t('qt.requests')}</dt><dd>{q.specialRequests}</dd></div>}
            </dl>
            {q.amenities.length > 0 && <div className="chips">{q.amenities.map((a) => <span key={a} className="chip on">{a}</span>)}</div>}
            {made && <div className="confirmcard"><span><strong>{t('qt.nowBooked')}</strong> {made.map((b) => <Link key={b.id} to={`/reservations/${b.id}`}>{b.confirmationNo}</Link>).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, ', ', x] : [x]), [])}</span></div>}
            {q.status === 'CONVERTED' && !made && <p className="muted small">{t('qt.convertedNote')}</p>}
            {newPrice && <div className="warnbox stack"><span>{t('qt.priceChanged')}</span><div className="actions"><button className="primary" disabled={busy} onClick={() => void convert(true)}>{t('qt.bookNewPrice')}</button><button onClick={() => setNewPrice(null)}>{t('common.cancel')}</button></div></div>}
            <ErrorLine code={problem?.code === 'PRICE_CHANGED' ? undefined : problem?.code} detail={problem?.code === 'PRICE_CHANGED' ? undefined : problem?.detail} />
            {canWrite && (
              <div className="actions">
                <a className="button" href={`/v1/properties/${property!.id}/quotations/${q.id}/page`} target="_blank" rel="noreferrer">{t('qt.preview')}</a>
                {!['CANCELLED', 'CONVERTED'].includes(q.status) && !q.expired && <button className="primary" onClick={() => setSending(true)}>{q.status === 'DRAFT' ? t('qt.send') : t('qt.sendAgain')}</button>}
                {q.status === 'DRAFT' && <button onClick={() => onEdit(q)}>{t('qt.edit')}</button>}
                {['SENT', 'ACCEPTED', 'DECLINED'].includes(q.status) && <button disabled={busy} onClick={() => post('revise')}>{t('qt.revise')}</button>}
                {['SENT', 'DECLINED'].includes(q.status) && <button disabled={busy} onClick={() => { const n = window.prompt(t('qt.markNote')); if (n !== null) void post('mark', { status: 'ACCEPTED', note: n.trim() || null }); }}>{t('qt.markAccepted')}</button>}
                {q.status === 'SENT' && <button disabled={busy} onClick={() => { const n = window.prompt(t('qt.markNote')); if (n !== null) void post('mark', { status: 'DECLINED', note: n.trim() || null }); }}>{t('qt.markDeclined')}</button>}
                {['ACCEPTED', 'SENT'].includes(q.status) && <button className="primary" disabled={busy} onClick={() => void convert(false)}>{t('qt.convert')}</button>}
                {!['CANCELLED', 'CONVERTED'].includes(q.status) && <button className="link" disabled={busy} onClick={() => { if (window.confirm(t('qt.cancelConfirm'))) void post('cancel'); }}>{t('qt.cancel')}</button>}
              </div>)}
          </div>
          <aside className="qe-side"><div className="card stack"><h3>{t('qt.figures')}</h3>{q.pricing ? <PricingView p={q.pricing} /> : null}</div></aside>
          {sending && <SendQuotation q={q} base={base} onClose={() => { setSending(false); d.reload(); }} />}
        </div>)}
    </Sheet>
  );
}

function SendQuotation({ q, base, onClose }: { q: Detail; base: string; onClose: () => void }) {
  const { t } = useT(); const { property } = useAuth();
  const [m, setM] = useState<{ text: string; phone: string | null } | null>(null); const [text, setText] = useState(''); const [phone, setPhone] = useState(''); const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { let dead = false; api<{ text: string; phone: string | null }>('POST', `/v1/properties/${property!.id}/quotations/${q.id}/message`).then((r) => { if (!dead) { setM(r); setText(r.text); setPhone(r.phone ?? ''); } }).catch((e) => { if (!dead) setFailed(e?.message ?? 'error'); }); return () => { dead = true; }; }, [q.id, property]);
  const wa = whatsappNumber(phone);
  return (
    <Sheet title={t('qt.sendTitle')} onClose={onClose}>
      {failed ? <p className="warnbox small">{failed}</p> : !m ? <Spinner /> : (
        <div className="stack">
          <p className="muted small">{t('qt.sendNote')}</p>
          <label>{t('wa.message')}<textarea dir="ltr" rows={13} value={text} onChange={(e) => setText(e.target.value)} /></label>
          {!m.phone && <label>{t('mw.theirPhone')}<input value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" inputMode="tel" /></label>}
          <div className="actions">{wa ? <a className="primary button" href={`https://wa.me/${wa}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">{t('wa.send')}</a> : <p className="warnbox small">{t('mw.noPhone')}</p>}<button onClick={() => void navigator.clipboard?.writeText(text)}>{t('wa.copy')}</button></div>
          <EmailSend compose={() => api<{ text: string; subject: string | null; email: string | null }>('POST', `${base}/${q.id}/message?channel=EMAIL`)} send={(v) => api('POST', `/v1/properties/${property!.id}/email/quotation/${q.id}`, v)} />
        </div>)}
    </Sheet>
  );
}

// ───────────────────────── the wording around the figures ─────────────────────────
interface Settings { greeting: string; closing: string; signoff: string; contactPhone: string | null; contactEmail: string | null; website: string | null; locationNote: string | null; amenities: string[]; taxNote: string | null; advancePct: number; balanceDays: number | null; terms: Array<{ title: string; body: string }>; custom: boolean }

/** What the customer's page says around the figures: greeting, closing, contacts, standard amenities and the numbered terms. Written once per property. */
function QuotationWording({ base, onClose }: { base: string; onClose: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction();
  const cur = useLive<Settings>(`${base}/settings`, 600_000);
  const [f, setF] = useState<Settings | null>(null); const [saved, setSaved] = useState(false);
  useEffect(() => { if (cur.data && !f) setF(cur.data); }, [cur.data, f]);
  if (!f) return <Sheet title={t('qt.wording')} onClose={onClose} wide><Spinner /></Sheet>;
  const set = (p: Partial<Settings>) => { setF({ ...f, ...p }); setSaved(false); };
  const save = async () => { const { custom: _c, ...body } = f; void _c; const r = await run(() => api<Settings>('PUT', `${base}/settings`, { ...body, contactPhone: body.contactPhone || null, website: body.website || null, locationNote: body.locationNote || null, taxNote: body.taxNote || null })); if (r) { setF(r); setSaved(true); } };
  const reset = async () => { if (!window.confirm(t('qt.wordingReset'))) return; const r = await run(() => api<Settings>('POST', `${base}/settings/reset`, {})); if (r) { setF(r); setSaved(true); } };
  return (
    <Sheet title={t('qt.wording')} onClose={onClose} wide>
      <div className="stack">
        <p className="muted small">{t('qt.wordingNote')}</p>
        <label>{t('qt.greeting')}<textarea rows={3} value={f.greeting} onChange={(e) => set({ greeting: e.target.value })} maxLength={1000} /></label>
        <label>{t('qt.closing')}<textarea rows={3} value={f.closing} onChange={(e) => set({ closing: e.target.value })} maxLength={1500} /></label>
        <label>{t('qt.signoff')}<textarea rows={2} value={f.signoff} onChange={(e) => set({ signoff: e.target.value })} maxLength={300} /></label>
        <div className="grid2">
          <label>{t('qt.cPhone')}<input value={f.contactPhone ?? ''} onChange={(e) => set({ contactPhone: e.target.value })} dir="ltr" /></label>
          <label>{t('qt.email')}<input type="email" value={f.contactEmail ?? ''} onChange={(e) => set({ contactEmail: e.target.value })} dir="ltr" /></label>
          <label>{t('qt.website')}<input value={f.website ?? ''} onChange={(e) => set({ website: e.target.value })} dir="ltr" /></label>
          <label>{t('qt.locationNote')}<input value={f.locationNote ?? ''} onChange={(e) => set({ locationNote: e.target.value })} maxLength={600} /></label>
          <label>{t('qt.defAdvance')}<input type="number" min={0} max={100} value={f.advancePct} onChange={(e) => set({ advancePct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} dir="ltr" /></label>
          <label>{t('qt.defBalance')}<input type="number" min={0} max={365} value={f.balanceDays ?? ''} onChange={(e) => set({ balanceDays: e.target.value === '' ? null : Math.min(365, Math.max(0, Math.floor(Number(e.target.value)) || 0)) })} dir="ltr" /></label>
        </div>
        <label>{t('qt.stdAmenities')}<textarea rows={3} value={f.amenities.join('\n')} onChange={(e) => set({ amenities: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 30) })} /></label>
        <label>{t('qt.taxNote')}<input value={f.taxNote ?? ''} onChange={(e) => set({ taxNote: e.target.value })} maxLength={300} /></label>
        <fieldset className="guestcard"><legend>{t('qt.termsList')}</legend>
          {f.terms.map((x, k) => (
            <div key={k} className="card inner stack">
              <input value={x.title} onChange={(e) => set({ terms: f.terms.map((y, i) => (i === k ? { ...y, title: e.target.value } : y)) })} maxLength={120} aria-label={t('qt.termTitle')} />
              <textarea rows={2} value={x.body} onChange={(e) => set({ terms: f.terms.map((y, i) => (i === k ? { ...y, body: e.target.value } : y)) })} maxLength={1200} aria-label={t('qt.termBody')} />
              <button className="link" onClick={() => set({ terms: f.terms.filter((_, i) => i !== k) })}>{t('qt.removeLine')}</button>
            </div>))}
          <button onClick={() => set({ terms: [...f.terms, { title: '', body: '' }] })} disabled={f.terms.length >= 30}>{t('qt.addTerm')}</button>
        </fieldset>
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        <div className="actions"><button className="primary" disabled={busy || f.terms.some((x) => !x.title.trim() || !x.body.trim())} onClick={save}>{t('common.save')}</button>{f.custom && <button disabled={busy} onClick={reset}>{t('qt.useBuiltIn')}</button>}{saved && <span className="ok small" role="status">✓ {t('qt.savedWording')}</span>}</div>
      </div>
    </Sheet>
  );
}
