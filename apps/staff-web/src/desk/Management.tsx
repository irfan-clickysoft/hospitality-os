import { useState } from 'react';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { addDays, money } from '../lib/format.js';
import { useLive } from '../state.js';
import { Chip, Empty, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';

interface Prop {
  id: string; name: string; businessDate: string;
  period: { occupancyPct: number; roomsSold: number; roomsAvailable: number; roomRevenue: Amount; adr: Amount; revPar: Amount; fees: Amount; otherRevenue: Amount; tax: Amount; noShows: number; cancellations: number };
  trend: Array<{ date: string; occupancyPct: number }>;
  today: { arrivals: number; departures: number; inHouse: number; rooms: number; outOfOrder: number; occupancyPct: number };
  upcoming: { reservations: number; roomNights: number; value: Amount; atRisk: number; atRiskValue: Amount };
  cash: { openSessions: number; awaitingReview: number; variance: Amount };
  approvals: { paymentsToVerify: number; paymentsToVerifyAmount: Amount; sessionsToReview: number };
  issues: { open: number; oldestHours: number };
  revenueProtection: { otaConfirmed: number; otaGuaranteed: number; otaAtRisk: number; depositConversionPct: number; otaCreated: number; feesNet: Amount };
}
interface Overview {
  from: string; to: string; scope: string;
  totals: { occupancyPct: number; roomsSold: number; roomsAvailable: number; roomRevenue: Amount; adr: Amount; revPar: Amount; arrivalsToday: number; departuresToday: number; inHouse: number };
  properties: Prop[]; salesBySource: Array<{ source: string; amount: Amount }>; salesByCompany: Array<{ companyId: string | null; company: string | null; amount: Amount }>;
  receivables: { asOf: string; totalOpen: Amount; buckets: Record<string, Amount> } | null;
  approvals: { companyReceiptsToVerify: number; companyReceiptsAmount: Amount; taxRatesAwaitingApproval: number };
}
const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
const zero = (a?: Amount) => !a || /^-?0+(\.0+)?$/.test(a.amount);

const Tile = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <div className="card inner stack tile"><span className="muted small">{label}</span><strong className="big">{value}</strong>{sub && <span className="muted small">{sub}</span>}</div>
);
/** Occupancy per closed day as plain bars (no chart library): height is the percentage. */
function Bars({ days }: { days: Array<{ date: string; occupancyPct: number }> }) {
  if (days.length === 0) return null;
  const w = 8, gap = 3;
  return (
    <svg role="img" aria-label="occupancy" viewBox={`0 0 ${days.length * (w + gap)} 40`} width="100%" height="40" preserveAspectRatio="none" style={{ color: 'var(--brand)' }}>
      {days.map((d, i) => <rect key={d.date} x={i * (w + gap)} y={40 - Math.max(1, d.occupancyPct * 0.4)} width={w} height={Math.max(1, d.occupancyPct * 0.4)} rx="1" fill="currentColor"><title>{d.date}: {d.occupancyPct}%</title></rect>)}
    </svg>
  );
}

/** The owner’s page: closed days from the audit snapshots, today live. Read-only. */
export function Management() {
  const { t } = useT();
  const [days, setDays] = useState(14);
  const first = useLive<Overview>('/v1/management/overview', 120_000);
  const to = first.data?.to;
  const ranged = useLive<Overview>(to && days !== 14 ? `/v1/management/overview?from=${addDays(to, -(days - 1))}&to=${to}` : null, 120_000);
  const d = days === 14 ? first.data : ranged.data;
  if (!d) return <Spinner />;
  return (
    <section className="stack">
      <h2>{t('nav.management')}</h2>
      <div className="chips">{[7, 14, 30, 90].map((n) => <Chip key={n} active={days === n} onClick={() => setDays(n)}>{t('mg.days', { n })}</Chip>)}</div>
      <p className="muted small">{d.from} → {d.to} · {t('mg.closedOnly')}</p>
      <div className="grid2">
        <Tile label={t('au.occupancy')} value={`${d.totals.occupancyPct}%`} sub={`${d.totals.roomsSold}/${d.totals.roomsAvailable}`} />
        <Tile label={t('au.roomRevenue')} value={money(d.totals.roomRevenue)} />
        <Tile label={t('au.adr')} value={money(d.totals.adr)} />
        <Tile label={t('au.revpar')} value={money(d.totals.revPar)} />
      </div>
      <div className="card stack small"><strong>{t('mg.today')}</strong>
        <div className="row between"><span>{t('au.arrivals')}</span><strong>{d.totals.arrivalsToday}</strong></div>
        <div className="row between"><span>{t('au.departures')}</span><strong>{d.totals.departuresToday}</strong></div>
        <div className="row between"><span>{t('today.inHouse')}</span><strong>{d.totals.inHouse}</strong></div></div>

      <h3>{t('mg.properties')}</h3>
      {d.properties.map((p) => (
        <div key={p.id} className="card stack small">
          <div className="row between"><strong>{p.name}</strong><span className="muted">{p.businessDate}</span></div>
          <Bars days={p.trend} />
          <div className="row between"><span>{t('au.occupancy')}</span><strong>{p.period.occupancyPct}%</strong></div>
          <div className="row between"><span>{t('au.roomRevenue')}</span><strong>{money(p.period.roomRevenue)}</strong></div>
          <div className="row between"><span>{t('au.adr')} · {t('au.revpar')}</span><span dir="ltr">{money(p.period.adr)} · {money(p.period.revPar)}</span></div>
          <div className="row between"><span>{t('mg.todayNow')}</span><span>{t('mg.todayLine', { a: p.today.arrivals, d: p.today.departures, h: p.today.inHouse })}</span></div>
          <div className="row between"><span>{t('mg.coming')}</span><span>{t('mg.comingLine', { n: p.upcoming.reservations, nights: p.upcoming.roomNights })}</span></div>
          {p.upcoming.atRisk > 0 && <div className="row between"><span className="error">{t('mg.atRisk')}</span><strong className="error">{p.upcoming.atRisk} · {money(p.upcoming.atRiskValue)}</strong></div>}
          {p.revenueProtection.otaConfirmed > 0 && <div className="row between"><span>{t('mg.ota')}</span><span>{t('mg.otaLine', { g: p.revenueProtection.otaGuaranteed, n: p.revenueProtection.otaConfirmed, pct: p.revenueProtection.depositConversionPct })}</span></div>}
          {!zero(p.revenueProtection.feesNet) && <div className="row between"><span>{t('mg.feesRecovered')}</span><strong>{money(p.revenueProtection.feesNet)}</strong></div>}
          {(p.cash.openSessions > 0 || !zero(p.cash.variance)) && <div className="row between"><span>{t('cash.variance')}</span><strong className={!zero(p.cash.variance) ? 'error' : ''}>{money(p.cash.variance)}</strong></div>}
          {p.issues.open > 0 && <div className="row between"><span>{t('mg.issues')}</span><span>{t('mg.issuesLine', { n: p.issues.open, h: p.issues.oldestHours })}</span></div>}
        </div>))}

      {d.receivables && !zero(d.receivables.totalOpen) && (
        <div className="card stack small"><div className="row between"><strong>{t('ar.receivable')}</strong><strong>{money(d.receivables.totalOpen)}</strong></div>
          {BUCKETS.map((b) => !zero(d.receivables!.buckets[b]) && <div key={b} className="row between"><span className="muted">{t(`ar.b.${b}` as Key)}</span><span dir="ltr">{money(d.receivables!.buckets[b]!)}</span></div>)}</div>)}

      <div className="card stack small"><strong>{t('mg.approvals')}</strong>
        {(() => {
          const pay = d.properties.reduce((a, p) => a + p.approvals.paymentsToVerify, 0), sess = d.properties.reduce((a, p) => a + p.approvals.sessionsToReview, 0);
          const rows: Array<[string, number]> = [[t('mg.payVerify'), pay], [t('mg.sessionReview'), sess], [t('mg.arVerify'), d.approvals.companyReceiptsToVerify], [t('mg.taxApprove'), d.approvals.taxRatesAwaitingApproval]];
          return rows.every(([, n]) => n === 0) ? <span className="ok">✓ {t('mg.nothingPending')}</span> : rows.map(([k, n]) => n > 0 && <div key={k} className="row between"><span>{k}</span><strong>{n}</strong></div>);
        })()}</div>

      <h3>{t('mg.bySource')}</h3>
      {d.salesBySource.length === 0 ? <Empty text={t('common.none')} /> : <div className="card stack small">{d.salesBySource.map((s) => <div key={s.source} className="row between"><span>{t(`src.${s.source}` as Key) === `src.${s.source}` ? s.source : t(`src.${s.source}` as Key)}</span><strong>{money(s.amount)}</strong></div>)}</div>}
      {d.salesByCompany.length > 0 && (<><h3>{t('mg.byCompany')}</h3><div className="card stack small">{d.salesByCompany.map((s) => <div key={s.companyId} className="row between"><span>{s.company}</span><strong>{money(s.amount)}</strong></div>)}</div></>)}
      <p className="muted small">{t('bk.exTaxNote')}</p>
    </section>
  );
}
