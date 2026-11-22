import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAction } from '../lib/action.js';
import { useAuth } from '../state.js';
import { ErrorLine, Spinner } from '../ui/kit.js';

const DEPTS = ['FRONT_DESK', 'HOUSEKEEPING', 'MAINTENANCE', 'FNB', 'SECURITY', 'MANAGEMENT'] as const;
const LABEL: Record<string, string> = { FRONT_DESK: 'Front desk', HOUSEKEEPING: 'Housekeeping', MAINTENANCE: 'Maintenance', FNB: 'Food and beverage', SECURITY: 'Security', MANAGEMENT: 'Management' };
interface Shift { id: string; userId: string; name: string; date: string; department: string; start: string; end: string; note: string | null }
interface Rule { department: string; roomsPerStaff: number | null; minStaff: number | null }
interface Week { shifts: Shift[]; staff: Array<{ id: string; name: string }>; rules: Rule[] }
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const monday = (s: string) => { const d = new Date(`${s}T00:00:00Z`); return addDays(s, -((d.getUTCDay() + 6) % 7)); };
const digits = (v: string) => v.replace(/\D/g, '');

/** The weekly roster: who works which shift, and how many rooms one person covers in each department (used by the staffing forecast). */
export function Roster() {
  const { t, locale } = useT(); const { property, can } = useAuth(); const { busy, problem, run } = useAction();
  const pid = property!.id; const editable = can('rate.manage');
  const [start, setStart] = useState(monday(property!.businessDate)); const [data, setData] = useState<Week | null>(null); const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ userId: string; date: string } | null>(null); const [form, setForm] = useState({ department: 'HOUSEKEEPING', start: '08:00', end: '16:00' });
  const [rules, setRules] = useState<Rule[]>([]); const [savedRule, setSavedRule] = useState<string | null>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const load = () => api<Week>('GET', `/v1/properties/${pid}/roster?from=${start}&to=${addDays(start, 6)}`).then((r) => { setData(r); setRules(r.rules); }).catch((e) => setErr(String(e?.message ?? e)));
  useEffect(() => { setData(null); setErr(null); void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pid, start]);
  const dayName = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(locale === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const add = async () => { if (adding && await run(() => api('POST', `/v1/properties/${pid}/roster/shifts`, { userId: adding.userId, date: adding.date, department: form.department, start: form.start, end: form.end }))) { setAdding(null); void load(); } };
  const remove = async (id: string) => { if (await run(() => api('DELETE', `/v1/properties/${pid}/roster/shifts/${id}`))) void load(); };
  const saveRule = async (r: Rule) => { if (await run(() => api('PUT', `/v1/properties/${pid}/roster/rules/${r.department}`, { roomsPerStaff: r.roomsPerStaff ?? 1, minStaff: r.minStaff ?? 0 }))) { setSavedRule(r.department); void load(); } };
  if (err) return <p className="warnbox" role="alert">{err}</p>;
  if (!data) return <Spinner />;
  const people = data.staff;
  return (
    <section className="stack">
      <h2>{t('ro.title')}</h2><p className="muted">{t('ro.help')}</p>
      <div className="row"><button type="button" onClick={() => setStart(addDays(start, -7))} aria-label={t('ro.prev')}>‹</button><strong dir="ltr">{dayName(start)} – {dayName(addDays(start, 6))}</strong><button type="button" onClick={() => setStart(addDays(start, 7))} aria-label={t('ro.next')}>›</button></div>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('ro.person')}</th>{days.map((d) => <th key={d} scope="col">{dayName(d)}</th>)}</tr></thead>
        <tbody>{people.map((p) => (
          <tr key={p.id}><th scope="row">{p.name}</th>
            {days.map((d) => { const mine = data.shifts.filter((s) => s.userId === p.id && s.date === d); const open = adding?.userId === p.id && adding.date === d; return (
              <td key={d}>
                {mine.map((s) => <div key={s.id} className="small"><span dir="ltr">{s.start}–{s.end}</span> · {LABEL[s.department] ?? s.department}{editable && <button type="button" className="link" disabled={busy} aria-label={`${t('ro.remove')} ${p.name} ${dayName(d)}`} onClick={() => void remove(s.id)}> ✕</button>}</div>)}
                {editable && !open && <button type="button" className="link" aria-label={`${t('ro.add')} ${p.name} ${dayName(d)}`} onClick={() => setAdding({ userId: p.id, date: d })}>＋</button>}
                {open && (
                  <div className="stack">
                    <select aria-label={t('ro.dept')} value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}>{DEPTS.map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}</select>
                    <input aria-label={t('ro.from')} type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} dir="ltr" />
                    <input aria-label={t('ro.to')} type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} dir="ltr" />
                    <div className="row"><button type="button" disabled={busy} onClick={() => void add()}>{t('common.save')}</button><button type="button" onClick={() => setAdding(null)}>{t('common.cancel')}</button></div>
                  </div>)}
              </td>); })}</tr>))}</tbody></table></div>
      {!editable && <p className="muted small">{t('ro.readOnly')}</p>}
      <h3>{t('ro.rules')}</h3><p className="muted">{t('ro.rulesHelp')}</p>
      <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('ro.dept')}</th><th scope="col">{t('ro.perStaff')}</th><th scope="col">{t('ro.min')}</th><th scope="col"><span className="sr-only">{t('common.save')}</span></th></tr></thead>
        <tbody>{rules.map((r) => (
          <tr key={r.department}><th scope="row">{LABEL[r.department]}</th>
            <td><input aria-label={`${LABEL[r.department]}: ${t('ro.perStaff')}`} inputMode="numeric" value={r.roomsPerStaff ?? ''} disabled={!editable} dir="ltr" onChange={(e) => { setSavedRule(null); setRules(rules.map((x) => (x.department === r.department ? { ...x, roomsPerStaff: digits(e.target.value) === '' ? null : Number(digits(e.target.value)) } : x))); }} /></td>
            <td><input aria-label={`${LABEL[r.department]}: ${t('ro.min')}`} inputMode="numeric" value={r.minStaff ?? ''} disabled={!editable} dir="ltr" onChange={(e) => { setSavedRule(null); setRules(rules.map((x) => (x.department === r.department ? { ...x, minStaff: digits(e.target.value) === '' ? null : Number(digits(e.target.value)) } : x))); }} /></td>
            <td>{editable && <button type="button" disabled={busy || !r.roomsPerStaff} onClick={() => void saveRule(r)}>{savedRule === r.department ? `✓ ${t('bg.saved')}` : t('common.save')}</button>}</td></tr>))}</tbody></table></div>
    </section>
  );
}
