import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useLive } from '../state.js';
import { Badge, Empty, Spinner } from '../ui/kit.js';

interface Check { code: string; status: 'OK' | 'ACTION' | 'NOTE'; propertyId: string | null; propertyName: string | null; count?: number; detail?: string }

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const days = (d?: string) => (d ? d.split(',').map((x) => DAYS[Number(x) - 1] ?? x).join(', ') : '—');

/** What is set up and what is still missing, in plain words, so nothing runs on a guess. */
export function Readiness() {
  const { t } = useT();
  const r = useLive<{ items: Check[]; summary: { action: number; note: number; ok: number } }>('/v1/readiness', 60_000);
  if (!r.data) return <Spinner />;
  const tone = (s: Check['status']) => (s === 'OK' ? 'clean' : s === 'ACTION' ? 'dirty' : 'warn') as 'clean' | 'dirty' | 'warn';
  const groups = [...new Set(r.data.items.map((x) => x.propertyName ?? ''))];
  return (
    <section className="stack">
      <h2>{t('nav.readiness')}</h2>
      <p className="muted">{t('rd.summary', { a: r.data.summary.action, n: r.data.summary.note, o: r.data.summary.ok })}</p>
      {r.data.items.length === 0 && <Empty text={t('common.none')} />}
      {groups.map((g) => (
        <div key={g} className="stack"><h3>{g || t('rd.business')}</h3>
          <ul className="plain">{r.data!.items.filter((x) => (x.propertyName ?? '') === g).map((x, i) => (
            <li key={`${x.code}-${i}`} className="card inner row between small"><span>{t(`rd.${x.code}` as Key, { n: x.count ?? 0, d: x.code === 'WEEKEND' ? days(x.detail) : (x.detail ?? '') })}</span><Badge tone={tone(x.status)}>{t(`rd.s.${x.status}` as Key)}</Badge></li>))}</ul></div>))}
    </section>
  );
}
