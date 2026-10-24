import type { Brand } from '../documents/render.js';

/**
 * The corporate rate proposal as a letter: who it is for and the reference, the greeting, the table of rates by room category and number of guests, notes, what is included,
 * the terms, how to book and bill, the signature, and a photo gallery for each room category. One self-contained, printable page in the hotel's own look; every dynamic value
 * is escaped, there is no external script and the only script is the print button (with the response's nonce).
 */
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const day = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const rate = (v: string | null, cur: string) => { if (!v) return '—'; const [w = '0', f = '00'] = v.split('.'); return `${cur} ${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${/^0+$/.test(f) ? '' : `.${f}`}`; };
const safeColor = (c: string) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : '#1d4e5f');
const para = (t: string) => esc(t).replace(/\n/g, '<br>');
const li = (xs: string[]) => xs.map((x) => `<li>${esc(x)}</li>`).join('');
const safeSrc = (u: string) => (/^\/[A-Za-z0-9/_.\-]+$/.test(u) || /^https?:\/\//.test(u) ? esc(u) : '');

export interface ProposalPage { number: string; reference: string | null; companyName: string; attnName: string | null; attnTitle: string | null; issuedOn: string; validFrom: string; validTo: string; title: string | null; intro: string | null; notes: string[]; facilities: string[]; terms: string[];
  billing: { contactName?: string | null; phone?: string | null; email?: string | null; steps: string[] }; signatory: string | null; currency: string; property: string;
  rows: Array<{ label: string; p1: string | null; p2: string | null; p3: string | null; p4: string | null; photos: string[] }> }

export function renderProposal(b: Brand, d: ProposalPage, nonce: string): string {
  const color = safeColor(b.color); const where = [b.address, b.city].filter(Boolean).join(', ');
  const used = [1, 2, 3, 4].filter((n) => d.rows.some((r) => r[`p${n}` as 'p1'])); const head = ['Single guest', 'Double guests', 'Triple guests', 'Quad guests'];
  const table = `<table><thead><tr><th>Room category</th>${used.map((n) => `<th class="r">${head[n - 1]}</th>`).join('')}</tr></thead><tbody>${d.rows.map((r) => `<tr><td>${esc(r.label)}</td>${used.map((n) => `<td class="r" data-l="${head[n - 1]}">${esc(rate(r[`p${n}` as 'p1'], d.currency))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const gallery = d.rows.filter((r) => r.photos.length).map((r) => `<section class="card gal"><h2>${esc(r.label)}</h2><div class="grid">${r.photos.map((u) => (safeSrc(u) ? `<img src="${safeSrc(u)}" alt="${esc(r.label)}" loading="lazy">` : '')).join('')}</div></section>`).join('');
  const bl = d.billing; const contact = [bl.contactName ? `Reservation contact: ${esc(bl.contactName)}` : '', bl.phone ? `Phone: ${esc(bl.phone)}` : '', bl.email ? `Email: ${esc(bl.email)}` : ''].filter(Boolean).join(' &nbsp;·&nbsp; ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(d.title || 'Corporate rates')} — ${esc(b.name)}</title>
<style>
:root{--brand:${esc(color)};--ink:#14202a;--muted:#5b6876;--line:#e5e9ee;--bg:#f4f6f9;--card:#fff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "Inter Variable",Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:860px;margin:0 auto;padding:0 16px 48px}.muted{color:var(--muted)}
.hero{background:linear-gradient(135deg,var(--brand),color-mix(in srgb,var(--brand) 55%,#000));color:#fff;padding:26px 0 60px}.hero .wrap{padding-bottom:0}
.brand{display:flex;gap:14px;align-items:center}.brand img{max-height:52px;max-width:120px;object-fit:contain;background:#fff;border-radius:12px;padding:6px}.brand strong{font-size:1.15rem}.brand span{display:block;opacity:.85;font-size:.85rem}
.hero h1{margin:24px 0 6px;font-size:clamp(1.6rem,4.6vw,2.3rem);letter-spacing:-.03em;line-height:1.12}.pill{display:inline-block;margin-top:12px;padding:5px 14px;border-radius:999px;background:rgba(255,255,255,.18);font-weight:600;font-size:.85rem}
.card{background:var(--card);border-radius:22px;box-shadow:0 1px 2px rgba(20,32,42,.05),0 8px 28px rgba(20,32,42,.07);padding:22px;margin:16px 0}.pull{margin-top:-36px}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}.k{display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);font-weight:600}
h2{margin:0 0 12px;font-size:.78rem;text-transform:uppercase;letter-spacing:.1em;color:var(--brand)}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:.78rem;color:var(--brand);padding:10px 8px;border-bottom:2px solid var(--brand)}td{padding:12px 8px;border-bottom:1px solid var(--line);vertical-align:top}.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}th.r{text-align:right}
.notes{margin:14px 0 0;padding-inline-start:18px;color:var(--muted);font-size:.9rem}ul.list{margin:0;padding-inline-start:20px;display:grid;gap:6px}ul.list li::marker{color:var(--brand)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}.grid img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:14px;background:var(--line)}
.sign{margin-top:18px;white-space:pre-line}.print{text-align:center;margin:8px 0}button{font:inherit;font-weight:650;padding:11px 20px;border-radius:14px;border:1px solid var(--brand);background:transparent;color:var(--brand);cursor:pointer}
footer{text-align:center;color:var(--muted);font-size:.82rem;margin-top:26px}
@media(max-width:640px){thead{display:none}tr{display:grid;gap:2px;padding:10px 0;border-bottom:1px solid var(--line)}td{border:0;padding:2px 0;text-align:left}td.r{display:flex;justify-content:space-between}td[data-l]::before{content:attr(data-l);color:var(--muted);font-size:.82rem;font-weight:500}td:first-child{font-weight:650}}
@media print{body{background:#fff}.hero{background:none!important;color:#000;padding:0}.hero .pill{border:1px solid #999;background:none}.card{box-shadow:none;border:1px solid #ddd;break-inside:avoid}.pull{margin-top:0}.print{display:none}.brand img{background:none}.gal{break-before:page}}
</style></head><body>
<div class="hero"><div class="wrap"><div class="brand">${b.logoUrl ? `<img src="${esc(b.logoUrl)}" alt="">` : ''}<div><strong>${esc(b.name)}</strong>${where ? `<span>${esc(where)}</span>` : ''}</div></div>
<h1>${esc(d.title || 'Corporate Room Rates Proposal')}</h1><span class="pill">Effective ${esc(day(d.validFrom))} – ${esc(day(d.validTo))}</span></div></div>
<div class="wrap">
<section class="card pull two"><div><span class="k">Attention</span><strong>${esc(d.attnName ?? d.companyName)}</strong>${d.attnTitle ? `<br><span class="muted">${esc(d.attnTitle)}</span>` : ''}${d.attnName ? `<br><span class="muted">${esc(d.companyName)}</span>` : ''}</div>
<div><span class="k">Reference no</span><strong>${esc(d.reference ?? d.number)}</strong><br><span class="k" style="margin-top:8px">Dated</span><strong>${esc(day(d.issuedOn))}</strong></div></section>
${d.intro ? `<section class="card">${d.intro.split('\n').filter((x) => x.trim()).map((x) => `<p>${esc(x)}</p>`).join('')}</section>` : ''}
<section class="card">${table}${d.notes.length ? `<ul class="notes">${li(d.notes)}</ul>` : ''}</section>
${d.facilities.length ? `<section class="card"><h2>Facilities included</h2><ul class="list">${li(d.facilities)}</ul></section>` : ''}
${d.terms.length ? `<section class="card"><h2>Terms &amp; conditions</h2><ul class="list">${li(d.terms)}</ul></section>` : ''}
${d.billing.steps.length || contact ? `<section class="card"><h2>Booking and billing instructions</h2>${d.billing.steps.length ? `<ol class="list">${li(d.billing.steps)}</ol>` : ''}${contact ? `<p>${contact}</p>` : ''}</section>` : ''}
${d.signatory ? `<section class="card"><p>Best regards,</p><p class="sign">${esc(d.signatory)}</p></section>` : ''}
${gallery}
<div class="print"><button type="button" id="p">Print or save as PDF</button></div>
<footer>${b.footer ? `${esc(b.footer)}<br>` : ''}${esc(b.name)}</footer></div>
<script nonce="${esc(nonce)}">document.getElementById('p').addEventListener('click',function(){window.print();});</script>
</body></html>`;
}
