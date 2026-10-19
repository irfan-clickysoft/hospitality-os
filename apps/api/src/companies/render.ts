/** A company's statement as a self-contained, printable page. Every dynamic value is escaped. */
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (a: { amount: string }): string => { const neg = a.amount.startsWith('-'); const [w = '0', f = '00'] = a.amount.replace('-', '').split('.'); return `${neg ? '−' : ''}${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f.padEnd(2, '0')}`; };
type Amt = { amount: string; currency: string };
export interface StatementView {
  company: { name: string; ntn: string | null; strn: string | null; address: string | null; termsDays: number }; from: string; to: string; currency?: string;
  opening: Amt; billed: Amt; received: Amt; closing: Amt;
  lines: Array<{ date: string; kind: string; ref: string | null; text: string | null; debit: Amt; credit: Amt; balance: Amt; due: string | null }>;
  aging: { buckets: Record<string, Amt>; onAccount: Amt; totalOpen: Amt };
}
const KIND: Record<string, string> = { BILLED: 'Billed', CANCELLED: 'Cancelled', RECEIPT: 'Received', WITHHELD: 'Tax withheld' };
const BUCKET: Array<[string, string]> = [['current', 'Not yet due'], ['d1_30', '1–30 days'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['d90plus', 'Over 90 days']];

export function renderStatementHtml(v: StatementView, issuer: { name: string; ntn?: string | null; strn?: string | null }): string {
  const cur = v.closing.currency;
  const rows = v.lines.map((l) => `<tr><td>${esc(l.date)}</td><td>${esc(KIND[l.kind] ?? l.kind)}</td><td>${esc(l.ref ?? '')}${l.text ? ` · ${esc(l.text)}` : ''}</td><td>${esc(l.due ?? '')}</td><td class="r">${l.debit.amount === '0.00' ? '' : money(l.debit)}</td><td class="r">${l.credit.amount === '0.00' ? '' : money(l.credit)}</td><td class="r">${money(l.balance)}</td></tr>`).join('');
  const ag = BUCKET.map(([k, label]) => `<tr><td>${esc(label)}</td><td class="r">${v.aging.buckets[k] ? money(v.aging.buckets[k]!) : '0.00'}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Statement — ${esc(v.company.name)}</title>
<style>
@page { size: A4; margin: 16mm; } body { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1d2a30; max-width: 820px; margin: 0 auto; padding: 16px; }
h1 { font-size: 22px; margin: 0; letter-spacing: .04em; } .head { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #1d2a30; padding-bottom: 10px; margin-bottom: 14px; }
.muted { color: #5d6b72; } table { width: 100%; border-collapse: collapse; margin: 10px 0; } th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #dcd7cb; vertical-align: top; } th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #5d6b72; }
.r { text-align: right; font-variant-numeric: tabular-nums; } .sum { width: 340px; margin-inline-start: auto; } .sum td { border: 0; } .sum tr.grand td { border-top: 2px solid #1d2a30; font-weight: 800; font-size: 15px; }
@media print { body { padding: 0; } }
</style></head><body>
<div class="head"><div><h1>STATEMENT OF ACCOUNT</h1><div class="muted">${esc(v.from)} → ${esc(v.to)}</div></div>
<div><strong>${esc(issuer.name)}</strong>${issuer.ntn ? `<div class="muted">NTN ${esc(issuer.ntn)}</div>` : ''}${issuer.strn ? `<div class="muted">STRN ${esc(issuer.strn)}</div>` : ''}</div></div>
<p><strong>${esc(v.company.name)}</strong>${v.company.address ? `<br>${esc(v.company.address)}` : ''}${v.company.ntn ? `<br>NTN ${esc(v.company.ntn)}` : ''}${v.company.strn ? ` · STRN ${esc(v.company.strn)}` : ''}<br><span class="muted">Payment terms: net ${esc(v.company.termsDays)} days</span></p>
<table><thead><tr><th>Date</th><th></th><th>Reference</th><th>Due</th><th class="r">Billed (${esc(cur)})</th><th class="r">Received (${esc(cur)})</th><th class="r">Balance</th></tr></thead><tbody>
<tr><td colspan="6" class="muted">Balance brought forward</td><td class="r">${money(v.opening)}</td></tr>${rows}</tbody></table>
<table class="sum"><tr><td>Billed in the period</td><td class="r">${money(v.billed)}</td></tr><tr><td>Received in the period</td><td class="r">${money(v.received)}</td></tr><tr class="grand"><td>Balance due (${esc(cur)})</td><td class="r">${money(v.closing)}</td></tr></table>
<h3>Ageing at ${esc(v.to)}</h3><table class="sum">${ag}${v.aging.onAccount.amount !== '0.00' ? `<tr><td>Credit on account</td><td class="r">${money(v.aging.onAccount)}</td></tr>` : ''}</table>
</body></html>`;
}
