import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { useAuth } from '../state.js';
import { ErrorLine, Sheet } from '../ui/kit.js';

const CODES = ['FNB', 'FNB_DIGITAL', 'LAUNDRY', 'TRANSPORT_OWNED', 'TRANSPORT_THIRDPARTY', 'MINIBAR', 'MISC'] as const;
export function ChargeSheet({ folioId, onDone, onClose }: { folioId: string; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { property } = useAuth();
  const [code, setCode] = useState<(typeof CODES)[number]>('FNB'); const [amount, setAmount] = useState(''); const [qty, setQty] = useState('1'); const [desc, setDesc] = useState('');
  const { busy, problem, run } = useAction();
  const submit = async () => {
    const r = await run(() => api('POST', `/v1/properties/${property!.id}/folios/${folioId}/charges`, { txnCode: code, amount: amount.trim(), quantity: Number(qty) || 1, description: desc.trim() || t(`chg.${code}` as Key) }));
    if (r) { onDone(); onClose(); }
  };
  return (
    <Sheet title={t('chg.title')} onClose={onClose}>
      <label>{t('chg.kind')}<select value={code} onChange={(e) => setCode(e.target.value as typeof code)}>{CODES.map((c) => <option key={c} value={c}>{t(`chg.${c}` as Key)}</option>)}</select></label>
      <div className="grid2"><label>{t('chg.unit')}<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} dir="ltr" autoFocus /></label><label>{t('chg.qty')}<input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} dir="ltr" /></label></div>
      <label>{t('chg.desc')}<input value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || !amount.trim()} onClick={submit}>{t('chg.post')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}
