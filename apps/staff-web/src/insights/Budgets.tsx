import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAction } from '../lib/action.js';
import { useAuth } from '../state.js';
import { ErrorLine, Spinner } from '../ui/kit.js';

interface Item { month: string; roomRevenue: string; fnbRevenue: string; occupancyPct: number | null; note: string | null; set: boolean }
interface Year { currency: string; year: number; items: Item[] }
const clean = (v: string) => v.replace(/[^\d.]/g, '');

interface Com { source: string; pct: number; set: boolean }
const SRC_LABEL: Record<string, string> = { WALK_IN: 'Walk-in', PHONE: 'Phone', WHATSAPP: 'WhatsApp', WEBSITE: 'Website', OTA_BOOKING_COM: 'Booking.com', OTA_OTHER: 'Other online travel agent', CORPORATE: 'Corporate', TRAVEL_AGENT: 'Travel agent', CRS: 'Reservation system', OTHER: 'Other' };

/** The share of room revenue each booking source keeps. The commission and net revenue report uses it. */
function Commissions() {
  const { t } = useT(); const { property, can } = useAuth(); const { busy, problem, run } = useAction();
  const pid = property!.id; const editable = can('rate.manage');
  const [rows, setRows] = useState<Com[] | null>(null); const [saved, setSaved] = useState<string | null>(null);
  const load = () => api<{ items: Com[] }>('GET', `/v1/properties/${pid}/commissions`).then((r) => setRows(r.items));
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pid]);
  if (!rows) return <Spinner />;
  const save = async (x: Com) => { if (await run(() => api('PUT', `/v1/properties/${pid}/commissions/${x.source}`, { pct: x.pct }))) { setSaved(x.source); void load(); } };
  return (
    <section className="stack" aria-labelledby="cm-h">
      <h2 id="cm-h">{t('cm.title')}</h2><p className="muted">{t('cm.help')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('cm.source')}</th><th scope="col">{t('cm.pct')}</th><th scope="col"><span className="sr-only">{t('common.save')}</span></th></tr></thead>
        <tbody>{rows.map((x) => (
          <tr key={x.source}><th scope="row">{SRC_LABEL[x.source] ?? x.source}</th>
            <td><input aria-label={`${SRC_LABEL[x.source] ?? x.source}: ${t('cm.pct')}`} inputMode="decimal" value={String(x.pct)} disabled={!editable} onChange={(e) => { setSaved(null); const v = clean(e.target.value); setRows(rows.map((y) => (y.source === x.source ? { ...y, pct: v === '' ? 0 : Math.min(100, Number(v)) } : y))); }} dir="ltr" /></td>
            <td>{editable && <button type="button" disabled={busy} onClick={() => void save(x)}>{saved === x.source ? `✓ ${t('bg.saved')}` : t('common.save')}</button>}</td></tr>))}</tbody></table></div>
    </section>
  );
}

/** The monthly budget: what the owner expects in room revenue, food and beverage revenue and occupancy. The budget reports compare actual figures with it. */
export function Budgets() {
  const { t, locale } = useT(); const { property, can } = useAuth(); const { busy, problem, run } = useAction();
  const pid = property!.id; const editable = can('rate.manage');
  const [year, setYear] = useState(Number(property!.businessDate.slice(0, 4))); const [data, setData] = useState<Year | null>(null); const [rows, setRows] = useState<Item[]>([]); const [saved, setSaved] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = () => api<Year>('GET', `/v1/properties/${pid}/budgets?year=${year}`).then((r) => { setData(r); setRows(r.items); }).catch((e) => setErr(String(e?.message ?? e)));
  useEffect(() => { setData(null); setErr(null); void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pid, year]);
  const edit = (m: string, p: Partial<Item>) => { setSaved(null); setRows(rows.map((x) => (x.month === m ? { ...x, ...p } : x))); };
  const save = async (x: Item) => { if (await run(() => api('PUT', `/v1/properties/${pid}/budgets/${x.month}`, { roomRevenue: x.roomRevenue || '0', fnbRevenue: x.fnbRevenue || '0', occupancyPct: x.occupancyPct, note: x.note }))) { setSaved(x.month); void load(); } };
  const name = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { month: 'long', timeZone: 'UTC' });
  if (err) return <p className="warnbox" role="alert">{err}</p>;
  if (!data) return <Spinner />;
  return (
    <section className="stack">
      <h2>{t('bg.title')}</h2><p className="muted">{t('bg.help', { cur: data.currency })}</p>
      <div className="row"><button type="button" onClick={() => setYear(year - 1)} aria-label={t('bg.prev')}>‹</button><strong dir="ltr">{year}</strong><button type="button" onClick={() => setYear(year + 1)} aria-label={t('bg.next')}>›</button></div>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('bg.month')}</th><th scope="col">{t('bg.room')} ({data.currency})</th><th scope="col">{t('bg.fnb')} ({data.currency})</th><th scope="col">{t('bg.occ')}</th><th scope="col"><span className="sr-only">{t('common.save')}</span></th></tr></thead>
        <tbody>{rows.map((x) => (
          <tr key={x.month}><th scope="row">{name(x.month)}{x.set ? '' : ` · ${t('bg.notSet')}`}</th>
            <td><input aria-label={`${name(x.month)}: ${t('bg.room')}`} inputMode="decimal" value={x.roomRevenue} disabled={!editable} onChange={(e) => edit(x.month, { roomRevenue: clean(e.target.value) })} dir="ltr" /></td>
            <td><input aria-label={`${name(x.month)}: ${t('bg.fnb')}`} inputMode="decimal" value={x.fnbRevenue} disabled={!editable} onChange={(e) => edit(x.month, { fnbRevenue: clean(e.target.value) })} dir="ltr" /></td>
            <td><input aria-label={`${name(x.month)}: ${t('bg.occ')}`} inputMode="decimal" value={x.occupancyPct ?? ''} disabled={!editable} onChange={(e) => { const v = clean(e.target.value); edit(x.month, { occupancyPct: v === '' ? null : Math.min(100, Number(v)) }); }} dir="ltr" /></td>
            <td>{editable && <button type="button" disabled={busy} onClick={() => void save(x)}>{saved === x.month ? `✓ ${t('bg.saved')}` : t('common.save')}</button>}</td></tr>))}</tbody></table></div>
      {!editable && <p className="muted small">{t('bg.readOnly')}</p>}
      <Commissions />
    </section>
  );
}
