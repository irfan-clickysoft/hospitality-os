import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { FOREIGN_FIELDS, gapsFor, typeOf, type Matrix, type Occupant } from '../lib/occupants.js';
import { StatusBadge } from '../ui/ds.js';

const TYPES = ['PAKISTANI_ADULT', 'OVERSEAS_PAKISTANI', 'POC_HOLDER', 'FOREIGN_ADULT', 'PAKISTANI_MINOR', 'FOREIGN_MINOR'] as const;
const DATE_FIELDS = new Set(['stayExpiry', 'entryDate']);

/**
 * Under each person on the card: what kind of guest they are, which documents the hotel's matrix asks for, whether each was seen (or why not), who the guardian of a child is, and the
 * foreign-guest record. Missing items are listed but never block by themselves — the property decides, in its settings, whether an incomplete card stops check-in.
 */
export function OccupantDocs({ index, all, matrix, corporate = false, onChange }: { index: number; all: Occupant[]; matrix: Matrix | null; corporate?: boolean; onChange: (patch: Partial<Occupant>) => void }) {
  const { t } = useT();
  if (!matrix) return null;
  const o = all[index]!;
  const type = typeOf(o);
  const spec = matrix.types.find((x) => x.type === type);
  const gaps = gapsFor(o, index, all, matrix, corporate);
  const reqs = (corporate ? spec?.requirementsCorporate : spec?.requirements) ?? [];
  const setDoc = (key: string, state: 'SEEN' | 'NOT_AVAILABLE' | null, note?: string) => {
    const docs = { ...o.docs };
    if (state === null) delete docs[key]; else docs[key] = { state, ...(note !== undefined ? { note } : {}) };
    onChange({ docs });
  };
  const guardians = all.map((g, k) => ({ g, k })).filter(({ g, k }) => k !== index && g.ageGroup === 'ADULT');
  return (
    <details className="guestcard docs" open={gaps.length > 0 && index === 0 ? undefined : undefined}>
      <summary><strong>{t('rg.title')}</strong> · {t(`rg.type.${type}` as Key)} · {gaps.length === 0 ? <StatusBadge tone="ok" icon="check">{t('rg.complete')}</StatusBadge> : <StatusBadge tone="warn" icon="alert">{t('rg.missingN', { n: gaps.length })}</StatusBadge>}</summary>
      <div className="stack">
        <label>{t('rg.kind')}<select value={o.guestType || type} onChange={(e) => onChange({ guestType: e.target.value })}>{TYPES.map((x) => <option key={x} value={x}>{t(`rg.type.${x}` as Key)}</option>)}</select></label>
        <ul className="plain">{reqs.map((r) => {
          if (r.key === 'GUARDIAN_ID') {
            return (
              <li key={r.key} className="stack"><label>{t('rg.doc.GUARDIAN_ID')}<select value={o.guardian === null ? '' : String(o.guardian)} onChange={(e) => onChange({ guardian: e.target.value === '' ? null : Number(e.target.value) })}>
                <option value="">—</option>{guardians.map(({ g, k }) => <option key={k} value={k}>{g.fullName.trim() || `${t('ci.companion', { n: k })}`}{g.idNumber.trim() ? '' : ` (${t('rg.noIdYet')})`}</option>)}</select></label></li>
            );
          }
          const d = o.docs[r.key];
          return (
            <li key={r.key} className="stack">
              <div className="row between">
                <span><strong>{t(`rg.doc.${r.key}` as Key)}</strong>{!r.required && <span className="muted small"> · {r.supplementary ? t('rg.supplementary') : t('rg.optional')}</span>}</span>
                <span className="row" role="group" aria-label={t(`rg.doc.${r.key}` as Key)}>
                  <button type="button" className={`chip${d?.state === 'SEEN' ? ' on' : ''}`} aria-pressed={d?.state === 'SEEN'} onClick={() => setDoc(r.key, d?.state === 'SEEN' ? null : 'SEEN')}>{t('rg.seen')}</button>
                  <button type="button" className={`chip${d?.state === 'NOT_AVAILABLE' ? ' on' : ''}`} aria-pressed={d?.state === 'NOT_AVAILABLE'} onClick={() => setDoc(r.key, d?.state === 'NOT_AVAILABLE' ? null : 'NOT_AVAILABLE', d?.note ?? '')}>{t('rg.notAvailable')}</button>
                </span>
              </div>
              {d?.state === 'NOT_AVAILABLE' && <label>{t('rg.reason')}<input value={d.note ?? ''} maxLength={200} onChange={(e) => setDoc(r.key, 'NOT_AVAILABLE', e.target.value)} placeholder={t('rg.reasonEx')} /></label>}
            </li>
          );
        })}</ul>
        {spec?.foreignDetails && (
          <fieldset className="guestcard"><legend>{t('rg.foreign')}</legend>
            <p className="muted small">{t('rg.foreignNote')}</p>
            <div className="grid2">{FOREIGN_FIELDS.map((k) => (
              <label key={k} className={k === 'localAddress' ? 'span2' : undefined}>{t(`rg.f.${k}` as Key)}<input type={DATE_FIELDS.has(k) ? 'date' : 'text'} dir={DATE_FIELDS.has(k) ? 'ltr' : undefined} value={String(o.foreign[k] ?? '')} onChange={(e) => onChange({ foreign: { ...o.foreign, [k]: e.target.value } })} /></label>))}
              <label>{t('rg.f.formCRef')}<input value={String(o.foreign.formCRef ?? '')} onChange={(e) => onChange({ foreign: { ...o.foreign, formCRef: e.target.value } })} /></label>
              <label>{t('rg.f.residentialPermitRef')}<input value={String(o.foreign.residentialPermitRef ?? '')} onChange={(e) => onChange({ foreign: { ...o.foreign, residentialPermitRef: e.target.value } })} /></label>
            </div>
            <label className="check"><input type="checkbox" checked={o.foreign.froInstruction === true} onChange={(e) => onChange({ foreign: { ...o.foreign, froInstruction: e.target.checked } })} /> {t('rg.f.froInstruction')}</label>
            <label>{t('rg.f.remarks')}<input value={String(o.foreign.remarks ?? '')} maxLength={500} onChange={(e) => onChange({ foreign: { ...o.foreign, remarks: e.target.value } })} /></label>
            {o.ageGroup === 'ADULT' && o.guestType !== '' && !o.idExpiry && <p className="muted small">{t('rg.f.passportExpiryNote')}</p>}
          </fieldset>
        )}
        {gaps.length > 0 && <p className="muted small">{t('rg.stillMissing')}: {gaps.map((g) => (g.kind === 'DOCUMENT' ? t(`rg.doc.${g.key}` as Key) : g.kind === 'GUARDIAN' ? t('rg.doc.GUARDIAN_ID') : g.kind === 'ID' ? t('rg.ownId') : g.key === 'passportExpiry' ? t('ci.expiry') : t(`rg.f.${g.key}` as Key))).join(' · ')}</p>}
      </div>
    </details>
  );
}
