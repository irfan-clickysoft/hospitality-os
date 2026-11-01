import { useT } from '../i18n/index.js';
import { money } from '../lib/format.js';
import { Chart } from './Chart.js';
import { DataTable } from './DataTable.js';
import type { Envelope, Kpi } from './types.js';

export const kpiText = (k: Kpi, v: string | number, currency: string) => (k.type === 'money' && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? money(v, currency) : k.type === 'pct' ? `${v}%` : typeof v === 'number' ? v.toLocaleString('en-US') : String(v));

/** Everything under the header of a report: warnings, key figures with their definitions, chart, table, notes, definitions. Used for the live report and for a delivered copy. */
export function ReportBody({ data, name, storageKey }: { data: Envelope; name: string; storageKey: string }) {
  const { t } = useT();
  const m = data.meta; const cur = m.currency; const dateLabel = m.dateBasis.label;
  return (
    <>
        {data.warnings?.map((w) => <p key={w} className="warnbox" role="status">⚠ {w}</p>)}
        {data.kpis.length > 0 && <ul className="ins-kpis plain" aria-label={t('ins.kpis')}>{data.kpis.map((k) => (
          <li key={k.key} className={`ins-kpi${k.tone ? ` ${k.tone}` : ''}`}>
            <span className="muted small">{k.label}</span><strong className="big" dir="ltr">{kpiText(k, k.value, cur)}</strong>
            {k.compare?.map((c) => <span key={c.label} className="muted small">{c.label}: {typeof c.value === 'string' && /^-?\d+(\.\d+)?$/.test(c.value) && k.type === 'money' ? money(c.value, cur) : c.value}</span>)}
            <details className="small"><summary>{t('ins.definition')}</summary><p>{k.definition}</p></details>
          </li>))}</ul>}
        {data.chart && <Chart rows={data.rows} x={data.chart.x} series={data.chart.series} kind={data.chart.kind} />}
        <DataTable columns={data.columns} rows={data.rows} totals={data.totals} currency={cur} storageKey={storageKey} caption={`${name}. ${dateLabel}${m?.from ? ` ${m.from} – ${m.to}` : ''}`} />
        {data.notes?.map((n) => <p key={n} className="muted small">ℹ {n}</p>)}
        {data.definitions.length > 0 && <details className="card inner"><summary>{t('ins.definitions')}</summary><dl className="stack small">{data.definitions.map((d) => <div key={d.term}><dt><strong>{d.term}</strong></dt><dd>{d.text}</dd></div>)}</dl></details>}
        <p className="muted small">{t('ins.footer', { by: m.generatedBy ?? '', v: m.definitionVersion ?? '1' })}</p>

    </>
  );
}
