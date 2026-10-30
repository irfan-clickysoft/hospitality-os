import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { useAuth } from '../state.js';
import { Field } from '../ui/ds.js';
import { ErrorLine } from '../ui/kit.js';

const PURPOSES = ['Leisure', 'Business', 'Family visit', 'Medical', 'Event / wedding', 'Transit', 'Other'] as const;
const PURPOSE_KEY: Record<(typeof PURPOSES)[number], Key> = { Leisure: 'rc.p.leisure', Business: 'rc.p.business', 'Family visit': 'rc.p.family', Medical: 'rc.p.medical', 'Event / wedding': 'rc.p.event', Transit: 'rc.p.transit', Other: 'rc.p.other' };
const RELATIONS = ['Spouse', 'Child', 'Parent', 'Sibling', 'Relative', 'Friend', 'Colleague'] as const;
const REL_KEY: Record<(typeof RELATIONS)[number], Key> = { Spouse: 'rc.r.spouse', Child: 'rc.r.child', Parent: 'rc.r.parent', Sibling: 'rc.r.sibling', Relative: 'rc.r.relative', Friend: 'rc.r.friend', Colleague: 'rc.r.colleague' };

/** Why the guest is visiting: a short list, and "Other" lets the desk type it. The value is the English wording, which is what the card prints. */
export function PurposeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useT();
  const known = (PURPOSES as readonly string[]).includes(value);
  const [other, setOther] = useState(value !== '' && !known);
  const sel = other ? 'Other' : value;
  return (
    <div className="grid2">
      <Field label={t('rc.purpose')}>{(p) => <select {...p} value={sel} onChange={(e) => { if (e.target.value === 'Other') { setOther(true); onChange(''); } else { setOther(false); onChange(e.target.value); } }}>
        <option value="">—</option>{PURPOSES.map((x) => <option key={x} value={x}>{t(PURPOSE_KEY[x])}</option>)}</select>}</Field>
      {other && <Field label={t('rc.purposeOther')}>{(p) => <input {...p} value={value} maxLength={80} onChange={(e) => onChange(e.target.value)} />}</Field>}
    </div>
  );
}

/** How a companion is related to the main guest. A free text with suggestions, so "Mother-in-law" works too. */
export function RelationshipField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const { t } = useT();
  return (
    <Field label={t('rc.relationship')}>{(p) => <>
      <input {...p} list={`rel-${id}`} value={value} maxLength={40} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
      <datalist id={`rel-${id}`}>{RELATIONS.map((x) => <option key={x} value={t(REL_KEY[x])} />)}</datalist></>}</Field>
  );
}

/** A box to sign in with a finger, stylus or mouse. Reports a PNG picture of it, or null while it is empty. */
function Pad({ onChange }: { onChange: (png: string | null) => void }) {
  const { t } = useT();
  const cv = useRef<HTMLCanvasElement>(null); const drawing = useRef(false); const inked = useRef(false);
  const at = (e: React.PointerEvent) => { const c = cv.current!, r = c.getBoundingClientRect(); return [((e.clientX - r.left) * c.width) / r.width, ((e.clientY - r.top) * c.height) / r.height] as const; };
  useEffect(() => { const c = cv.current!, g = c.getContext('2d')!; g.lineWidth = 3; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#111'; }, []);
  const down = (e: React.PointerEvent) => { const c = cv.current!; c.setPointerCapture(e.pointerId); drawing.current = true; const [x, y] = at(e); const g = c.getContext('2d')!; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 0.1, y + 0.1); g.stroke(); inked.current = true; };
  const move = (e: React.PointerEvent) => { if (!drawing.current) return; const g = cv.current!.getContext('2d')!; const [x, y] = at(e); g.lineTo(x, y); g.stroke(); };
  const up = () => { if (!drawing.current) return; drawing.current = false; onChange(inked.current ? cv.current!.toDataURL('image/png') : null); };
  const clear = () => { const c = cv.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); inked.current = false; onChange(null); };
  return (
    <div className="stack">
      <canvas ref={cv} width={640} height={220} className="sigpad" role="img" aria-label={t('rc.pad')} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="row between"><span className="muted small">{t('rc.pad')}</span><button type="button" className="link" onClick={clear}>{t('rc.clear')}</button></div>
    </div>
  );
}

/** Takes the guest's signature on the screen, after they have read the rules, and keeps it with the registration card. */
export function RegSign({ reservationId, lineId, guestName, onDone }: { reservationId: string; lineId: string; guestName: string; onDone?: () => void }) {
  const { t } = useT(); const { property } = useAuth(); const { busy, problem, run } = useAction();
  const [open, setOpen] = useState(false); const [rules, setRules] = useState(''); const [name, setName] = useState(guestName); const [ok, setOk] = useState(false); const [png, setPng] = useState<string | null>(null); const [saved, setSaved] = useState(false);
  const base = `/v1/properties/${property!.id}/reservations/${reservationId}/rooms/${lineId}`;
  useEffect(() => { if (open && !rules) api<{ rules: string }>('GET', `/v1/properties/${property!.id}/registration-rules`).then((r) => setRules(r.rules)).catch(() => setRules('')); }, [open, rules, property]);
  if (!open) return <button type="button" onClick={() => { setOpen(true); setSaved(false); }}>{t('rc.sign')}</button>;
  return (
    <div className="card inner stack regsign" role="group" aria-label={t('rc.signTitle')}>
      <h4>{t('rc.rules')}</h4>
      <div className="rulesbox" tabIndex={0}>{rules}</div>
      <label className="check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> {t('rc.accept')}</label>
      <Field label={t('rc.signName')}>{(p) => <input {...p} value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />}</Field>
      <Pad onChange={setPng} />
      <div className="actions">
        <button className="primary" disabled={busy || !ok || name.trim().length < 2 || !png} onClick={async () => { if (await run(() => api('POST', `${base}/registration-sign`, { name: name.trim(), accepted: true, signature: png }))) { setSaved(true); setOpen(false); onDone?.(); } }}>{t('rc.save')}</button>
        <button type="button" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
        <a className="button" href={`${base}/registration-card`} target="_blank" rel="noreferrer">{t('rc.openCard')}</a>
      </div>
      {saved && <p className="ok small" role="status">✓ {t('rc.saved')}</p>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </div>
  );
}
