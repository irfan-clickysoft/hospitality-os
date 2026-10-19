import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Chip, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import { BillSheet } from './BillToCompany.js';
import { PaymentSheet } from './PaymentSheet.js';
import type { Amount } from './types.js';

interface Space { id: string; name: string; nameUr: string | null; capacity: number | null; bufferMinutes: number; hourly: Amount | null; halfDay: Amount | null; fullDay: Amount | null; active: boolean; version: number }
interface Hire {
  id: string; number: string; space: string; eventName: string; hostName: string; hostPhone: string | null; attendees: number | null; note: string | null; date: string; startTime: string; endTime: string; pricing: string; hours: number; amount: Amount;
  status: 'BOOKED' | 'COMPLETED' | 'CANCELLED'; billTo: 'STAY' | 'SEPARATE'; stay: { reservationId: string; confirmationNo: string; guest: string } | null; bill: { folioId: string; folioNo: string; balance: Amount; status: string } | null; company: { name: string } | null; invoices: Array<{ id: string; number: string; docType: string }>; cancelReason: string | null; version: number;
}
interface Stay { reservationId: string; confirmationNo: string; guest: string; room: string | null; status: string }
const tone = (s: string) => (s === 'COMPLETED' ? 'inspected' : s === 'CANCELLED' ? 'neutral' : 'warn') as 'inspected' | 'neutral' | 'warn';
const today = () => new Date().toLocaleDateString('en-CA');

/** The conference room: a calendar of hires, new bookings (charged to a staying guest or on a bill of their own), and the prices. */
export function Spaces() {
  const { t } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/spaces`;
  const [view, setView] = useState<'calendar' | 'spaces'>('calendar'); const [booking, setBooking] = useState(false); const [paying, setPaying] = useState<Hire | null>(null); const [billing, setBilling] = useState<Hire | null>(null); const [editing, setEditing] = useState<Hire | null>(null);
  const cal = useLive<{ items: Hire[] }>(view === 'calendar' ? `${base}/bookings` : null, 30_000);
  const { busy, problem, run } = useAction();
  const go = async (h: Hire, tail: string, body: unknown = {}) => { if (await run(() => api('POST', `${base}/bookings/${h.id}/${tail}`, body))) cal.reload(); };
  const book = can('space.book');
  const days = [...new Set((cal.data?.items ?? []).map((h) => h.date))];
  return (
    <section className="stack">
      <h2>{t('nav.spaces')}</h2>
      <div className="chips">{(['calendar', ...(can('space.manage') ? ['spaces'] : [])] as const).map((v) => <Chip key={v} active={view === v} onClick={() => setView(v as typeof view)}>{t(`sp.v.${v}` as Key)}</Chip>)}</div>
      {book && view === 'calendar' && <div className="actions"><button className="primary" onClick={() => setBooking(true)}>{t('sp.newHire')}</button></div>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {view === 'spaces' ? <SpaceAdmin base={base} /> : !cal.data ? <Spinner /> : cal.data.items.length === 0 ? <Empty text={t('sp.nothing')} /> : days.map((d) => (
        <div key={d} className="stack"><h3>{d}</h3>
          <ul className="plain">{cal.data!.items.filter((h) => h.date === d).map((h) => (
            <li key={h.id} className="card stack small">
              <div className="row between"><strong dir="ltr">{h.startTime}–{h.endTime} · {h.eventName}</strong><Badge tone={tone(h.status)}>{t(`sp.s.${h.status}` as Key)}</Badge></div>
              <span className="muted">{h.space} · {h.hostName}{h.hostPhone ? ` · ${h.hostPhone}` : ''}{h.attendees ? ` · ${t('sp.people', { n: h.attendees })}` : ''}</span>
              <span>{money(h.amount)} <span className="muted">· {t(`sp.p.${h.pricing}` as Key)}{h.pricing === 'HOURLY' ? ` × ${h.hours}` : ''} · {t('sp.beforeTax')}</span></span>
              <span className="muted">{h.stay ? t('sp.onStay', { guest: h.stay.guest, no: h.stay.confirmationNo }) : t('sp.ownBill', { no: h.bill?.folioNo ?? '' })}{h.company ? ` · ${h.company.name}` : ''}{h.bill && h.status !== 'CANCELLED' ? ` · ${t('pay.balance')}: ${money(h.bill.balance)}` : ''}</span>
              {h.cancelReason && <span className="muted">{h.cancelReason}</span>}
              {book && h.status === 'BOOKED' && <div className="row">
                <button className="primary" disabled={busy} onClick={() => go(h, 'complete')}>{t('sp.complete')}</button>
                {h.bill && <button disabled={busy} onClick={() => setPaying(h)}>{t('sp.takePayment')}</button>}
                <button disabled={busy} onClick={() => setEditing(h)}>{t('sp.change')}</button>
                <button className="link" disabled={busy} onClick={() => { const r = window.prompt(t('sp.cancelWhy')); if (r && r.trim().length >= 3) void go(h, 'cancel', { reason: r.trim() }); }}>{t('kt.cancel')}</button></div>}
              {h.invoices.length > 0 && <div className="row">{h.invoices.map((x) => <a key={x.id} className="button" href={`/v1/properties/${property!.id}/invoices/${x.id}/print`} target="_blank" rel="noreferrer">{x.docType === 'CREDIT_NOTE' ? t('sp.creditNote') : t('inv.print')} {x.number}</a>)}</div>}
              {book && h.status === 'COMPLETED' && h.bill && h.bill.status === 'OPEN' && <div className="row">
                <button disabled={busy} onClick={() => setPaying(h)}>{t('sp.takePayment')}</button>
                {can('invoice.issue') && <button disabled={busy} onClick={() => { void run(() => api('POST', `${base}/bookings/${h.id}/invoices`, {})).then((r) => { if (r) cal.reload(); }); }}>{t('inv.issue')}</button>}
                {can('ar.bill') && !h.bill.balance.amount.startsWith('-') && h.bill.balance.amount !== '0.00' && <button disabled={busy} onClick={() => setBilling(h)}>{t('ar.bill')}</button>}</div>}
            </li>))}</ul></div>))}
      {booking && <NewHire base={base} onDone={() => { setBooking(false); cal.reload(); }} onClose={() => setBooking(false)} />}
      {editing && <EditHire base={base} hire={editing} onDone={() => { setEditing(null); cal.reload(); }} onClose={() => setEditing(null)} />}
      {billing?.bill && <BillSheet endpoint={`${base}/bookings/${billing.id}/bill-to-company`} companyId={billing.company ? (billing.company as { id?: string }).id ?? null : null} balance={billing.bill.balance} onDone={() => { setBilling(null); cal.reload(); }} onClose={() => setBilling(null)} />}
      {paying?.bill && <PaymentSheet folioId={paying.bill.folioId} balance={paying.bill.balance} onDone={cal.reload} onClose={() => setPaying(null)} />}
    </section>
  );
}

function EditHire({ base, hire, onDone, onClose }: { base: string; hire: Hire; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const [f, setF] = useState({ date: hire.date, startTime: hire.startTime, endTime: hire.endTime, pricing: hire.pricing, eventName: hire.eventName, hostName: hire.hostName });
  const { busy, problem, run } = useAction();
  const go = async () => { if (await run(() => api('PATCH', `${base}/bookings/${hire.id}`, { ...f, eventName: f.eventName.trim(), hostName: f.hostName.trim(), version: hire.version }))) onDone(); };
  return (
    <Sheet title={`${t('sp.change')} · ${hire.number}`} onClose={onClose}>
      <label>{t('sp.event')}<input value={f.eventName} onChange={(e) => setF({ ...f, eventName: e.target.value })} /></label>
      <label>{t('sp.host')}<input value={f.hostName} onChange={(e) => setF({ ...f, hostName: e.target.value })} /></label>
      <label>{t('sp.date')}<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} dir="ltr" /></label>
      <div className="grid2"><label>{t('sp.from')}<input type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} dir="ltr" /></label><label>{t('sp.to')}<input type="time" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} dir="ltr" /></label></div>
      <div className="chips" role="group">{(['HOURLY', 'HALF_DAY', 'FULL_DAY'] as const).map((p) => <button key={p} type="button" className={`chip${p === f.pricing ? ' on' : ''}`} aria-pressed={p === f.pricing} onClick={() => setF({ ...f, pricing: p })}>{t(`sp.p.${p}` as Key)}</button>)}</div>
      <p className="muted small">{t('sp.changeNote')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || f.eventName.trim().length < 2 || f.hostName.trim().length < 2} onClick={go}>{t('sp.save')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function NewHire({ base, onDone, onClose }: { base: string; onDone: () => void; onClose: () => void }) {
  const { t, locale } = useT();
  const spaces = useLive<{ items: Space[] }>(base, 120_000);
  const stays = useLive<{ items: Stay[] }>(`${base}/stays`, 120_000);
  const [f, setF] = useState({ spaceId: '', eventName: '', hostName: '', hostPhone: '', date: today(), startTime: '10:00', endTime: '14:00', pricing: 'HALF_DAY', billTo: 'SEPARATE', reservationId: '', attendees: '' });
  const { busy, problem, run } = useAction();
  const space = spaces.data?.items.find((s) => s.id === (f.spaceId || spaces.data?.items[0]?.id));
  const go = async () => {
    const body = { spaceId: space!.id, eventName: f.eventName.trim(), hostName: f.hostName.trim(), ...(f.hostPhone.trim() ? { hostPhone: f.hostPhone.trim() } : {}), ...(f.attendees ? { attendees: Number(f.attendees) } : {}),
      date: f.date, startTime: f.startTime, endTime: f.endTime, pricing: f.pricing, billTo: f.billTo, ...(f.billTo === 'STAY' ? { reservationId: f.reservationId } : {}) };
    if (await run(() => api('POST', `${base}/bookings`, body))) onDone();
  };
  const ready = !!space && f.eventName.trim().length >= 2 && f.hostName.trim().length >= 2 && (f.billTo === 'SEPARATE' || !!f.reservationId);
  const offered = (['HOURLY', 'HALF_DAY', 'FULL_DAY'] as const).filter((p) => space && (p === 'HOURLY' ? space.hourly : p === 'HALF_DAY' ? space.halfDay : space.fullDay));
  const price = (p: string) => { const a = space && (p === 'HOURLY' ? space.hourly : p === 'HALF_DAY' ? space.halfDay : space.fullDay); return a ? money(a) : ''; };
  return (
    <Sheet title={t('sp.newHire')} onClose={onClose}>
      {!spaces.data || !stays.data ? <Spinner /> : spaces.data.items.length === 0 ? <p className="muted">{t('sp.noSpaces')}</p> : (<>
        <label>{t('sp.space')}<select value={space?.id ?? ''} onChange={(e) => setF({ ...f, spaceId: e.target.value })}>{spaces.data.items.map((s) => <option key={s.id} value={s.id}>{locale === 'ur' && s.nameUr ? s.nameUr : s.name}</option>)}</select></label>
        <label>{t('sp.event')}<input value={f.eventName} onChange={(e) => setF({ ...f, eventName: e.target.value })} /></label>
        <div className="grid2"><label>{t('sp.host')}<input value={f.hostName} onChange={(e) => setF({ ...f, hostName: e.target.value })} /></label><label>{t('sp.phone')}<input inputMode="tel" value={f.hostPhone} onChange={(e) => setF({ ...f, hostPhone: e.target.value })} dir="ltr" /></label></div>
        <div className="grid2"><label>{t('sp.date')}<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} dir="ltr" /></label><label>{t('sp.people2')}<input inputMode="numeric" value={f.attendees} onChange={(e) => setF({ ...f, attendees: e.target.value.replace(/\D/g, '') })} dir="ltr" /></label></div>
        <div className="grid2"><label>{t('sp.from')}<input type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} dir="ltr" /></label><label>{t('sp.to')}<input type="time" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} dir="ltr" /></label></div>
        <div className="chips" role="group">{offered.map((p) => <button key={p} type="button" className={`chip${p === f.pricing ? ' on' : ''}`} aria-pressed={p === f.pricing} onClick={() => setF({ ...f, pricing: p })}>{t(`sp.p.${p}` as Key)} · {price(p)}</button>)}</div>
        <div className="chips" role="group">{(['SEPARATE', 'STAY'] as const).map((b) => <button key={b} type="button" className={`chip${b === f.billTo ? ' on' : ''}`} aria-pressed={b === f.billTo} onClick={() => setF({ ...f, billTo: b })}>{t(`sp.bill.${b}` as Key)}</button>)}</div>
        {f.billTo === 'STAY' ? <label>{t('sp.stay')}<select value={f.reservationId} onChange={(e) => setF({ ...f, reservationId: e.target.value })}><option value="">—</option>{stays.data.items.map((s) => <option key={s.reservationId} value={s.reservationId}>{s.room ? `${s.room} · ` : ''}{s.guest} · {s.confirmationNo}</option>)}</select></label> : <p className="muted small">{t('sp.ownBillNote')}</p>}
        <p className="muted small">{t('sp.taxNote', { n: space?.bufferMinutes ?? 0 })}</p>
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        <div className="actions"><button className="primary" disabled={busy || !ready} onClick={go}>{t('sp.book')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
      </>)}
    </Sheet>
  );
}

function SpaceAdmin({ base }: { base: string }) {
  const { t } = useT();
  const list = useLive<{ items: Space[] }>(`${base}?all=true`, 60_000);
  const [f, setF] = useState({ name: '', nameUr: '', hourly: '', halfDay: '', fullDay: '', bufferMinutes: '30' });
  const { busy, problem, run } = useAction();
  const num = (v: string) => (v.trim() ? v.trim() : null);
  const add = async () => { if (await run(() => api('POST', base, { name: f.name.trim(), ...(f.nameUr.trim() ? { nameUr: f.nameUr.trim() } : {}), hourly: num(f.hourly), halfDay: num(f.halfDay), fullDay: num(f.fullDay), bufferMinutes: Number(f.bufferMinutes || 0) }))) { setF({ ...f, name: '', nameUr: '' }); list.reload(); } };
  const reprice = async (s: Space, field: 'hourly' | 'halfDay' | 'fullDay') => { const p = window.prompt(t('sp.newPrice'), s[field]?.amount ?? ''); if (p !== null && (p.trim() === '' || /^\d{1,9}(\.\d{1,2})?$/.test(p.trim())) && (await run(() => api('PATCH', `${base}/${s.id}`, { [field]: p.trim() === '' ? null : p.trim(), version: s.version })))) list.reload(); };
  const toggle = async (s: Space) => { if (await run(() => api('PATCH', `${base}/${s.id}`, { active: !s.active, version: s.version }))) list.reload(); };
  return (
    <div className="stack">
      <div className="card inner stack">
        <div className="grid2"><label>{t('kt.name')}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label><label>{t('kt.nameUr')}<input value={f.nameUr} onChange={(e) => setF({ ...f, nameUr: e.target.value })} dir="rtl" /></label></div>
        <div className="grid2"><label>{t('sp.p.HOURLY')}<input inputMode="decimal" value={f.hourly} onChange={(e) => setF({ ...f, hourly: e.target.value })} dir="ltr" /></label><label>{t('sp.p.HALF_DAY')}<input inputMode="decimal" value={f.halfDay} onChange={(e) => setF({ ...f, halfDay: e.target.value })} dir="ltr" /></label></div>
        <div className="grid2"><label>{t('sp.p.FULL_DAY')}<input inputMode="decimal" value={f.fullDay} onChange={(e) => setF({ ...f, fullDay: e.target.value })} dir="ltr" /></label><label>{t('sp.buffer')}<input inputMode="numeric" value={f.bufferMinutes} onChange={(e) => setF({ ...f, bufferMinutes: e.target.value.replace(/\D/g, '') })} dir="ltr" /></label></div>
        <button className="primary" disabled={busy || f.name.trim().length < 2} onClick={add}>{t('sp.addSpace')}</button>
        <ErrorLine code={problem?.code} detail={problem?.detail} />
      </div>
      {!list.data ? <Spinner /> : <ul className="plain">{list.data.items.map((s) => (
        <li key={s.id} className={`card stack small${s.active ? '' : ' struck'}`}>
          <div className="row between"><strong>{s.name}{s.nameUr ? ` · ${s.nameUr}` : ''}</strong><button className="link" disabled={busy} onClick={() => toggle(s)}>{s.active ? t('kt.off') : t('kt.on')}</button></div>
          <div className="row">{(['hourly', 'halfDay', 'fullDay'] as const).map((k) => <button key={k} className="link" onClick={() => reprice(s, k)}>{t(`sp.p.${k === 'hourly' ? 'HOURLY' : k === 'halfDay' ? 'HALF_DAY' : 'FULL_DAY'}` as Key)}: {s[k] ? money(s[k]!) : '—'}</button>)}</div>
        </li>))}</ul>}
    </div>
  );
}
