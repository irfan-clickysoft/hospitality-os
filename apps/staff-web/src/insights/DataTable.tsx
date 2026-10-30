import { useMemo, useState } from 'react';
import { useT } from '../i18n/index.js';
import { money, shortDate } from '../lib/format.js';
import { navigate } from '../shell/router.js';
import type { Cell, Col, Row } from './types.js';

const minor = (v: string): string => { const n = BigInt(v); const neg = n < 0n; const a = neg ? -n : n; return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`; };
export function fmt(col: Col, v: Cell, row: Row | null, currency: string, locale: 'en' | 'ur'): string {
  if (v === null || v === undefined || v === '') return '';
  if (row?._fmt && (col.key === 'today' || col.key === 'mtd')) return row._fmt === 'money' ? money(String(v), currency) : row._fmt === 'pct' ? `${v}%` : String(v);
  switch (col.type) {
    case 'money': return money(minor(String(v)), currency);
    case 'pct': return `${v}%`;
    case 'int': return Number(v).toLocaleString('en-US');
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? shortDate(String(v), locale) : String(v);
    default: return String(v);
  }
}
const num = (col: Col, v: Cell) => (v === null || v === '' ? null : col.type === 'money' ? Number(BigInt(String(v))) : typeof v === 'number' ? v : Number(v));

/** A report table: search, sort, column choice, totals, and a link from each row to its source record. On a narrow screen every row becomes a compact record. */
export function DataTable({ columns, rows, totals, currency, storageKey, caption }: { columns: Col[]; rows: Row[]; totals: Row | null; currency: string; storageKey: string; caption: string }) {
  const { t, locale } = useT();
  const [q, setQ] = useState(''); const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [shown, setShown] = useState<string[]>(() => { try { const s = JSON.parse(localStorage.getItem(`hos.ins.cols.${storageKey}`) ?? 'null') as string[] | null; if (s) return s; } catch { /* default */ } return columns.filter((c) => !c.hidden).map((c) => c.key); });
  const setCols = (next: string[]) => { setShown(next); try { localStorage.setItem(`hos.ins.cols.${storageKey}`, JSON.stringify(next)); } catch { /* not saved */ } };
  const cols = columns.filter((c) => shown.includes(c.key));
  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let r = needle ? rows.filter((x) => Object.entries(x).some(([k, v]) => !k.startsWith('_') && String(v ?? '').toLowerCase().includes(needle))) : rows;
    if (sort) { const c = columns.find((x) => x.key === sort.key); if (c) r = [...r].sort((a, b) => { const x = num(c, a[c.key] ?? null), y = num(c, b[c.key] ?? null); if (x !== null && y !== null && !Number.isNaN(x) && !Number.isNaN(y)) return (x - y) * sort.dir; return String(a[c.key] ?? '').localeCompare(String(b[c.key] ?? '')) * sort.dir; }); }
    return r;
  }, [rows, q, sort, columns]);
  const drill = rows.some((r) => r._res);
  const toggle = (k: string) => setCols(shown.includes(k) ? shown.filter((x) => x !== k) : columns.filter((c) => shown.includes(c.key) || c.key === k).map((c) => c.key));
  return (
    <div className="stack">
      <div className="row between wrap no-print">
        <input type="search" className="ins-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('ins.search')} aria-label={t('ins.search')} />
        <details className="ins-cols"><summary>{t('ins.columns')}</summary><div className="card inner stack">{columns.filter((c) => c.label).map((c) => <label key={c.key} className="check"><input type="checkbox" checked={shown.includes(c.key)} onChange={() => toggle(c.key)} /> {c.label}</label>)}</div></details>
      </div>
      <p className="muted small" aria-live="polite">{t('ins.rowsShown', { n: view.length, total: rows.length })}</p>
      <div className="ins-tablewrap" tabIndex={0} role="region" aria-label={caption}>
        <table className="ins-table">
          <caption className="sr-only">{caption}</caption>
          <thead><tr>{cols.map((c) => <th key={c.key} scope="col" className={c.type === 'money' || c.type === 'int' || c.type === 'pct' ? 'num' : ''} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
            <button type="button" className="link" onClick={() => setSort(sort?.key === c.key ? (sort.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 })}>{c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button></th>)}{drill && <th scope="col" className="no-print"><span className="sr-only">{t('ins.source')}</span></th>}</tr></thead>
          <tbody>{view.map((r, i) => (
            <tr key={i}>{cols.map((c) => { const text = fmt(c, r[c.key] ?? null, r, currency, locale); const neg = c.type === 'money' && String(r[c.key] ?? '').startsWith('-');
              return <td key={c.key} data-label={c.label} className={`${c.type === 'money' || c.type === 'int' || c.type === 'pct' ? 'num' : ''}${neg ? ' neg' : ''}`}>{c.type === 'badge' && text ? <span className="st st-neutral">{text}</span> : text}</td>; })}
              {drill && <td className="no-print">{r._res ? <button type="button" className="link" onClick={() => navigate(`/reservations/${r._res}`)}>{t('ins.open')}</button> : null}</td>}</tr>))}
            {view.length === 0 && <tr><td colSpan={cols.length + (drill ? 1 : 0)} className="muted center">{t('ins.empty')}</td></tr>}</tbody>
          {totals && <tfoot><tr>{cols.map((c, i) => <td key={c.key} data-label={c.label} className={c.type === 'money' || c.type === 'int' ? 'num' : ''}>{i === 0 ? <strong>{t('ins.total')}</strong> : totals[c.key] === undefined ? '' : <strong>{fmt(c, totals[c.key] ?? null, null, currency, locale)}</strong>}</td>)}{drill && <td />}</tr></tfoot>}
        </table>
      </div>
    </div>
  );
}
