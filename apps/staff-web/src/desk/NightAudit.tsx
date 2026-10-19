import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { Badge, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';

interface Exc { kind: string; severity: 'BLOCKING' | 'WARNING'; overridable: boolean; count: number; items: Array<Record<string, unknown>>; message: string }
interface Status { businessDate: string; lastCompleted: { businessDate: string; completedAt: string } | null; currentRun: { id: string; status: string; error: string | null } | null; exceptions: Exc[]; canStart: boolean; needsOverride: string[] }
interface Run { id: string; businessDate: string; status: string; resumedCount: number; steps: Array<{ key: string; status: string; error: string | null }>; summary?: { roomsSold: number; occupancyPct: number; roomRevenue: Amount; nextBusinessDate: string } }
interface Report {
  businessDate: string; occupancy: { roomsAvailable: number; roomsSold: number; occupancyPct: number }; revenue: { room: Amount; fees: Amount; other: Amount; adr: Amount; revPar: Amount };
  movement: { arrivals: number; departures: number; inHouse: number; noShows: number; cancellations: number }; ledger: { guestLedger: Amount; advanceDeposits: Amount }; paymentsByTender: Record<string, Amount>; cashierVariance: Amount;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
/** One readable line per item, in the staff member's language where we wrote the words. */
function describe(t: (k: Key, v?: Record<string, string | number>) => string, kind: string, it: Record<string, unknown>): string {
  switch (kind) {
    case 'OPEN_CASHIER_SESSION': return [str(it.cashier), str(it.register)].filter(Boolean).join(' · ');
    case 'DEPARTURE_OVERDUE': return [it.room ? `${t('d.room')} ${str(it.room)}` : '', str(it.confirmationNo), t('au.dueOn', { date: str(it.departure) })].filter(Boolean).join(' · ');
    case 'ARRIVAL_PENDING': return [str(it.guest), str(it.confirmationNo), str(it.arrival)].filter(Boolean).join(' · ');
    case 'PENDING_BANK_TRANSFER': return [str(it.amount), str(it.reference)].filter(Boolean).join(' · ');
    case 'EARLY_AUDIT': return t('au.early', { date: str(it.businessDate), hour: str(it.localHour) });
    default: return [str(it.kind), str(it.date), str(it.detail)].filter(Boolean).join(' · ');
  }
}

/** Closing the day: what is in the way, what a manager can override, the run itself, and the finished days' reports. */
export function NightAudit() {
  const { t } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/night-audit`;
  const st = useLive<Status>(`${base}/status`, 20_000);
  const days = useLive<{ items: Array<{ businessDate: string; occupancyPct: number; roomRevenue: Amount; roomsSold: number }> }>(can('report.view') ? `${base}/reports?limit=14` : null, 60_000);
  const withStepUp = useStepUp();
  const [reasons, setReasons] = useState<Record<string, string>>({}); const [run, setRun] = useState<Run | null>(null); const [report, setReport] = useState<string | null>(null);
  const a = useAction();
  const s = st.data;
  if (!s) return <Spinner />;
  const need = s.exceptions.filter((e) => e.severity === 'BLOCKING' && e.overridable);
  const ready = need.every((e) => (reasons[e.kind] ?? '').trim().length >= 3);
  const start = async () => {
    const overrides = need.map((e) => ({ kind: e.kind, reason: reasons[e.kind]!.trim() }));
    const r = await a.run(() => withStepUp(() => api<Run>('POST', `${base}/runs`, { overrides })));
    if (r) { setRun(r); st.reload(); days.reload(); }
  };
  return (
    <section>
      <h2>{t('nav.audit')}</h2>
      <div className="card stack">
        <div className="row between"><span>{t('property.businessDate')}</span><strong className="big">{s.businessDate}</strong></div>
        <p className="muted small">{s.lastCompleted ? t('au.last', { date: s.lastCompleted.businessDate }) : t('au.never')}</p>
        {s.currentRun && s.currentRun.status !== 'COMPLETED' && <p className="warnbox">{t('au.unfinished')} {s.currentRun.error ?? ''}</p>}
      </div>
      {s.exceptions.length === 0 && <p className="ok">✓ {t('au.allClear')}</p>}
      {s.exceptions.map((e) => (
        <div key={e.kind} className={`card inner stack${e.severity === 'BLOCKING' ? ' blocking' : ''}`}>
          <div className="row between"><strong>{t(`au.k.${e.kind}` as Key)}</strong><Badge tone={e.severity === 'BLOCKING' ? 'dirty' : 'warn'}>{e.severity === 'BLOCKING' ? t('au.blocking') : t('au.warning')} · {e.count}</Badge></div>
          <ul className="small plain">{e.items.slice(0, 6).map((it, i) => <li key={i}>{describe(t, e.kind, it)}</li>)}</ul>
          {e.severity === 'BLOCKING' && !e.overridable && <p className="error small">{t('au.cannotOverride')}</p>}
          {e.severity === 'BLOCKING' && e.overridable && (can('nightaudit.override')
            ? <label>{t('au.overrideReason')}<input value={reasons[e.kind] ?? ''} onChange={(ev) => setReasons({ ...reasons, [e.kind]: ev.target.value })} /></label>
            : <p className="error small">{t('au.needsManager')}</p>)}
        </div>
      ))}
      <ErrorLine code={a.problem?.code} detail={a.problem?.detail} />
      {can('nightaudit.run') && <div className="actions"><button className="primary" disabled={a.busy || !s.canStart || (need.length > 0 && (!ready || !can('nightaudit.override')))} onClick={start}>{s.currentRun ? t('au.resume') : t('au.run')}</button></div>}
      {run && (
        <div className="card stack"><div className="row between"><strong>{t('au.result')}</strong><Badge tone={run.status === 'COMPLETED' ? 'clean' : 'dirty'}>{t(`au.s.${run.status}` as Key)}</Badge></div>
          <ul className="plain small">{run.steps.map((x) => <li key={x.key} className="row between"><span>{t(`au.step.${x.key}` as Key)}</span><span className={x.status === 'DONE' ? 'ok' : x.status === 'FAILED' ? 'error' : 'muted'}>{x.status}</span></li>)}</ul>
          {run.summary && <p>{t('au.summary', { sold: run.summary.roomsSold, occ: run.summary.occupancyPct, rev: money(run.summary.roomRevenue), next: run.summary.nextBusinessDate })}</p>}</div>
      )}
      {days.data && days.data.items.length > 0 && (<>
        <h3>{t('au.reports')}</h3>
        <ul className="plain rows">{days.data.items.map((d) => <li key={d.businessDate}><button className="row-card" onClick={() => setReport(d.businessDate)}><span className="rc-main"><strong>{d.businessDate}</strong><span className="muted small">{d.roomsSold} {t('au.sold')} · {d.occupancyPct}%</span></span><span className="rc-side"><strong>{money(d.roomRevenue)}</strong></span></button></li>)}</ul></>)}
      {report && <ReportSheet date={report} onClose={() => setReport(null)} />}
    </section>
  );
}

function ReportSheet({ date, onClose }: { date: string; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const r = useLive<Report>(`/v1/properties/${property!.id}/night-audit/reports/${date}`, 600_000);
  const d = r.data;
  const row = (k: string, v: string) => <div className="row between" key={k}><span>{k}</span><strong>{v}</strong></div>;
  return (<Sheet title={`${t('au.report')} · ${date}`} onClose={onClose}>
    {!d ? <Spinner /> : (<>
      <div className="card inner stack small">
        {row(t('au.occupancy'), `${d.occupancy.occupancyPct}% (${d.occupancy.roomsSold}/${d.occupancy.roomsAvailable})`)}
        {row(t('au.roomRevenue'), money(d.revenue.room))}{row(t('au.adr'), money(d.revenue.adr))}{row(t('au.revpar'), money(d.revenue.revPar))}
        {row(t('au.fees'), money(d.revenue.fees))}{row(t('au.other'), money(d.revenue.other))}
      </div>
      <p className="muted small">{t('bk.exTaxNote')}</p>
      <div className="card inner stack small">{row(t('au.arrivals'), String(d.movement.arrivals))}{row(t('au.departures'), String(d.movement.departures))}{row(t('today.inHouse'), String(d.movement.inHouse))}{row(t('au.noShows'), String(d.movement.noShows))}</div>
      <div className="card inner stack small">{row(t('au.guestLedger'), money(d.ledger.guestLedger))}{row(t('au.deposits'), money(d.ledger.advanceDeposits))}{row(t('cash.variance'), money(d.cashierVariance))}</div>
      <h3>{t('au.payments')}</h3>
      <div className="card inner stack small">{Object.entries(d.paymentsByTender).map(([k, v]) => row(t(`au.tender.${k}` as Key) === `au.tender.${k}` ? k : t(`au.tender.${k}` as Key), money(v)))}</div>
    </>)}
  </Sheet>);
}
