/**
 * The hotel's printable documents — receipt, refund voucher, final statement, room-service slip — as self-contained pages in the property's own look. Every dynamic value is escaped, there is no
 * external file, and the only script is the print button, which carries the response's nonce. Pure functions: the service loads the data, this only draws it.
 */
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export type Amt = { amount: string; currency: string };
export const fmtAmt = (a: Amt): string => { const neg = a.amount.startsWith('-'); const [w = '0', f = '00'] = a.amount.replace('-', '').split('.'); return `${neg ? '−' : ''}${a.currency} ${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f.padEnd(2, '0')}`; };

export interface Brand { name: string; address: string | null; city: string | null; phone: string | null; color: string; logoUrl: string | null; footer: string | null }
export interface Doc { title: string; number: string | null; status?: { text: string; tone: 'ok' | 'warn' | 'bad' } | null; meta: Array<[string, string | null]>; table?: { head: string[]; rows: string[][]; right?: number[] }; totals?: Array<[string, string, boolean?]>; notes?: string[] }

export function renderDocument(b: Brand, d: Doc, nonce: string): string {
  const meta = d.meta.filter(([, v]) => v).map(([k, v]) => `<div><span class="k">${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
  const right = new Set(d.table?.right ?? []);
  const table = d.table ? `<table><thead><tr>${d.table.head.map((h, i) => `<th${right.has(i) ? ' class="r"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${d.table.rows.map((r) => `<tr>${r.map((c, i) => `<td${right.has(i) ? ' class="r"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';
  const totals = d.totals?.length ? `<table class="sum">${d.totals.map(([k, v, g]) => `<tr${g ? ' class="grand"' : ''}><td>${esc(k)}</td><td class="r">${esc(v)}</td></tr>`).join('')}</table>` : '';
  const where = [b.address, b.city].filter(Boolean).join(', ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(d.title)}${d.number ? ` ${esc(d.number)}` : ''} — ${esc(b.name)}</title>
<style>
@page { size: A4; margin: 14mm; }
:root { --brand: ${esc(b.color)}; }
body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1d2a30; max-width: 760px; margin: 0 auto; padding: 16px; background: #fff; }
header { display: flex; gap: 16px; align-items: center; justify-content: space-between; border-bottom: 3px solid var(--brand); padding-bottom: 12px; margin-bottom: 16px; }
.id { display: flex; gap: 12px; align-items: center; } .id img { max-height: 56px; max-width: 120px; object-fit: contain; } .id strong { font-size: 18px; }
.muted { color: #5d6b72; } .doc { text-align: right; } .doc h1 { margin: 0; font-size: 20px; letter-spacing: .05em; color: var(--brand); }
.status { display: inline-block; margin-top: 4px; padding: 2px 10px; border: 2px solid; border-radius: 6px; font-weight: 700; letter-spacing: .06em; }
.ok { color: #1e7a46; } .warn { color: #a35d00; } .bad { color: #b3261e; }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 6px 24px; margin-bottom: 14px; } .meta .k { display: block; font-size: 12px; color: #5d6b72; }
table { width: 100%; border-collapse: collapse; margin: 10px 0; } th, td { text-align: left; padding: 6px; border-bottom: 1px solid #dcd7cb; vertical-align: top; } th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #5d6b72; }
.r { text-align: right; font-variant-numeric: tabular-nums; } .sum { width: 340px; margin-inline-start: auto; } .sum td { border: 0; } .sum tr.grand td { border-top: 2px solid var(--brand); font-weight: 700; font-size: 16px; }
.notes { margin-top: 12px; font-size: 13px; } footer { margin-top: 24px; padding-top: 10px; border-top: 1px solid #dcd7cb; font-size: 12px; color: #5d6b72; text-align: center; }
button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--brand); background: var(--brand); color: #fff; cursor: pointer; } .noprint { text-align: center; margin: 16px 0; }
@media print { .noprint { display: none; } body { padding: 0; } }
</style></head><body>
<header><div class="id">${b.logoUrl ? `<img src="${esc(b.logoUrl)}" alt="">` : ''}<div><strong>${esc(b.name)}</strong>${where ? `<div class="muted">${esc(where)}</div>` : ''}${b.phone ? `<div class="muted">${esc(b.phone)}</div>` : ''}</div></div>
<div class="doc"><h1>${esc(d.title)}</h1>${d.number ? `<div>${esc(d.number)}</div>` : ''}${d.status ? `<div class="status ${d.status.tone}">${esc(d.status.text)}</div>` : ''}</div></header>
<div class="meta">${meta}</div>${table}${totals}${d.notes?.length ? `<div class="notes">${d.notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div>` : ''}
<div class="noprint"><button id="p" type="button">Print or save as PDF</button></div>
<footer>${b.footer ? `${esc(b.footer)}<br>` : ''}${esc(b.name)}</footer>
<script nonce="${esc(nonce)}">document.getElementById('p').addEventListener('click', function () { window.print(); });</script>
</body></html>`;
}

export const PAGE_NOT_FOUND = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Link not valid</title></head><body style="font-family:system-ui;max-width:480px;margin:48px auto;padding:16px"><h1>This link is not valid</h1><p>It may have been replaced or expired. Please ask the hotel for a new one.</p></body></html>`;
