import { useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { newKey } from '../lib/format.js';
import { FIELDS, parseTable, tableToRows, templateCsv, type Kind } from '../lib/table.js';
import { useStepUp } from '../lib/stepup.js';
import { Badge, ErrorLine } from '../ui/kit.js';

interface RowResult { row: number; status: 'NEW' | 'EXISTS' | 'DUPLICATE_IN_FILE' | 'INVALID'; errors: string[]; existing?: { id: string; name: string }; action?: string }
interface Result { summary: { total: number; new: number; exists: number; duplicateInFile: number; invalid: number; created?: number; filled?: number }; rows: RowResult[]; replayed?: boolean }
const tone = (s: string) => (s === 'NEW' ? 'clean' : s === 'EXISTS' ? 'warn' : s === 'INVALID' ? 'dirty' : 'neutral') as 'clean' | 'warn' | 'dirty' | 'neutral';

/** Bring guests or corporate accounts in from Excel: paste the cells (or open a CSV), look at what will happen, then import. */
export function Import() {
  const { t } = useT();
  const withStepUp = useStepUp();
  const [kind, setKind] = useState<Kind>('guests'); const [text, setText] = useState(''); const [fill, setFill] = useState(false);
  const [preview, setPreview] = useState<Result | null>(null); const [done, setDone] = useState<Result | null>(null);
  const key = useRef(newKey());
  const { busy, problem, run, clear } = useAction();
  const parsed = tableToRows(kind, parseTable(text));
  const body = () => ({ rows: parsed.rows, ...(kind === 'guests' ? { onExisting: fill ? 'FILL_BLANKS' : 'SKIP' } : {}) });
  const reset = () => { setPreview(null); setDone(null); clear(); key.current = newKey(); };
  const check = async () => { setDone(null); const r = await run(() => withStepUp(() => api<Result>('POST', `/v1/imports/${kind}/preview`, body()))); if (r) setPreview(r); };
  const commit = async () => { const r = await run(() => withStepUp(() => api<Result>('POST', `/v1/imports/${kind}`, body(), { 'idempotency-key': key.current }))); if (r) { setDone(r); setPreview(null); } };
  const onFile = (f: File | undefined) => { if (f) void f.text().then((x) => { setText(x); reset(); }); };
  const res = done ?? preview;
  const label = (r: RowResult) => r.errors.map((e) => (t(`imp.e.${e.replace(/\d+$/, 'N')}` as Key, { n: e.match(/\d+$/)?.[0] ?? '' }) as string)).join(' · ');
  return (
    <section className="stack">
      <h2>{t('nav.import')}</h2>
      <div className="chips">{(['guests', 'companies'] as const).map((k) => <button key={k} className={`chip${kind === k ? ' on' : ''}`} onClick={() => { setKind(k); setText(''); reset(); }}>{t(`imp.k.${k}` as Key)}</button>)}</div>
      <p className="muted small">{t('imp.help')}</p>
      <p className="muted small" dir="ltr">{FIELDS[kind].join(' · ')}</p>
      <div className="row"><input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => onFile(e.target.files?.[0])} aria-label={t('imp.file')} />
        <a className="button" href={`data:text/csv;charset=utf-8,${encodeURIComponent(templateCsv(kind))}`} download={`${kind}-template.csv`}>{t('imp.template')}</a></div>
      <textarea rows={8} value={text} dir="ltr" placeholder={t('imp.paste')} onChange={(e) => { setText(e.target.value); reset(); }} style={{ width: '100%', fontFamily: 'monospace' }} />
      {text.trim() && <p className="muted small">{t('imp.read', { n: parsed.rows.length })}{parsed.usedHeaders ? ` · ${t('imp.headers')}` : ` · ${t('imp.noHeaders')}`}{parsed.ignored.length ? ` · ${t('imp.ignored', { cols: parsed.ignored.join(', ') })}` : ''}</p>}
      {kind === 'guests' && <label className="row"><input type="checkbox" checked={fill} onChange={(e) => { setFill(e.target.checked); reset(); }} /> {t('imp.fill')}</label>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button disabled={busy || parsed.rows.length === 0} onClick={check}>{t('imp.check')}</button>
        {preview && !done && <button className="primary" disabled={busy || (preview.summary.new === 0 && !(kind === 'guests' && fill && preview.summary.exists > 0))} onClick={commit}>{t('imp.import', { n: preview.summary.new })}</button>}</div>
      {res && (<div className="card stack small">
        {done ? <strong className="ok">✓ {t('imp.done', { n: done.summary.created ?? 0 })}{done.summary.filled ? ` · ${t('imp.filled', { n: done.summary.filled })}` : ''}</strong> : <strong>{t('imp.willDo', { n: res.summary.new })}</strong>}
        <div className="row"><Badge tone="clean">{t('imp.s.NEW')} {res.summary.new}</Badge><Badge tone="warn">{t('imp.s.EXISTS')} {res.summary.exists}</Badge><Badge tone="neutral">{t('imp.s.DUPLICATE_IN_FILE')} {res.summary.duplicateInFile}</Badge><Badge tone="dirty">{t('imp.s.INVALID')} {res.summary.invalid}</Badge></div>
        <ul className="plain">{res.rows.filter((r) => r.status !== 'NEW').slice(0, 100).map((r) => (
          <li key={r.row} className="row between"><span>{t('imp.row', { n: r.row })}{r.existing ? ` · ${r.existing.name}` : ''}</span><span className="row"><span className="muted">{label(r)}</span><Badge tone={tone(r.status)}>{t(`imp.s.${r.status}` as Key)}</Badge></span></li>))}</ul>
      </div>)}
    </section>
  );
}
