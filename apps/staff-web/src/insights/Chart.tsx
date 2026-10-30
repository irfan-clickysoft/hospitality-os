import { useT } from '../i18n/index.js';
import type { Row } from './types.js';

/** A small chart for one measure. It always has a text summary; the table under it holds every figure. */
export function Chart({ rows, x, series, kind }: { rows: Row[]; x: string; series: Array<{ key: string; label: string }>; kind: 'bar' | 'line' }) {
  const { t } = useT();
  const s = series[0]!; const pts = rows.map((r) => ({ label: String(r[x] ?? ''), v: Number(r[s.key] ?? 0) })).slice(0, 120);
  if (pts.length < 2) return null;
  const max = Math.max(1, ...pts.map((p) => p.v)); const W = 640, H = 160, pad = 24; const step = (W - pad * 2) / pts.length; const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const hi = pts.reduce((a, b) => (b.v > a.v ? b : a)); const lo = pts.reduce((a, b) => (b.v < a.v ? b : a));
  const summary = t('ins.chartSummary', { what: s.label, n: pts.length, hi: `${hi.v} (${hi.label})`, lo: `${lo.v} (${lo.label})` });
  return (
    <figure className="ins-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} preserveAspectRatio="none">
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="currentColor" strokeOpacity="0.3" />
        {kind === 'bar' ? pts.map((p, i) => <rect key={i} x={pad + i * step + step * 0.12} y={y(p.v)} width={Math.max(1, step * 0.76)} height={H - pad - y(p.v)} fill="var(--accent, #0b6b66)" />)
          : <polyline fill="none" stroke="var(--accent, #0b6b66)" strokeWidth="2" points={pts.map((p, i) => `${pad + i * step + step / 2},${y(p.v)}`).join(' ')} />}
        <text x={pad} y={12} fontSize="11" fill="currentColor">{max}</text><text x={pad} y={H - 6} fontSize="11" fill="currentColor">{pts[0]!.label}</text><text x={W - pad} y={H - 6} fontSize="11" textAnchor="end" fill="currentColor">{pts[pts.length - 1]!.label}</text>
      </svg>
      <figcaption className="muted small">{s.label}. {summary} {t('ins.chartTable')}</figcaption>
    </figure>
  );
}
