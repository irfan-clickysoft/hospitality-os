/** Printable cash handover receipt: a self-contained HTML page (print to paper or PDF) with lines for both signatures. Every dynamic value is escaped. */
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (a: { amount: string; currency: string }): string => { const neg = a.amount.startsWith('-'); const [w = '0', f = '00'] = a.amount.replace('-', '').split('.'); return `${neg ? '−' : ''}${a.currency} ${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`; };

type Amt = { amount: string; currency: string };
export interface ReceiptView {
  property: string; company: string; date: string; createdAt: string; handedBy: string; receivedBy: string; receivedByTitle: string | null; note: string | null;
  amount: Amt; safeBefore: Amt; difference: Amt; balanceAfter: Amt; since: string | null;
  envelopes: Array<{ date: string; register: string; amount: Amt; variance: Amt }>;
}

export function renderHandoverHtml(v: ReceiptView): string {
  const rows = v.envelopes.map((e) => `<tr><td>${esc(e.date)}</td><td>${esc(e.register)}</td><td class="r">${money(e.amount)}</td><td class="r">${e.variance.amount === '0.00' ? '' : money(e.variance)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cash handover ${esc(v.date)}</title>
<style>
@page { size: A4; margin: 16mm; } body { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1d2a30; max-width: 760px; margin: 0 auto; padding: 16px; }
h1 { font-size: 20px; margin: 0; letter-spacing: .04em; } .head { border-bottom: 2px solid #1d2a30; padding-bottom: 10px; margin-bottom: 14px; } .muted { color: #5d6b72; }
table { width: 100%; border-collapse: collapse; margin: 10px 0; } th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #dcd7cb; } th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #5d6b72; } .r { text-align: right; }
.big { font-size: 22px; font-weight: 700; } .warn { border: 1px solid #b0791c; background: #fdf3df; padding: 8px 10px; border-radius: 6px; margin: 10px 0; }
.sign { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; margin-top: 56px; } .line { border-top: 1px solid #1d2a30; padding-top: 4px; }
@media print { body { padding: 0; } }
</style></head><body>
<div class="head"><h1>CASH HANDOVER TO HEAD OFFICE</h1><div class="muted">${esc(v.company)} · ${esc(v.property)} · ${esc(v.date)}</div></div>
<p class="big">${money(v.amount)}</p>
<table><tr><td>Handed over by</td><td>${esc(v.handedBy)}</td></tr><tr><td>Received by</td><td>${esc(v.receivedBy)}${v.receivedByTitle ? ` (${esc(v.receivedByTitle)})` : ''}</td></tr>
<tr><td>Safe should have held (from the envelopes)</td><td>${money(v.safeBefore)}</td></tr><tr><td>Left in the safe after this handover</td><td>${money(v.balanceAfter)}</td></tr></table>
${v.difference.amount !== '0.00' ? `<div class="warn"><strong>Less than the whole safe (${money(v.difference)}).</strong> ${esc(v.note ?? '')}</div>` : (v.note ? `<p class="muted">${esc(v.note)}</p>` : '')}
<h3>Envelopes closed ${v.since ? `since ${esc(v.since)}` : 'so far'}</h3>
<table><thead><tr><th>Day</th><th>Register</th><th class="r">Envelope</th><th class="r">Count difference</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">None</td></tr>'}</tbody></table>
<p class="muted">Count the cash and the envelopes together before signing. Recorded ${esc(v.createdAt)}; this record cannot be changed afterwards.</p>
<div class="sign"><div class="line">Handed over by — ${esc(v.handedBy)}</div><div class="line">Received by — ${esc(v.receivedBy)}</div></div>
</body></html>`;
}
