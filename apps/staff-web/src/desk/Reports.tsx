import { useState } from 'react';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { api } from '../api/client.js';
import { useAction } from '../lib/action.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth } from '../state.js';
import { ErrorLine } from '../ui/kit.js';

const PROPERTY = ['daily-summary', 'revenue-by-code', 'payments', 'invoices', 'tax-liability', 'open-folios', 'in-house'] as const;
const NO_PERIOD = new Set(['open-folios', 'in-house']);

/** Spreadsheet downloads (CSV, opens in Excel) of the figures the accountant and the owner ask for. */
export function Reports() {
  const { t } = useT();
  const { property, can } = useAuth();
  const end = property!.businessDate;
  const [from, setFrom] = useState(`${end.slice(0, 8)}01`); const [to, setTo] = useState(end);
  const q = `?from=${from}&to=${to}`;
  const withStepUp = useStepUp(); const { busy, problem, run } = useAction();
  const foreignRegister = async () => {
    const r = await run(() => withStepUp(() => api<{ filename: string; csv: string }>('GET', `/v1/properties/${property!.id}/registration/foreign-register${q}`)));
    if (!r) return;
    const url = URL.createObjectURL(new Blob(['\uFEFF', r.csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  return (
    <section className="stack">
      <h2>{t('nav.reports')}</h2>
      <p className="muted small">{t('rp.help')}</p>
      <div className="grid2"><label>{t('rp.from')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} dir="ltr" /></label><label>{t('rp.to')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" /></label></div>
      {!ok && <p className="error">{t('rp.badPeriod')}</p>}
      <h3>{property!.name}</h3>
      <ul className="plain rows">{PROPERTY.map((r) => (
        <li key={r} className="card inner row between"><span><strong>{t(`rp.r.${r}` as Key)}</strong><br /><span className="muted small">{t(`rp.d.${r}` as Key)}</span></span>
          <a className="button" aria-disabled={!ok} href={ok ? `/v1/properties/${property!.id}/reports/${r}${NO_PERIOD.has(r) ? '' : q}` : undefined} download>{t('rp.download')}</a></li>))}</ul>
      {can('frontdesk.view_id') && <ul className="plain rows"><li className="card inner row between"><span><strong>{t('rp.r.foreign')}</strong><br /><span className="muted small">{t('rp.d.foreign')}</span></span><button disabled={!ok || busy} onClick={foreignRegister}>{t('rp.download')}</button></li></ul>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {(can('company.view') || can('paymentaccount.view')) && <h3>{t('rp.group')}</h3>}
      <ul className="plain rows">
        {can('company.view') && <li className="card inner row between"><span><strong>{t('rp.r.ar-aging')}</strong><br /><span className="muted small">{t('rp.d.ar-aging')}</span></span><a className="button" href="/v1/reports/ar-aging" download>{t('rp.download')}</a></li>}
        {can('paymentaccount.view') && <li className="card inner row between"><span><strong>{t('rp.r.payment-accounts')}</strong><br /><span className="muted small">{t('rp.d.payment-accounts')}</span></span><a className="button" aria-disabled={!ok} href={ok ? `/v1/reports/payment-accounts${q}` : undefined} download>{t('rp.download')}</a></li>}
      </ul>
    </section>
  );
}
