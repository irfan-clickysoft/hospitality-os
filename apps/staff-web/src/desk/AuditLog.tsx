import { useState } from 'react';
import { useT } from '../i18n/index.js';
import { useLive } from '../state.js';
import { Empty, Spinner } from '../ui/kit.js';

interface Entry { id: string; at: string; actor: string | null; actorType: string; action: string; resourceType: string; property: string | null; reasonCode: string | null; note: string | null }
const GROUPS = ['', 'staff.', 'payment', 'folio.', 'tax.', 'company.', 'ar.', 'ota.', 'invoice.', 'compliance.', 'payment_account.'];

/** Who did what, newest first. Reading it needs the second factor. */
export function AuditLog() {
  const { t, locale } = useT();
  const [g, setG] = useState('');
  const [limit, setLimit] = useState(50);
  const log = useLive<{ items: Entry[] }>(`/v1/audit?limit=${limit}${g ? `&action=${encodeURIComponent(g)}` : ''}`, 60_000);
  const when = (iso: string) => new Date(iso).toLocaleString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { dateStyle: 'short', timeStyle: 'medium' });
  return (
    <section className="stack">
      <h2>{t('nav.audit2')}</h2>
      <label>{t('au2.filter')}<select value={g} onChange={(e) => setG(e.target.value)}>{GROUPS.map((x) => <option key={x} value={x}>{x || t('au2.all')}</option>)}</select></label>
      {!log.data ? <Spinner /> : log.data.items.length === 0 ? <Empty text={t('common.none')} /> : (
        <ul className="plain small">{log.data.items.map((e) => (
          <li key={e.id} className="card inner stack"><div className="row between"><strong dir="ltr">{e.action}</strong><span className="muted">{when(e.at)}</span></div>
            <span className="muted">{e.actor ?? e.actorType}{e.property ? ` · ${e.property}` : ''}{e.reasonCode ? ` · ${e.reasonCode}` : ''}</span>{e.note && <span>{e.note}</span>}</li>))}</ul>)}
      {log.data && log.data.items.length >= limit && <button onClick={() => setLimit(limit + 50)}>{t('au2.more')}</button>}
    </section>
  );
}
