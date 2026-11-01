import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAction } from '../lib/action.js';
import { ErrorLine } from '../ui/kit.js';

interface Tier { upToMinutes: number; percent: number }
interface Rule { early: Tier[]; late: Tier[] }
interface Prop { id: string; version?: number; checkInTime?: string; checkOutTime?: string; timingFeeRule?: Rule | null }
const EARLY: Tier[] = [{ upToMinutes: 120, percent: 0 }, { upToMinutes: 360, percent: 50 }];
const LATE: Tier[] = [{ upToMinutes: 120, percent: 0 }, { upToMinutes: 360, percent: 50 }];

function Tiers({ label, std, tiers, onChange }: { label: string; std: string; tiers: Tier[]; onChange: (t: Tier[]) => void }) {
  const { t } = useT();
  const set = (i: number, p: Partial<Tier>) => onChange(tiers.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const last = tiers[tiers.length - 1];
  return (
    <div className="stack"><strong>{label}</strong><p className="muted small">{t('tfr.standard', { time: std })}</p>
      {tiers.map((x, i) => (
        <div key={i} className="grid2">
          <label>{t('tfr.upTo')}<input inputMode="numeric" value={x.upToMinutes} onChange={(e) => set(i, { upToMinutes: Math.min(1440, Number(e.target.value.replace(/\D/g, ''))) })} dir="ltr" /></label>
          <label>{t('ss.percent')}<span className="row"><input inputMode="numeric" value={x.percent} onChange={(e) => set(i, { percent: Math.min(100, Number(e.target.value.replace(/\D/g, ''))) })} dir="ltr" /><button type="button" className="link" onClick={() => onChange(tiers.filter((_, k) => k !== i))}>{t('ci.remove')}</button></span></label>
        </div>))}
      {tiers.length < 6 && <button type="button" onClick={() => onChange([...tiers, { upToMinutes: Math.min(1440, (last?.upToMinutes ?? 0) + 60), percent: Math.min(100, (last?.percent ?? 0) + 25) }])}>{t('ss.addStep')}</button>}
      {tiers.length > 0 && <p className="muted small">{t('tfr.beyond', { m: last?.upToMinutes ?? 0 })}</p>}
    </div>
  );
}

/** What a guest pays for arriving before the standard check-in time or leaving after the standard checkout time. Off: nothing is suggested and the desk is never asked. */
export function TimingFeeRule({ prop, onSaved }: { prop: Prop; onSaved: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction();
  const [on, setOn] = useState(!!prop.timingFeeRule && (prop.timingFeeRule.early.length > 0 || prop.timingFeeRule.late.length > 0));
  const [early, setEarly] = useState<Tier[]>(prop.timingFeeRule?.early.length ? prop.timingFeeRule.early : EARLY); const [late, setLate] = useState<Tier[]>(prop.timingFeeRule?.late.length ? prop.timingFeeRule.late : LATE); const [saved, setSaved] = useState(false);
  const save = async () => { if (await run(() => api('PATCH', `/v1/properties/${prop.id}`, { timingFeeRule: on ? { early, late } : null, version: prop.version }))) { setSaved(true); onSaved(); } };
  return (
    <fieldset className="guestcard stack"><legend>{t('tfr.title')}</legend>
      <p className="hint">{t('tfr.help')}</p>
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => { setSaved(false); setOn(e.target.checked); }} /> {t('tfr.on')}</label>
      {on && <><Tiers label={t('tfr.early')} std={(prop.checkInTime ?? '14:00').slice(0, 5)} tiers={early} onChange={(x) => { setSaved(false); setEarly(x); }} /><Tiers label={t('tfr.late')} std={(prop.checkOutTime ?? '12:00').slice(0, 5)} tiers={late} onChange={(x) => { setSaved(false); setLate(x); }} /></>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button disabled={busy} onClick={save}>{t('common.save')}</button>{saved && <span className="ok small" role="status">✓ {t('ps.saved')}</span>}</div>
    </fieldset>
  );
}
