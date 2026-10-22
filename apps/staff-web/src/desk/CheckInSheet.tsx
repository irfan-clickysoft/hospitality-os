import { useState } from 'react';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { checkOccupant, formatId, type Occupant } from '../lib/occupants.js';
import { Field } from '../ui/ds.js';

export type { Occupant };
const ID_TYPES = ['CNIC', 'NICOP', 'PASSPORT', 'DRIVING_LICENSE', 'OTHER'] as const;
export const blankOccupant = (name = '', foreign = false): Occupant => ({ fullName: name, idType: foreign ? 'PASSPORT' : 'CNIC', idNumber: '', nationality: foreign ? '' : 'PK', idExpiry: '', ageGroup: 'ADULT' });
/** What is sent for one guest. An ID is sent only when one was entered: children and family members covered by the main guest's ID have none. */
export const occupantBody = (o: Occupant, primary: boolean) => ({ fullName: o.fullName.trim(), isPrimary: primary, ageGroup: o.ageGroup, ...(o.idNumber.trim() ? { idType: o.idType, idNumber: o.idNumber.trim() } : {}), ...(o.nationality.trim() ? { nationality: o.nationality.trim().toUpperCase() } : {}), ...(o.idExpiry && o.idNumber.trim() ? { idExpiry: o.idExpiry } : {}) });

/** The registration card: who is staying. Each field is checked as the person leaves it, and the problem is shown next to it. */
export function OccupantsForm({ occupants, onChange, foreign, businessDate, attempted }: { occupants: Occupant[]; onChange: (o: Occupant[]) => void; foreign: boolean; businessDate: string; attempted: boolean }) {
  const { t } = useT();
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const set = (i: number, patch: Partial<Occupant>) => onChange(occupants.map((o, k) => (k === i ? { ...o, ...patch } : o)));
  const blur = (i: number, k: string) => setTouched((x) => ({ ...x, [`${i}.${k}`]: true }));
  return (
    <div className="stack">
      {occupants.map((o, i) => {
        const e = checkOccupant(o, i, foreign, businessDate);
        const show = (k: keyof typeof e) => ((attempted || touched[`${i}.${k}`]) && e[k] ? t(e[k]!) : undefined);
        const child = o.ageGroup === 'CHILD';
        return (
          <fieldset key={i} className="guestcard"><legend>{i === 0 ? t('ci.primary') : t('ci.companion', { n: i })}</legend>
            <Field label={t('ci.name')} required error={show('fullName')}>{(p) => <input {...p} value={o.fullName} onChange={(x) => set(i, { fullName: x.target.value })} onBlur={() => blur(i, 'fullName')} autoComplete="off" />}</Field>
            {i > 0 && <label className="check"><input type="checkbox" checked={child} onChange={(x) => set(i, { ageGroup: x.target.checked ? 'CHILD' : 'ADULT' })} /> {t('ci.child')}</label>}
            <div className="grid2">
              <Field label={t('ci.idType')} error={show('idType')}>{(p) => <select {...p} value={o.idType} onChange={(x) => set(i, { idType: x.target.value })} onBlur={() => blur(i, 'idType')}>{ID_TYPES.map((x) => <option key={x} value={x}>{t(`ci.id.${x}` as Key)}</option>)}</select>}</Field>
              <Field label={t('ci.idNumber')} required={i === 0} hint={i === 0 ? (o.idType === 'CNIC' ? t('ci.cnicHint') : undefined) : child ? t('ci.h.childNoId') : t('ci.h.sharedId')} error={show('idNumber')}>
                {(p) => <input {...p} value={o.idNumber} dir="ltr" inputMode={o.idType === 'CNIC' || o.idType === 'NICOP' ? 'numeric' : 'text'} placeholder={o.idType === 'CNIC' ? '35202-1234567-1' : ''}
                  onChange={(x) => set(i, { idNumber: x.target.value })} onBlur={() => { set(i, { idNumber: formatId(o.idType, o.idNumber) }); blur(i, 'idNumber'); }} />}
              </Field>
            </div>
            <div className="grid2">
              <Field label={t('ci.nationality')} required={i === 0} error={show('nationality')}>{(p) => <input {...p} value={o.nationality} maxLength={2} onChange={(x) => set(i, { nationality: x.target.value.toUpperCase() })} onBlur={() => blur(i, 'nationality')} dir="ltr" placeholder="PK" />}</Field>
              {o.idType === 'PASSPORT' && o.idNumber.trim() !== '' && <Field label={t('ci.expiry')} error={show('idExpiry')}>{(p) => <input {...p} type="date" value={o.idExpiry} onChange={(x) => set(i, { idExpiry: x.target.value })} onBlur={() => blur(i, 'idExpiry')} dir="ltr" />}</Field>}
            </div>
            {i > 0 && <button type="button" className="link" onClick={() => onChange(occupants.filter((_, k) => k !== i))}>{t('ci.remove')}</button>}
          </fieldset>
        );
      })}
      <button type="button" onClick={() => onChange([...occupants, blankOccupant('', foreign)])}>{t('ci.addGuest')}</button>
      {foreign && <p className="muted small">{t('ci.foreignNote')}</p>}
    </div>
  );
}
