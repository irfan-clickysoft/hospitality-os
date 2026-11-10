import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAuth } from '../state.js';

export interface OnFile { found: boolean; fullName?: string; idType?: string; masked?: string; expiry?: string | null; nationality?: string | null }

/** The ID a returning guest showed on an earlier stay and that has not expired, masked. Nothing is offered for a new guest or when the document has expired. */
export function useIdOnFile(guestId: string | null | undefined): OnFile | null {
  const { property } = useAuth(); const [info, setInfo] = useState<OnFile | null>(null);
  useEffect(() => {
    let dead = false; setInfo(null); if (!guestId) return;
    api<OnFile>('GET', `/v1/properties/${property!.id}/guests/${guestId}/id-on-file`).then((r) => { if (!dead) setInfo(r); }).catch(() => undefined);
    return () => { dead = true; };
  }, [guestId, property]);
  return info;
}

/** "This guest showed an ID before": one tap fills the main guest's card instead of typing the number again. */
export function IdOnFileOffer({ info, onUse }: { info: OnFile; onUse: () => void }) {
  const { t } = useT();
  return (
    <div className="card inner row between wrap" role="group" aria-label={t('ci.onFileTitle')}>
      <span><strong>{t('ci.onFileTitle')}</strong><br /><span className="small">{t('ci.onFileText', { name: info.fullName ?? '', type: t(`ci.id.${info.idType}` as Key), masked: info.masked ?? '' })}{info.expiry ? ` · ${t('ci.onFileUntil', { d: info.expiry })}` : ''}</span></span>
      <button type="button" className="primary" onClick={onUse}>{t('ci.useOnFile')}</button>
    </div>
  );
}

/** What replaces the ID fields once the ID on file is used. */
export function IdOnFileUsed({ type, masked, onClear }: { type: string; masked: string; onClear: () => void }) {
  const { t } = useT();
  return <p className="row between wrap" role="status"><span>✓ {t('ci.onFileUsed', { type: t(`ci.id.${type}` as Key), masked })}</span><button type="button" className="link" onClick={onClear}>{t('ci.enterOther')}</button></p>;
}
