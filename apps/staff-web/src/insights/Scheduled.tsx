import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { useAuth, useLive } from '../state.js';
import { Link, useRoute } from '../shell/router.js';
import { Badge, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import { stamp } from '../desk/CaseBits.js';
import type { CatalogItem } from './types.js';

interface Sched { id: string; reportId: string; reportName: string; name: string; period: string; frequency: string; weekday: number | null; monthDay: number | null; alert: { kpi: string; op: string; value: number } | null; recipients: Array<{ id: string; name: string }>; active: boolean; pausedReason: string | null; lastRunOn: string | null; lastStatus: string | null }
interface Recent { id: string; schedule: string; report: string; forDate: string; generatedAt: string; expiresAt: string; expired: boolean; status: string; note: string | null; recipients: number; opened: number; mailFailed: number }
interface Mine { id: string; schedule: string; report: string; forDate: string; generatedAt: string; expiresAt: string; expired: boolean; note: string | null; opened: boolean }
const PERIODS = ['CLOSED_DAY', 'LAST_7', 'LAST_30', 'MONTH_TO_DATE', 'PREVIOUS_MONTH', 'NEXT_7', 'NEXT_30', 'NEXT_90'] as const;
const DAYS = [1, 2, 3, 4, 5, 6, 0] as const; const OPS = ['gt', 'gte', 'lt', 'lte', 'eq'] as const;

/** Reports that arrive by themselves when a business day closes, and the ones delivered to you. */
export function Scheduled() {
  const { t, locale } = useT(); const { property, can } = useAuth(); const pid = property!.id; const base = `/v1/properties/${pid}/insights`; const route = useRoute();
  const mine = useLive<{ items: Mine[] }>(`${base}/deliveries`, 60_000);
  const manage = can('report.schedule');
  const list = useLive<{ items: Sched[]; recent: Recent[] }>(manage ? `${base}/schedules` : null, 60_000);
  const [creating, setCreating] = useState<string | null>(route.query.get('new')); const { busy, problem, run } = useAction();
  return (
    <section className="stack">
      <h2>{t('sch.title')}</h2><p className="muted small">{t('sch.help')}</p>
      <h3>{t('sch.mine')}</h3>
      {!mine.data ? <Spinner /> : mine.data.items.length === 0 ? <Empty text={t('sch.mineEmpty')} /> : (
        <ul className="plain rows">{mine.data.items.map((d) => (
          <li key={d.id} className="card inner row between"><span><strong>{d.schedule}</strong><br /><span className="muted small">{d.report} · {d.forDate} · {d.expired ? t('sch.expired') : `${t('sch.expires')} ${stamp(d.expiresAt, locale)}`}</span>{d.note && <><br /><span className="small">{d.note}</span></>}</span>
            {d.expired ? <Badge tone="neutral">{t('sch.expired')}</Badge> : <Link to={`/reports/center?d=${d.id}`} className="button">{d.opened ? t('sch.openAgain') : t('sch.open')}</Link>}</li>))}</ul>)}
      {manage && <>
        <div className="row between"><h3>{t('sch.schedules')}</h3><button className="primary small" onClick={() => setCreating('')}>{t('sch.new')}</button></div>
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        {!list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty text={t('sch.empty')} /> : (
          <ul className="plain rows">{list.data.items.map((s) => (
            <li key={s.id} className="card inner stack">
              <div className="row between"><span><strong>{s.name}</strong> <span className="muted small">{s.reportName}</span></span>{s.active ? <Badge tone="clean">{t('sch.active')}</Badge> : <Badge tone="warn">{t('sch.paused')}</Badge>}</div>
              <p className="small">{t(`sch.freq.${s.frequency}` as Key)}{s.frequency === 'WEEKLY' && s.weekday !== null ? ` · ${t(`sch.day.${s.weekday}` as Key)}` : ''}{s.frequency === 'MONTHLY' ? ` · ${s.monthDay === 0 ? t('sch.lastDay') : s.monthDay}` : ''} · {t(`sch.period.${s.period}` as Key)}{s.alert ? ` · ${t('sch.alertOnly')}: ${s.alert.kpi} ${t(`sch.op.${s.alert.op}` as Key)} ${s.alert.value}` : ''}</p>
              <p className="muted small">{t('sch.to')}: {s.recipients.map((r) => r.name).join(', ')}{s.lastRunOn ? ` · ${t('sch.last')}: ${s.lastRunOn} ${s.lastStatus ?? ''}` : ''}</p>
              {s.pausedReason && <p className="warnbox small">{s.pausedReason}</p>}
              <div className="actions">
                <button disabled={busy} onClick={async () => { if (await run(() => api('POST', `${base}/schedules/${s.id}/run`, {}))) { list.reload(); mine.reload(); } }}>{t('sch.runNow')}</button>
                <button disabled={busy} onClick={async () => { if (await run(() => api('PATCH', `${base}/schedules/${s.id}`, { active: !s.active }))) list.reload(); }}>{s.active ? t('sch.pause') : t('sch.resume')}</button>
                <button className="link" disabled={busy} onClick={async () => { if (window.confirm(t('sch.confirmDelete'))) { if (await run(() => api('DELETE', `${base}/schedules/${s.id}`))) list.reload(); } }}>{t('sch.delete')}</button>
              </div>
            </li>))}</ul>)}
        <h3>{t('sch.log')}</h3>
        {list.data && list.data.recent.length === 0 ? <Empty text={t('sch.logEmpty')} /> : (
          <div className="ins-tablewrap" tabIndex={0} role="region" aria-label={t('sch.log')}><table className="ins-table"><thead><tr><th scope="col">{t('sch.generated')}</th><th scope="col">{t('sch.schedules')}</th><th scope="col">{t('ins.dateBasis')}</th><th scope="col">{t('sch.result')}</th><th scope="col">{t('sch.recipients')}</th></tr></thead>
            <tbody>{list.data?.recent.map((d) => <tr key={d.id}><td>{stamp(d.generatedAt, locale)}</td><td>{d.schedule}<br /><span className="muted small">{d.report}</span></td><td>{d.forDate}</td><td><span className="st st-neutral">{t(`sch.status.${d.status}` as Key)}</span>{d.note && <><br /><span className="small">{d.note}</span></>}</td>
              <td>{d.status === 'READY' ? `${d.recipients} · ${t('sch.openedBy', { n: d.opened })}${d.mailFailed ? ` · ${t('sch.mailFailed', { n: d.mailFailed })}` : ''}${d.expired ? ` · ${t('sch.expired')}` : ''}` : ''}</td></tr>)}</tbody></table></div>)}
      </>}
      {creating !== null && <CreateSheet base={base} start={creating} onDone={() => { setCreating(null); list.reload(); }} onClose={() => setCreating(null)} />}
    </section>
  );
}

function CreateSheet({ base, start, onDone, onClose }: { base: string; start: string; onDone: () => void; onClose: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction();
  const cat = useLive<{ items: CatalogItem[] }>(base, 600_000);
  const [report, setReport] = useState(start); const [name, setName] = useState(''); const [period, setPeriod] = useState<(typeof PERIODS)[number]>('CLOSED_DAY'); const [freq, setFreq] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY'>('DAILY'); const [weekday, setWeekday] = useState(1); const [monthDay, setMonthDay] = useState(0);
  const [basis, setBasis] = useState(''); const [pv, setPv] = useState<Record<string, string>>({}); const [alertOn, setAlertOn] = useState(false); const [kpi, setKpi] = useState(''); const [op, setOp] = useState<(typeof OPS)[number]>('gt'); const [val, setVal] = useState('0'); const [picked, setPicked] = useState<string[]>([]);
  const people = useLive<{ items: Array<{ id: string; name: string; email: string; canOpen: boolean }> }>(report ? `${base}/schedule-people?report=${encodeURIComponent(report)}` : null, 0);
  const item = cat.data?.items.find((x) => x.id === report);
  useEffect(() => { if (item && !name) setName(item.name); setBasis(''); setPv({}); setPicked([]); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [report]);
  const ok = !!report && name.trim().length >= 2 && picked.length > 0 && (!alertOn || (kpi.trim() && val.trim() !== '' && !Number.isNaN(Number(val))));
  return (
    <Sheet title={t('sch.new')} onClose={onClose} wide>
      <label>{t('sch.report')}<select value={report} onChange={(e) => setReport(e.target.value)}><option value="">—</option>{cat.data?.items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label>{t('sch.name')}<input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></label>
      {item && item.basis.length > 1 && <label>{t('ins.dateBasis')}<select value={basis} onChange={(e) => setBasis(e.target.value)}>{item.basis.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</select></label>}
      {item?.params.map((p) => <label key={p.key}>{p.label}<select value={pv[p.key] ?? p.default} onChange={(e) => setPv({ ...pv, [p.key]: e.target.value })}>{p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>)}
      <div className="grid2">
        <label>{t('sch.when')}<select value={freq} onChange={(e) => setFreq(e.target.value as typeof freq)}>{(['DAILY', 'WEEKLY', 'MONTHLY'] as const).map((f) => <option key={f} value={f}>{t(`sch.freq.${f}` as Key)}</option>)}</select></label>
        {freq === 'WEEKLY' && <label>{t('sch.weekday')}<select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>{DAYS.map((d) => <option key={d} value={d}>{t(`sch.day.${d}` as Key)}</option>)}</select></label>}
        {freq === 'MONTHLY' && <label>{t('sch.monthDay')}<select value={monthDay} onChange={(e) => setMonthDay(Number(e.target.value))}><option value={0}>{t('sch.lastDay')}</option>{Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}</select></label>}
      </div>
      <label>{t('sch.covers')}<select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)}>{PERIODS.map((p) => <option key={p} value={p}>{t(`sch.period.${p}` as Key)}</option>)}</select></label>
      <p className="muted small">{t('sch.afterClose')}</p>
      <label className="check"><input type="checkbox" checked={alertOn} onChange={(e) => setAlertOn(e.target.checked)} /> {t('sch.alertCheck')}</label>
      {alertOn && <div className="grid2"><label>{t('sch.alertKpi')}<input value={kpi} onChange={(e) => setKpi(e.target.value)} dir="ltr" placeholder="od" list="kpi-keys" /></label><div className="grid2"><label>{t('sch.alertOp')}<select value={op} onChange={(e) => setOp(e.target.value as typeof op)}>{OPS.map((o) => <option key={o} value={o}>{t(`sch.op.${o}` as Key)}</option>)}</select></label><label>{t('sch.alertValue')}<input value={val} onChange={(e) => setVal(e.target.value)} inputMode="decimal" dir="ltr" /></label></div></div>}
      {alertOn && <p className="muted small">{t('sch.alertHelp')}</p>}
      <fieldset className="guestcard"><legend>{t('sch.recipientsLegend')}</legend>
        {!report ? <p className="muted small">{t('sch.pickReport')}</p> : !people.data ? <Spinner /> : people.data.items.map((p) => <label key={p.id} className="check"><input type="checkbox" disabled={!p.canOpen} checked={picked.includes(p.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} /> {p.name} <span className="muted small">{p.email}{p.canOpen ? '' : ` — ${t('sch.noAccess')}`}</span></label>)}
      </fieldset>
      <p className="muted small">{t('sch.linkNote')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || !ok} onClick={async () => {
        const params = Object.fromEntries(Object.entries(pv).filter(([, v]) => v));
        const r = await run(() => api('POST', `${base}/schedules`, { reportId: report, name: name.trim(), ...(basis ? { basis } : {}), params, period, frequency: freq, ...(freq === 'WEEKLY' ? { weekday } : {}), ...(freq === 'MONTHLY' ? { monthDay } : {}), ...(alertOn ? { alert: { kpi: kpi.trim(), op, value: Number(val) } } : {}), recipientIds: picked }));
        if (r) onDone(); }}>{t('sch.create')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}
