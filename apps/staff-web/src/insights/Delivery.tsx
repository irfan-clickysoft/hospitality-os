import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAuth } from '../state.js';
import { navigate } from '../shell/router.js';
import { ErrorLine, Spinner, problemOf } from '../ui/kit.js';
import { stamp } from '../desk/CaseBits.js';
import { ReportBody } from './ReportBody.js';
import type { Envelope } from './types.js';

/** A report delivered by schedule: the copy as it was generated, so it matches the email and the export. It is checked against the viewer's access every time it is opened. */
export function DeliveryView({ id }: { id: string }) {
  const { t, locale } = useT(); const { property } = useAuth(); const pid = property!.id;
  const [d, setD] = useState<{ envelope: Envelope; delivery: { id: string; schedule: string; generatedAt: string; expiresAt: string; note: string | null } } | null>(null); const [problem, setProblem] = useState<{ code: string; detail?: string } | null>(null);
  useEffect(() => { let dead = false; api<NonNullable<typeof d>>('GET', `/v1/properties/${pid}/insights/deliveries/${id}`).then((r) => { if (!dead) setD(r); }).catch((e) => { if (!dead) setProblem(problemOf(e)); }); return () => { dead = true; }; }, [pid, id]);
  const back = <button type="button" className="link no-print" onClick={() => navigate('/reports?tab=schedules')}>← {t('sch.back')}</button>;
  if (problem) return <section className="stack">{back}<ErrorLine code={problem.code} detail={problem.detail} /></section>;
  if (!d) return <Spinner />;
  const m = d.envelope.meta;
  return (
    <article className="stack ins-report">
      {back}
      <header className="stack"><h2>{d.delivery.schedule}</h2><p className="muted">{m.name} — {m.purpose}</p>
        <dl className="ins-meta small">
          <div><dt>{t('ins.property')}</dt><dd>{m.property.name}</dd></div><div><dt>{t('ins.dateBasis')}</dt><dd>{m.dateBasis.label}{m.from ? ` · ${m.from} → ${m.to}` : ''}</dd></div>
          <div><dt>{t('ins.timezone')}</dt><dd>{m.timezone} · {t('ins.businessDate')} {m.businessDate}</dd></div><div><dt>{t('sch.generated')}</dt><dd>{stamp(d.delivery.generatedAt, locale)}</dd></div>
          <div><dt>{t('sch.expires')}</dt><dd>{stamp(d.delivery.expiresAt, locale)}</dd></div><div><dt>{t('ins.currency')}</dt><dd>{m.currency} · {m.taxBasis}</dd></div>
        </dl></header>
      <p className="muted small" role="status">{t('sch.snapshotNote')}</p>
      {d.delivery.note && <p className="warnbox" role="status">{d.delivery.note}</p>}
      <div className="row wrap no-print"><a className="button" href={`/v1/properties/${pid}/insights/deliveries/${id}/csv`} download>{t('ins.csv')}</a><button type="button" onClick={() => window.print()}>{t('ins.print')}</button></div>
      <ReportBody data={d.envelope} name={m.name} storageKey={`${pid}.delivery.${m.id}`} />
    </article>
  );
}
