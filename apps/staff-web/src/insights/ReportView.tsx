import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { addDays, money } from '../lib/format.js';
import { useAuth } from '../state.js';
import { navigate, useRoute, useSetQuery } from '../shell/router.js';
import { ErrorLine, Spinner, problemOf } from '../ui/kit.js';
import { Chart } from './Chart.js';
import { DataTable } from './DataTable.js';
import type { CatalogItem, Envelope, Kpi } from './types.js';

const kpiText = (k: Kpi, v: string | number, currency: string) => (k.type === 'money' && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? money(v, currency) : k.type === 'pct' ? `${v}%` : typeof v === 'number' ? v.toLocaleString('en-US') : String(v));
type Saved = { name: string; q: string };
const viewsKey = (pid: string, id: string) => `hos.ins.views.${pid}.${id}`;
const loadViews = (pid: string, id: string): Saved[] => { try { return JSON.parse(localStorage.getItem(viewsKey(pid, id)) ?? '[]') as Saved[]; } catch { return []; } };

/** One report: purpose, scope and date basis up front, KPIs with their definitions, an optional chart, the table, and the ways out (export, print, share, saved views). */
export function ReportView({ item }: { item: CatalogItem }) {
  const { t, locale } = useT(); const { property } = useAuth(); const route = useRoute(); const setQuery = useSetQuery();
  const pid = property!.id; const bd = property!.businessDate;
  const qp = route.query; const basis = qp.get('basis') ?? item.basis[0]!.id;
  const quick = useMemo(() => ({ today: [bd, bd], mtd: [`${bd.slice(0, 8)}01`, bd], last7: [addDays(bd, -6), bd], last30: [addDays(bd, -29), bd], next7: [bd, addDays(bd, 6)], next30: [bd, addDays(bd, 29)], next90: [bd, addDays(bd, 89)] } as Record<string, [string, string]>), [bd]);
  const [data, setData] = useState<Envelope | null>(null); const [problem, setProblem] = useState<{ code: string; detail?: string } | null>(null); const [loading, setLoading] = useState(true);
  const [views, setViews] = useState<Saved[]>(() => loadViews(pid, item.id));
  const search = useMemo(() => { const p = new URLSearchParams(); for (const k of ['basis', 'from', 'to', 'view', 'group']) { const v = qp.get(k); if (v) p.set(k, v); } return p.toString(); }, [qp]);
  useEffect(() => {
    let dead = false; setLoading(true); setProblem(null);
    api<Envelope>('GET', `/v1/properties/${pid}/insights/${item.id}${search ? `?${search}` : ''}`).then((r) => { if (!dead) { setData(r); setLoading(false); } }).catch((e) => { if (!dead) { setProblem(problemOf(e)); setData(null); setLoading(false); } });
    return () => { dead = true; };
  }, [pid, item.id, search]);
  const m = data?.meta; const from = m?.from ?? ''; const to = m?.to ?? '';
  const cur = m?.currency ?? 'PKR';
  const csvHref = `/v1/properties/${pid}/insights/${item.id}?${new URLSearchParams([...new URLSearchParams(search).entries(), ['format', 'csv']]).toString()}`;
  const saveView = () => { const name = window.prompt(t('ins.viewName')); if (!name?.trim()) return; const next = [...views.filter((v) => v.name !== name.trim()), { name: name.trim(), q: search }]; setViews(next); try { localStorage.setItem(viewsKey(pid, item.id), JSON.stringify(next)); } catch { /* not saved */ } };
  const applyView = (q: string) => { const p = new URLSearchParams(q); const patch: Record<string, string | null> = { basis: null, from: null, to: null, view: null, group: null }; p.forEach((v, k) => { patch[k] = v; }); setQuery(patch); };
  const asOf = m ? new Date(m.asOf).toLocaleString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: m.timezone }) : '';
  const dateLabel = item.basis.find((b) => b.id === basis)?.label ?? item.basis[0]!.label;
  return (
    <article className="stack ins-report" aria-busy={loading}>
      <div className="row between wrap no-print"><button type="button" className="link" onClick={() => navigate('/reports/center')}>← {t('ins.back')}</button></div>
      <header className="stack">
        <h2>{item.name}</h2><p className="muted">{item.purpose}</p>
        <dl className="ins-meta small" aria-label={t('ins.scope')}>
          <div><dt>{t('ins.property')}</dt><dd>{m?.property.name ?? property!.name}</dd></div>
          <div><dt>{t('ins.dateBasis')}</dt><dd>{dateLabel}{m?.from ? ` · ${m.from} → ${m.to}` : ''}</dd></div>
          <div><dt>{t('ins.timezone')}</dt><dd>{m?.timezone ?? ''} · {t('ins.businessDate')} {m?.businessDate ?? bd}</dd></div>
          <div><dt>{t('ins.asOf')}</dt><dd>{asOf} · <span className="st st-ok">{t('ins.live')}</span></dd></div>
          <div><dt>{t('ins.currency')}</dt><dd>{cur} · {m?.taxBasis ?? ''}</dd></div>
        </dl>
      </header>
      <section className="card inner stack no-print" aria-label={t('ins.filters')}>
        <div className="ins-filters">
          {item.basis.length > 1 && <label>{t('ins.dateBasis')}<select value={basis} onChange={(e) => setQuery({ basis: e.target.value })}>{item.basis.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</select></label>}
          {item.range !== 'none' && <><label>{dateLabel} — {t('rp.from')}<input type="date" value={from} onChange={(e) => e.target.value && setQuery({ from: e.target.value })} dir="ltr" /></label>
            <label>{dateLabel} — {t('rp.to')}<input type="date" value={to} onChange={(e) => e.target.value && setQuery({ to: e.target.value })} dir="ltr" /></label></>}
          {item.params.map((p) => <label key={p.key}>{p.label}<select value={qp.get(p.key) ?? p.default} onChange={(e) => setQuery({ [p.key]: e.target.value })}>{p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>)}
        </div>
        {item.range !== 'none' && <div className="chips" role="group" aria-label={t('ins.quick')}>{(['today', 'last7', 'last30', 'mtd', 'next7', 'next30', 'next90'] as const).map((k) => <button key={k} type="button" className="chip" onClick={() => setQuery({ from: quick[k]![0], to: quick[k]![1] })}>{t(`ins.q.${k}` as never)}</button>)}</div>}
        <p className="muted small">{t('ins.active')}: {[dateLabel, m?.from ? `${m.from} → ${m.to}` : null, ...Object.entries(m?.params ?? {}).map(([k, v]) => `${item.params.find((p) => p.key === k)?.label ?? k}: ${item.params.find((p) => p.key === k)?.options.find((o) => o.value === v)?.label ?? v}`)].filter(Boolean).join(' · ')}</p>
        <div className="row wrap">
          <a className="button" href={csvHref} download>{t('ins.csv')}</a>
          <button type="button" onClick={() => window.print()}>{t('ins.print')}</button>
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(window.location.href); }}>{t('ins.copyLink')}</button>
          <button type="button" onClick={saveView}>{t('ins.saveView')}</button>
          {views.length > 0 && <label className="inline">{t('ins.savedViews')}<select value="" onChange={(e) => { const v = views.find((x) => x.name === e.target.value); if (v) applyView(v.q); }}><option value="">—</option>{views.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}</select></label>}
        </div>
        <p className="muted small">{t('ins.laterPhase')}</p>
      </section>
      {loading && !data && <Spinner />}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {data && <>
        {data.warnings?.map((w) => <p key={w} className="warnbox" role="status">⚠ {w}</p>)}
        {data.kpis.length > 0 && <ul className="ins-kpis plain" aria-label={t('ins.kpis')}>{data.kpis.map((k) => (
          <li key={k.key} className={`ins-kpi${k.tone ? ` ${k.tone}` : ''}`}>
            <span className="muted small">{k.label}</span><strong className="big" dir="ltr">{kpiText(k, k.value, cur)}</strong>
            {k.compare?.map((c) => <span key={c.label} className="muted small">{c.label}: {typeof c.value === 'string' && /^-?\d+(\.\d+)?$/.test(c.value) && k.type === 'money' ? money(c.value, cur) : c.value}</span>)}
            <details className="small"><summary>{t('ins.definition')}</summary><p>{k.definition}</p></details>
          </li>))}</ul>}
        {data.chart && <Chart rows={data.rows} x={data.chart.x} series={data.chart.series} kind={data.chart.kind} />}
        <DataTable columns={data.columns} rows={data.rows} totals={data.totals} currency={cur} storageKey={`${pid}.${item.id}`} caption={`${item.name}. ${dateLabel}${m?.from ? ` ${m.from} – ${m.to}` : ''}`} />
        {data.notes?.map((n) => <p key={n} className="muted small">ℹ {n}</p>)}
        {data.definitions.length > 0 && <details className="card inner"><summary>{t('ins.definitions')}</summary><dl className="stack small">{data.definitions.map((d) => <div key={d.term}><dt><strong>{d.term}</strong></dt><dd>{d.text}</dd></div>)}</dl></details>}
        <p className="muted small">{t('ins.footer', { by: m?.generatedBy ?? '', v: m?.definitionVersion ?? '1' })}</p>
      </>}
    </article>
  );
}
