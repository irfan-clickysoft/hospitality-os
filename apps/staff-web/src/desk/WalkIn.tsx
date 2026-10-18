import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAction } from '../lib/action.js';
import { addDays, money, newKey } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { ErrorLine, Sheet } from '../ui/kit.js';
import { blankOccupant, OccupantsForm, occupantBody, type Occupant } from './CheckInSheet.js';
import type { Amount, RackData } from './types.js';

/** A guest at the desk with no booking: price it, book it and check them in as one step. */
export function WalkIn({ businessDate, onClose, onOpenReservation }: { businessDate: string; onClose: () => void; onOpenReservation: (id: string) => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const base = `/v1/properties/${property!.id}`;
  const rack = useLive<RackData>(`${base}/rack?days=1`, 30_000);
  const key = useMemo(newKey, []);
  const [typeId, setTypeId] = useState(''); const [nights, setNights] = useState(1); const [adults, setAdults] = useState(2); const [foreign, setForeign] = useState(false);
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [occ, setOcc] = useState<Occupant[]>([blankOccupant('', false)]);
  const [price, setPrice] = useState<{ total: Amount; plan: string } | null>(null); const [done, setDone] = useState<{ id: string; confirmationNo: string } | null>(null);
  const { busy, problem, run } = useAction();
  const types = rack.data?.roomTypes ?? [];
  const free = (id: string) => (types.find((x) => x.id === id)?.availability[0]?.available ?? 0);
  useEffect(() => { if (!typeId && types[0]) setTypeId((types.find((x) => free(x.id) > 0) ?? types[0]).id); }, [types]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setOcc((o) => o.map((x, i) => (i === 0 ? { ...x, fullName: name } : x))); }, [name]);
  useEffect(() => { setOcc((o) => o.map((x, i) => (i === 0 ? { ...x, idType: foreign ? 'PASSPORT' : 'CNIC', nationality: foreign ? '' : 'PK' } : x))); }, [foreign]);
  useEffect(() => {
    if (!typeId) return;
    let dead = false;
    api<{ options: Array<{ roomType: { id: string }; plan: { name: string }; totalExTax: Amount; bookable: boolean }> }>('POST', `${base}/quotes`, { arrival: businessDate, departure: addDays(businessDate, nights), adults, channel: 'WALKIN', residency: foreign ? 'NON_RESIDENT' : 'RESIDENT', roomTypeId: typeId })
      .then((r) => { if (dead) return; const o = r.options.find((x) => x.bookable); setPrice(o ? { total: o.totalExTax, plan: o.plan.name } : null); }).catch(() => !dead && setPrice(null));
    return () => { dead = true; };
  }, [typeId, nights, adults, foreign, base, businessDate]);

  const submit = async () => {
    const body = { guest: { fullName: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}), nationality: foreign ? (occ[0]?.nationality || 'XX') : 'PK' }, roomTypeId: typeId, nights, adults, occupants: occ.map((o, i) => occupantBody(o, i === 0)) };
    const r = await run(() => api<{ id: string; confirmationNo: string }>('POST', `${base}/front-desk/walk-ins`, body, { 'idempotency-key': key }));
    if (r) setDone(r);
  };
  return (
    <Sheet title={t('wi.title')} onClose={onClose}>
      {done ? (<><p className="ok big" role="status">✓ {done.confirmationNo}</p><div className="actions"><button className="primary" onClick={() => onOpenReservation(done.id)}>{t('bk.open')}</button><button onClick={onClose}>{t('common.close')}</button></div></>) : (<>
        <label>{t('wi.type')}<select value={typeId} onChange={(e) => setTypeId(e.target.value)}>{types.map((x) => <option key={x.id} value={x.id} disabled={free(x.id) <= 0}>{x.name} ({t('bk.left', { n: free(x.id) })})</option>)}</select></label>
        <div className="grid2"><label>{t('bk.nights')}<input type="number" min={1} max={30} value={nights} onChange={(e) => setNights(Math.max(1, Number(e.target.value) || 1))} dir="ltr" /></label><label>{t('d.adults')}<input type="number" min={1} max={6} value={adults} onChange={(e) => setAdults(Math.max(1, Number(e.target.value) || 1))} dir="ltr" /></label></div>
        <label className="check"><input type="checkbox" checked={foreign} onChange={(e) => setForeign(e.target.checked)} /> {t('bk.foreign')}</label>
        <div className="card inner row between"><span>{t('wi.price')}{price ? ` · ${price.plan}` : ''}</span><strong className="big">{price ? money(price.total) : '—'}</strong></div>
        <p className="muted small">{t('bk.exTaxNote')}</p>
        <label>{t('ci.name')}<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <label>{t('bk.phone')}<input value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" inputMode="tel" /></label>
        <h3>{t('ci.guests')}</h3>
        <OccupantsForm occupants={occ} onChange={setOcc} foreign={foreign} />
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        <div className="actions"><button className="primary" disabled={busy || !price || name.trim().length < 2 || occ.some((o) => !o.fullName.trim() || !o.idNumber.trim())} onClick={submit}>{t('wi.go')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
      </>)}
    </Sheet>
  );
}
