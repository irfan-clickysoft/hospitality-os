import { useT } from '../i18n/index.js';

export interface Negotiation { kind: 'none' | 'pct' | 'off' | 'price'; scope: 'stay' | 'first'; value: string }
export const noNegotiation: Negotiation = { kind: 'none', scope: 'stay', value: '' };
const amount = (v: string) => /^\d{1,9}(\.\d{1,2})?$/.test(v.trim()) && Number(v) > 0;

/** What to add to a price search for this negotiation (nothing while it is empty or not a valid number). The server works out the exact figures and checks the person may give them. */
export function negotiationParams(n: Negotiation, firstNight: string): Record<string, unknown> {
  const v = n.value.trim();
  if (n.kind === 'none' || v === '') return {};
  if (n.kind === 'pct') { const p = Number(v); return p > 0 && p <= 100 ? (n.scope === 'stay' ? { discountPct: p } : { nightDiscounts: [{ date: firstNight, pct: p }] }) : {}; }
  if (!amount(v)) return {};
  if (n.kind === 'off') return { discountAmount: v };
  return n.scope === 'stay' ? { agreedTotal: v } : { nightPrices: [{ date: firstNight, price: v }] };
}

/** The desk's way to give a guest a special price: a percentage off, an amount off, or an agreed price, for the whole stay or only the first night. */
export function NegotiateBox({ value, onChange }: { value: Negotiation; onChange: (n: Negotiation) => void }) {
  const { t } = useT();
  const set = (patch: Partial<Negotiation>) => onChange({ ...value, ...patch });
  return (
    <div className="card inner stack" role="group" aria-label={t('ng.title')}><strong>{t('ng.title')}</strong>
      <div className="grid2">
        <label>{t('ng.how')}<select value={value.kind} onChange={(e) => set({ kind: e.target.value as Negotiation['kind'], ...(e.target.value === 'off' ? { scope: 'stay' as const } : {}) })}>
          <option value="none">{t('ng.none')}</option><option value="pct">{t('ng.pct')}</option><option value="off">{t('ng.off')}</option><option value="price">{t('ng.price')}</option></select></label>
        {value.kind !== 'none' && <label>{t('ng.scope')}<select value={value.scope} onChange={(e) => set({ scope: e.target.value as Negotiation['scope'] })}><option value="stay">{t('ng.stay')}</option>{value.kind !== 'off' && <option value="first">{t('ng.first')}</option>}</select></label>}
      </div>
      {value.kind !== 'none' && <label>{value.kind === 'pct' ? t('ng.valuePct') : value.kind === 'off' ? t('ng.valueOff') : value.scope === 'first' ? t('ng.valuePriceFirst') : t('ng.valuePriceStay')}
        <input value={value.value} onChange={(e) => set({ value: e.target.value })} inputMode="decimal" dir="ltr" placeholder={value.kind === 'pct' ? '10' : '9000'} /></label>}
      {value.kind === 'price' && <p className="muted small">{t('ng.noRaise')}</p>}
    </div>
  );
}
