import { useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAction } from '../lib/action.js';
import { ErrorLine } from '../ui/kit.js';
import { Field } from '../ui/ds.js';

interface Prop { id: string; version?: number; address?: string | null; phone?: string | null; receiptFooter?: string | null; brandColor?: string | null; logoUrl?: string | null }

/** The look of the hotel's receipts and statements: logo, colour, address, phone, and a line for the foot of every page. */
export function Branding({ prop, onSaved }: { prop: Prop; onSaved: () => void }) {
  const { t } = useT(); const { busy, problem, run } = useAction(); const pick = useRef<HTMLInputElement>(null);
  const [f, setF] = useState({ address: prop.address ?? '', phone: prop.phone ?? '', footer: prop.receiptFooter ?? '', color: prop.brandColor ?? '#1d4e5f' }); const [saved, setSaved] = useState(false);
  const edit = (p: Partial<typeof f>) => { setSaved(false); setF((x) => ({ ...x, ...p })); };
  const save = async () => { if (await run(() => api('PATCH', `/v1/properties/${prop.id}`, { address: f.address.trim() || null, phone: f.phone.trim() || null, receiptFooter: f.footer.trim() || null, brandColor: f.color, version: prop.version }))) { setSaved(true); onSaved(); } };
  const logo = async (files: FileList | null) => { const file = files?.[0]; if (!file) return; const fd = new FormData(); fd.append('file', file); if (await run(() => api('POST', `/v1/properties/${prop.id}/branding/logo`, fd))) onSaved(); };
  const dropLogo = async () => { if (await run(() => api('DELETE', `/v1/properties/${prop.id}/branding/logo`))) onSaved(); };
  return (
    <fieldset className="guestcard stack"><legend>{t('doc.branding')}</legend>
      <p className="hint">{t('doc.brandingHelp')}</p>
      <div className="row">{prop.logoUrl ? <img src={prop.logoUrl} alt={t('doc.logo')} style={{ maxHeight: 56, maxWidth: 140, objectFit: 'contain' }} /> : <span className="muted small">{t('doc.noLogo')}</span>}
        <input ref={pick} type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={(e) => { void logo(e.target.files); e.target.value = ''; }} />
        <button type="button" disabled={busy} onClick={() => pick.current?.click()}>{prop.logoUrl ? t('doc.replaceLogo') : t('doc.addLogo')}</button>
        {prop.logoUrl && <button type="button" className="link" disabled={busy} onClick={dropLogo}>{t('doc.remove')}</button>}</div>
      <Field label={t('doc.address')}>{(p) => <input {...p} maxLength={300} value={f.address} onChange={(e) => edit({ address: e.target.value })} />}</Field>
      <div className="grid2">
        <Field label={t('doc.phone')}>{(p) => <input {...p} dir="ltr" inputMode="tel" maxLength={40} value={f.phone} onChange={(e) => edit({ phone: e.target.value })} />}</Field>
        <Field label={t('doc.color')}>{(p) => <input {...p} type="color" value={f.color} onChange={(e) => edit({ color: e.target.value })} />}</Field>
      </div>
      <Field label={t('doc.footer')} hint={t('doc.footerHint')}>{(p) => <input {...p} maxLength={300} value={f.footer} onChange={(e) => edit({ footer: e.target.value })} />}</Field>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button disabled={busy} onClick={save}>{t('common.save')}</button>{saved && <span className="ok small" role="status">✓ {t('ps.saved')}</span>}</div>
    </fieldset>
  );
}
