import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { resetDisplay, setDisplay, useDisplay, type Display } from '../lib/display.js';
import { Icon, type IconName } from '../ui/icons.js';
import { Sheet } from '../ui/kit.js';

/** A group of choices where exactly one is on. A real radio group, so screen readers announce it and the arrow keys move between the choices. */
function Choice<T extends string>({ name, label, value, options, onPick }: { name: string; label: string; value: T; options: Array<{ v: T; text: string; icon?: IconName }>; onPick: (v: T) => void }) {
  return (
    <fieldset className="choice"><legend>{label}</legend>
      <div className="choice-row">{options.map((o) => (
        <label key={o.v} className={`choice-opt${value === o.v ? ' on' : ''}`}>
          <input type="radio" name={name} value={o.v} checked={value === o.v} onChange={() => onPick(o.v)} />
          {o.icon && <Icon name={o.icon} size={18} />}<span>{o.text}</span>
        </label>))}</div>
    </fieldset>
  );
}

/** Day or night, bigger text, stronger contrast and calmer motion. Applies at once, is remembered on this device, and "automatic" follows the device's own setting. */
export function DisplaySettings({ onClose }: { onClose: () => void }) {
  const { t } = useT(); const d = useDisplay();
  const set = (p: Partial<Display>) => setDisplay(p);
  return (
    <Sheet title={t('dsp.title')} onClose={onClose}>
      <div className="stack">
        <Choice name="theme" label={t('dsp.theme')} value={d.theme} onPick={(v) => set({ theme: v })}
          options={[{ v: 'auto', text: t('dsp.auto'), icon: 'access' }, { v: 'light', text: t('dsp.day'), icon: 'sun' }, { v: 'dark', text: t('dsp.night'), icon: 'moon' }]} />
        <Choice name="text" label={t('dsp.text')} value={d.text} onPick={(v) => set({ text: v })}
          options={[{ v: 'normal', text: t('dsp.t.normal') }, { v: 'large', text: t('dsp.t.large') }, { v: 'xlarge', text: t('dsp.t.xlarge') }]} />
        <label className="check"><input type="checkbox" checked={d.contrast === 'high'} onChange={(e) => set({ contrast: e.target.checked ? 'high' : 'normal' })} /> <span><strong>{t('dsp.contrast')}</strong><br /><span className="muted small">{t('dsp.contrastHint')}</span></span></label>
        <label className="check"><input type="checkbox" checked={d.motion === 'reduce'} onChange={(e) => set({ motion: e.target.checked ? 'reduce' : 'auto' })} /> <span><strong>{t('dsp.motion')}</strong><br /><span className="muted small">{t('dsp.motionHint')}</span></span></label>
        <div className="card inner stack" aria-hidden="true"><strong>{t('dsp.sample')}</strong><span className="muted">{t('dsp.sampleText')}</span><div className="row"><span className="st st-ok">{t('dsp.ok')}</span><span className="st st-warn">{t('dsp.warn')}</span><span className="st st-danger">{t('dsp.bad')}</span></div></div>
        <p className="muted small">{t('dsp.note')}</p>
        <div className="actions"><button className="primary" onClick={onClose}>{t('common.close')}</button><button onClick={resetDisplay}>{t('dsp.reset')}</button></div>
      </div>
    </Sheet>
  );
}

/** One tap between day and night, from the top bar (the sun or the moon shows what you would switch to). */
export function ThemeToggle() {
  const { t } = useT(); const d = useDisplay();
  const toNight = d.effective === 'light';
  return (
    <button className="iconbtn" onClick={() => setDisplay({ theme: toNight ? 'dark' : 'light' })} aria-label={toNight ? t('dsp.toNight') : t('dsp.toDay')} title={toNight ? t('dsp.toNight') : t('dsp.toDay')}><Icon name={toNight ? 'moon' : 'sun'} /></button>
  );
}
export type { Key };
