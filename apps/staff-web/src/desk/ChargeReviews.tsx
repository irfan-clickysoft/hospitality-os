import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { useAuth, useLive } from '../state.js';
import { ErrorLine, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';

interface Review { id: string; kind: string; txnCode: string; message: string; amount: Amount; description: string | null; folioNo: string | null; openedAt: string }

/** Charges that the tax area says someone must look at (a withholding-tax review, a vendor check). Closed with a note, which stays on record. */
export function ChargeReviews() {
  const { t } = useT();
  const { property, can } = useAuth();
  const base = `/v1/properties/${property!.id}/charge-reviews`;
  const list = useLive<{ items: Review[] }>(base, 60_000);
  const { busy, problem, run } = useAction();
  const done = async (r: Review) => { const note = window.prompt(t('cr.note')); if (note && note.trim().length >= 3 && (await run(() => api('POST', `${base}/${r.id}/resolve`, { note: note.trim() })))) list.reload(); };
  return (
    <div className="stack">
      <h3>{t('cr.title')}</h3>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <p className="ok">✓ {t('cr.none')}</p> : (
        <ul className="plain">{list.data.items.map((r) => (
          <li key={r.id} className="card inner stack small">
            <div className="row between"><strong>{t(`cr.k.${r.kind}` as Key)}</strong><strong>{money(r.amount)}</strong></div>
            <span>{r.message}</span>
            <span className="muted">{r.description ?? r.txnCode}{r.folioNo ? ` · ${r.folioNo}` : ''}</span>
            {can('compliance.task') && <div className="row"><button disabled={busy} onClick={() => done(r)}>{t('cr.done')}</button></div>}
          </li>))}</ul>)}
    </div>
  );
}
