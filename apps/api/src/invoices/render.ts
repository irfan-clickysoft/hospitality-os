/** Printable invoice / credit note as a self-contained HTML page (print to PDF from the browser). Every dynamic value is escaped. */
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (a: { amount: string }): string => { const neg = a.amount.startsWith('-'); const [w = '0', f = '00'] = a.amount.replace('-', '').split('.'); return `${neg ? '−' : ''}${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`; };

interface View {
  docType: 'TAX_INVOICE' | 'CREDIT_NOTE'; number: string; issueDate: string; currency: string; contentHash: string; reason: string | null;
  issuer: { name: string; ntn: string | null; strn: string | null; address: string | null; property: string };
  billTo: { name: string; ntn?: string | null; strn?: string | null; address?: string | null; phone?: string | null };
  reference: { confirmationNo?: string; folioNo?: string; arrival?: string | null; departure?: string | null; rooms?: string[]; creditsInvoiceNumber?: string };
  lines: Array<{ date: string; description: string; quantity: number; net: { amount: string }; tax: { amount: string }; taxes: Array<{ code: string; rateBp: number }> }>;
  taxSummary: Array<{ code: string; ratePercent: number; taxable: { amount: string }; tax: { amount: string } }>;
  net: { amount: string }; tax: { amount: string }; total: { amount: string };
  payments: { received: Array<{ method: string; amountMinor: string }>; balanceAtIssueMinor: string };
}
const METHOD: Record<string, string> = { CASH: 'Cash', CARD_SLIP: 'Card', WALLET: 'Wallet', BANK_TRANSFER: 'Bank transfer', COMPANY_CREDIT: 'Charged to account' };
const minor = (m: string): string => { const neg = m.startsWith('-'); const d = m.replace('-', '').padStart(3, '0'); return money({ amount: `${neg ? '-' : ''}${d.slice(0, -2)}.${d.slice(-2)}` }); };

export function renderInvoiceHtml(v: View): string {
  const credit = v.docType === 'CREDIT_NOTE';
  const rows = v.lines.map((l) => `<tr><td>${esc(l.date)}</td><td>${esc(l.description)}${l.quantity !== 1 ? ` × ${esc(l.quantity)}` : ''}</td><td class="r">${money(l.net)}</td><td>${l.taxes.map((t) => `${esc(t.code)} ${t.rateBp / 100}%`).join(', ') || '—'}</td><td class="r">${money(l.tax)}</td></tr>`).join('');
  const taxRows = v.taxSummary.map((t) => `<tr><td>${esc(t.code)} (${t.ratePercent}%)</td><td class="r">${money(t.taxable)}</td><td class="r">${money(t.tax)}</td></tr>`).join('');
  const pays = v.payments.received.map((p) => `<tr><td>${esc(METHOD[p.method] ?? p.method)}</td><td class="r">${minor(p.amountMinor)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(v.number)}</title>
<style>
@page { size: A4; margin: 16mm; } body { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1d2a30; max-width: 820px; margin: 0 auto; padding: 16px; }
h1 { font-size: 22px; margin: 0; letter-spacing: .04em; } .head { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #1d2a30; padding-bottom: 10px; margin-bottom: 14px; }
.muted { color: #5d6b72; } table { width: 100%; border-collapse: collapse; margin: 10px 0; } th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #dcd7cb; vertical-align: top; } th { font-size: 11px; text-transform: uppercase; color: #5d6b72; } .r { text-align: right; font-variant-numeric: tabular-nums; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; } .totals { margin-inline-start: auto; width: 320px; } .totals td { border: 0; } .totals tr.grand td { border-top: 2px solid #1d2a30; font-weight: 800; font-size: 15px; }
.badge { display: inline-block; padding: 2px 8px; border: 1px solid #1d2a30; border-radius: 4px; font-size: 11px; } footer { margin-top: 24px; font-size: 11px; color: #5d6b72; }
@media print { body { padding: 0; } }
</style></head><body>
<div class="head"><div><h1>${credit ? 'CREDIT NOTE' : 'TAX INVOICE'}</h1><div class="muted">${esc(v.number)} · ${esc(v.issueDate)}</div>${credit ? `<div class="muted">Credits invoice ${esc(v.reference.creditsInvoiceNumber)}${v.reason ? ` — ${esc(v.reason)}` : ''}</div>` : ''}</div>
<div><strong>${esc(v.issuer.name)}</strong><br>${esc(v.issuer.property)}<br>${v.issuer.address ? esc(v.issuer.address) + '<br>' : ''}${v.issuer.ntn ? `NTN ${esc(v.issuer.ntn)}` : '<span class="muted">NTN not set</span>'} · ${v.issuer.strn ? `STRN ${esc(v.issuer.strn)}` : '<span class="muted">STRN not set</span>'}</div></div>
<div class="two"><div><div class="muted">Billed to</div><strong>${esc(v.billTo.name)}</strong>${v.billTo.address ? `<br>${esc(v.billTo.address)}` : ''}${v.billTo.ntn ? `<br>NTN ${esc(v.billTo.ntn)}` : ''}${v.billTo.strn ? `<br>STRN ${esc(v.billTo.strn)}` : ''}${v.billTo.phone ? `<br>${esc(v.billTo.phone)}` : ''}</div>
<div><div class="muted">Stay</div>Booking ${esc(v.reference.confirmationNo)} · Folio ${esc(v.reference.folioNo)}<br>${v.reference.arrival ? `${esc(v.reference.arrival)} → ${esc(v.reference.departure)}` : ''}${v.reference.rooms?.length ? `<br>Room ${v.reference.rooms.map(esc).join(', ')}` : ''}</div></div>
<table><thead><tr><th>Date</th><th>Description</th><th class="r">Amount (${esc(v.currency)})</th><th>Tax</th><th class="r">Tax amount</th></tr></thead><tbody>${rows}</tbody></table>
<table class="totals"><tr><td>Total before tax</td><td class="r">${money(v.net)}</td></tr><tr><td>Tax</td><td class="r">${money(v.tax)}</td></tr><tr class="grand"><td>${credit ? 'Credit total' : 'Invoice total'} (${esc(v.currency)})</td><td class="r">${money(v.total)}</td></tr></table>
${taxRows ? `<table><thead><tr><th>Tax summary</th><th class="r">Taxable value</th><th class="r">Tax</th></tr></thead><tbody>${taxRows}</tbody></table>` : '<p class="muted">No tax was configured for the items on this document.</p>'}
${!credit ? `${pays ? `<table><thead><tr><th>Received</th><th class="r">Amount</th></tr></thead><tbody>${pays}</tbody></table>` : ''}<p>Balance on the folio when issued: <strong>${minor(v.payments.balanceAtIssueMinor)}</strong> ${esc(v.currency)}</p>` : ''}
<footer>Computer-generated document. Reference ${esc(v.contentHash.slice(0, 16))}. Amounts in ${esc(v.currency)}.</footer></body></html>`;
}
