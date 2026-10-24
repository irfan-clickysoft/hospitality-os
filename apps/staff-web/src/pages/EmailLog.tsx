import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { useAuth, useLive } from '../state.js';
import { Badge, ErrorLine } from '../ui/kit.js';

interface Row { id: string; purpose: string; to: string; subject: string; status: 'QUEUED' | 'SENT' | 'FAILED' | 'DELIVERED' | 'BOUNCED' | 'COMPLAINED'; error: string | null; createdAt: string }
interface Blocked { address: string; reason: 'BOUNCE' | 'COMPLAINT'; detail: string | null }
const TONE = { QUEUED: 'neutral', SENT: 'neutral', DELIVERED: 'clean', FAILED: 'dirty', BOUNCED: 'dirty', COMPLAINED: 'dirty' } as const;

/** The emails the system sent, what became of each, and the addresses it will no longer write to (they bounced or were reported as spam). */
export function EmailLog() {
  const { t } = useT(); const { property, can } = useAuth(); const { busy, problem, run } = useAction();
  const b = `/v1/properties/${property!.id}/email`;
  const log = useLive<{ items: Row[] }>(can('report.view') ? `${b}/recent?limit=30` : null, 30_000);
  const blocked = useLive<{ items: Blocked[] }>(can('report.view') ? `${b}/suppressed` : null, 60_000);
  if (!can('report.view')) return null;
  return (
    <section className="stack">
      <h3>{t('em.logTitle')}</h3>
      {blocked.data && blocked.data.items.length > 0 && (
        <div className="warnbox stack small">
          <strong>{t('em.blocked')}</strong>
          {blocked.data.items.map((x) => (
            <div key={x.address} className="row between"><span dir="ltr">{x.address} <span className="muted">· {x.detail ?? x.reason}</span></span>
              {can('property.manage') && <button disabled={busy} onClick={async () => { if (await run(() => api('DELETE', `${b}/suppressed/${encodeURIComponent(x.address)}`))) blocked.reload(); }}>{t('em.allow')}</button>}</div>))}
        </div>)}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {!log.data ? null : log.data.items.length === 0 ? <p className="muted small">{t('common.none')}</p> : (
        <ul className="plain small">{log.data.items.map((r) => (
          <li key={r.id} className="card inner stack">
            <div className="row between"><strong dir="ltr">{r.to}</strong><Badge tone={TONE[r.status]}>{t(`em.s.${r.status}` as Key)}</Badge></div>
            <span className="muted">{r.subject} · {new Date(r.createdAt).toLocaleString()}</span>
            {r.error && <span className="muted" dir="ltr">{r.error}</span>}
          </li>))}</ul>)}
    </section>
  );
}
