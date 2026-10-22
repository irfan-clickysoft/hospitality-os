import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAction } from '../lib/action.js';
import { ErrorLine } from '../ui/kit.js';

interface Tier { upToHours: number; percent: number }
interface Prop { id: string; version?: number; shortStayRule?: { tiers: Tier[] } | null }
const DEFAULT: Tier[] = [{ upToHours: 3, percent: 30 }, { upToHours: 6, percent: 50 }, { upToHours: 12, percent: 75 }];

/** What a guest pays who checks in and leaves a few hours later. Off: the whole night, as always. On: a share of the night for each length of stay. */
export function ShortStayRule({ prop, onSaved }: { prop: Prop; onSaved: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction();
  const [on, setOn] = useState(!!prop.shortStayRule); const [tiers, setTiers] = useState<Tier[]>(prop.shortStayRule?.tiers ?? DEFAULT); const [saved, setSaved] = useState(false);
  const set = (i: number, p: Partial<Tier>) => { setSaved(false); setTiers(tiers.map((x, k) => (k === i ? { ...x, ...p } : x))); };
  const save = async () => { if (await run(() => api('PATCH', `/v1/properties/${prop.id}`, { shortStayRule: on ? { tiers } : null, version: prop.version }))) { setSaved(true); onSaved(); } };
  const last = tiers[tiers.length - 1];
  return (
    <fieldset className="guestcard stack"><legend>{t('ss.title')}</legend>
      <p className="hint">{t('ss.help')}</p>
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => { setSaved(false); setOn(e.target.checked); }} /> {t('ss.on')}</label>
      {on && (<>
        {tiers.map((x, i) => (
          <div key={i} className="grid2">
            <label>{t('ss.upTo')}<input inputMode="numeric" value={x.upToHours} onChange={(e) => set(i, { upToHours: Number(e.target.value.replace(/\D/g, '')) })} dir="ltr" /></label>
            <label>{t('ss.percent')}<span className="row"><input inputMode="numeric" value={x.percent} onChange={(e) => set(i, { percent: Math.min(100, Number(e.target.value.replace(/\D/g, ''))) })} dir="ltr" />{tiers.length > 1 && <button type="button" className="link" onClick={() => { setSaved(false); setTiers(tiers.filter((_, k) => k !== i)); }}>{t('ss.remove')}</button>}</span></label>
          </div>))}
        {tiers.length < 6 && <button type="button" onClick={() => { setSaved(false); setTiers([...tiers, { upToHours: Math.min(23, (last?.upToHours ?? 0) + 3), percent: Math.min(100, (last?.percent ?? 0) + 10) }]); }}>{t('ss.addStep')}</button>}
        <p className="muted small">{t('ss.beyond', { h: last?.upToHours ?? 0 })}</p>
      </>)}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button disabled={busy} onClick={save}>{t('common.save')}</button>{saved && <span className="ok small" role="status">✓ {t('ps.saved')}</span>}</div>
    </fieldset>
  );
}
