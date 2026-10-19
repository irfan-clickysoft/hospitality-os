import { useEffect } from 'react';
import { useT } from '../i18n/index.js';
import { useAuth, useLive } from '../state.js';

export interface PayAccount { id: string; name: string; kind: string; flagged: boolean; ownerName: string | null; last4: string | null }
const KINDS: Record<string, string[]> = { CASH: [], BANK_TRANSFER: ['BANK'], CHEQUE: ['BANK'], CARD_SLIP: ['CARD_CLEARING', 'GATEWAY'], WALLET: ['WALLET', 'GATEWAY'] };

/** Which account the money went into. Shown only when accounts of the right kind exist; chosen for you when there is just one, flagged when it is not the company’s. */
export function AccountPicker({ method, value, onChange }: { method: string; value: string; onChange: (id: string) => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const list = useLive<{ items: PayAccount[] }>(property && (KINDS[method]?.length ?? 0) > 0 ? `/v1/properties/${property.id}/payment-accounts` : null, 300_000);
  const cands = (list.data?.items ?? []).filter((a) => KINDS[method]?.includes(a.kind));
  useEffect(() => { if (cands.length === 1 && value !== cands[0]!.id) onChange(cands[0]!.id); else if (value && !cands.some((c) => c.id === value)) onChange(''); }, [method, cands.length]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!cands.length) return null;
  const chosen = cands.find((c) => c.id === value);
  return (
    <>
      <label>{t('pa.account')}<select value={value} onChange={(e) => onChange(e.target.value)}>{cands.length > 1 && <option value="">—</option>}{cands.map((a) => <option key={a.id} value={a.id}>{a.name}{a.last4 ? ` ····${a.last4}` : ''}{a.flagged ? ` ⚠ ${t('pa.notCompany')}` : ''}</option>)}</select></label>
      {chosen?.flagged && <p className="warnbox">{t('pa.flagNote', { owner: chosen.ownerName ?? '' })}</p>}
    </>
  );
}
export const needsAccount = (method: string, hasCandidates: boolean, value: string) => (KINDS[method]?.length ?? 0) > 0 && hasCandidates && !value;
