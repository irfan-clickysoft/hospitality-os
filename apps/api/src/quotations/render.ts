import type { Brand } from '../documents/render.js';
import type { Pricing } from './service.js';

/**
 * The quotation the customer opens: one self-contained, printable page in the hotel's own look. Every dynamic value is escaped, there is no external file, and the only script is the
 * print button and the accept / decline form, which carry the response's nonce.
 */
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (minor: string | bigint, cur: string): string => { const n = BigInt(minor); const neg = n < 0n; const a = (neg ? -n : n); const w = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); const f = (a % 100n).toString().padStart(2, '0'); return `${neg ? '−' : ''}${cur} ${w}${f === '00' ? '' : `.${f}`}`; };
const day = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayShort = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const next = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const safeColor = (c: string) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : '#1d4e5f');

export interface QuotationPage { number: string; status: string; expired: boolean; customerName: string; contactName: string | null; title: string | null; validUntil: string; issued: string; discountReason: string | null; specialRequests: string | null;
  amenities: string[]; terms: string | null; pricing: Pricing; response: { at: string; name: string | null; note: string | null; accepted: boolean } | null; interactive: boolean }

export function renderQuotation(b: Brand, d: QuotationPage, nonce: string): string {
  const cur = d.pricing.currency; const color = safeColor(b.color); const where = [b.address, b.city].filter(Boolean).join(', ');
  const totalNights = d.pricing.lines.reduce((a, l) => a + l.nights * l.rooms, 0);
  const lines = d.pricing.lines.map((l) => {
    const bands = l.bands.map((g) => `<li><span>${esc(dayShort(g.from))}${g.nights > 1 ? ` – ${esc(dayShort(next(g.to)))}` : ''}${g.label ? ` <em>${esc(g.label)}</em>` : ''}</span><span class="nm">${g.nights} night${g.nights === 1 ? '' : 's'} × ${esc(money(g.rate, cur))}</span></li>`).join('');
    const disc = BigInt(l.discount) > 0n ? `<div class="row disc"><span>Discount</span><span>− ${esc(money(l.discount, cur))}</span></div>` : '';
    return `<section class="card room"><div class="room-head"><div><h3>${esc(l.roomTypeName)}</h3><p class="muted">${l.rooms} room${l.rooms === 1 ? '' : 's'} · ${esc(day(l.arrival))} → ${esc(day(l.departure))} · ${l.nights} night${l.nights === 1 ? '' : 's'}</p>
      <p class="muted">${l.adults} adult${l.adults === 1 ? '' : 's'}${l.children ? `, ${l.children} child${l.children === 1 ? '' : 'ren'}` : ''}${l.extraBeds ? `, ${l.extraBeds} extra bed${l.extraBeds === 1 ? '' : 's'}` : ''}${l.mealPlan && l.mealPlan !== 'NONE' ? ` · ${esc(l.mealPlan.replace(/_/g, ' ').toLowerCase())}` : ''}</p></div>
      <div class="room-total"><span class="muted">Room total</span><strong>${esc(money(l.total, cur))}</strong><span class="muted">incl. tax</span></div></div>
      <ul class="bands">${bands}</ul>
      <div class="row"><span>Stay for ${l.rooms} room${l.rooms === 1 ? '' : 's'}</span><span>${esc(money(l.gross, cur))}</span></div>${disc}${l.note ? `<p class="note">${esc(l.note)}</p>` : ''}</section>`;
  }).join('');
  const tot = d.pricing; const hasDisc = BigInt(tot.discount) > 0n;
  const amen = d.amenities.length ? `<section class="card"><h2>Included with your stay</h2><ul class="chips">${d.amenities.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></section>` : '';
  const req = d.specialRequests ? `<section class="card"><h2>Your special requests</h2><p class="pre">${esc(d.specialRequests)}</p></section>` : '';
  const dep = BigInt(tot.deposit.amount) > 0n ? `<div class="deposit"><strong>Advance to confirm your booking</strong><span>${esc(money(tot.deposit.amount, cur))}</span><p class="muted">Paid by bank transfer or at the hotel. We confirm the rooms once it is received. The balance is settled at check-out.</p></div>` : '';
  const state = d.response ? `<section class="card answer ${d.response.accepted ? 'ok' : 'no'}"><h2>${d.response.accepted ? 'Thank you — you accepted this quotation' : 'You declined this quotation'}</h2><p>${esc(d.response.name ?? '')} · ${esc(day(d.response.at))}</p>${d.response.note ? `<p class="pre">${esc(d.response.note)}</p>` : ''}${d.response.accepted ? '<p class="muted">The hotel has been told and will be in touch to confirm your booking.</p>' : ''}</section>`
    : d.status === 'DRAFT' ? `<section class="card answer"><h2>This quotation is being updated</h2><p class="muted">Please check back shortly or contact the hotel.</p></section>`
    : d.expired || d.status === 'EXPIRED' ? `<section class="card answer no"><h2>This quotation has expired</h2><p class="muted">It was valid until ${esc(day(d.validUntil))}. Please contact the hotel for a new one.</p></section>`
    : d.interactive ? `<section class="card answer" id="answer"><h2>Would you like to go ahead?</h2><p class="muted">Accepting lets the hotel know. We then confirm your booking${BigInt(tot.deposit.amount) > 0n ? ' once the advance is received' : ''}.</p>
      <form id="f"><label>Your name<input name="name" required minlength="2" maxlength="120" autocomplete="name"></label><label>Comments or changes you need (optional)<textarea name="note" rows="3" maxlength="1000"></textarea></label>
      <div class="btns"><button type="submit" class="go" data-d="ACCEPT">Accept quotation</button><button type="submit" class="stop" data-d="DECLINE">Decline</button></div><p id="msg" class="muted" role="status"></p></form></section>` : '';
  const script = d.interactive && !d.response ? `<script nonce="${esc(nonce)}">
var f=document.getElementById('f');if(f){var dec='';f.addEventListener('click',function(e){var t=e.target;if(t&&t.getAttribute&&t.getAttribute('data-d'))dec=t.getAttribute('data-d');});
f.addEventListener('submit',function(e){e.preventDefault();var m=document.getElementById('msg');if(!dec)return;if(dec==='DECLINE'&&!confirm('Decline this quotation?'))return;
var body=JSON.stringify({decision:dec,name:f.name.value,note:f.note.value||undefined});m.textContent='Sending…';
fetch(location.pathname.replace(/\\/$/,'')+'/respond',{method:'POST',headers:{'content-type':'application/json'},body:body}).then(function(r){return r.json().catch(function(){return{};}).then(function(j){if(r.ok)location.reload();else m.textContent=j.message||'Sorry, that did not work. Please try again.';});}).catch(function(){m.textContent='No connection. Please try again.';});});}
</script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Quotation ${esc(d.number)} — ${esc(b.name)}</title>
<style>
:root{--brand:${esc(color)};--ink:#14202a;--muted:#5b6876;--line:#e5e9ee;--bg:#f4f6f9;--card:#fff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "Inter Variable",Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:820px;margin:0 auto;padding:0 16px 48px}.muted{color:var(--muted)}.pre{white-space:pre-wrap}
.hero{background:linear-gradient(135deg,var(--brand),color-mix(in srgb,var(--brand) 55%,#000));color:#fff;padding:28px 0 64px}.hero .wrap{padding-bottom:0}
.brand{display:flex;gap:14px;align-items:center}.brand img{max-height:52px;max-width:120px;object-fit:contain;background:#fff;border-radius:12px;padding:6px}.brand strong{font-size:1.15rem;letter-spacing:-.01em}.brand span{display:block;opacity:.85;font-size:.85rem}
.hero h1{margin:26px 0 4px;font-size:clamp(1.7rem,5vw,2.4rem);letter-spacing:-.03em;line-height:1.1}.hero p{margin:0;opacity:.9}
.pill{display:inline-block;margin-top:14px;padding:5px 14px;border-radius:999px;background:rgba(255,255,255,.18);font-weight:600;font-size:.85rem;backdrop-filter:blur(6px)}
.card{background:var(--card);border-radius:22px;box-shadow:0 1px 2px rgba(20,32,42,.05),0 8px 28px rgba(20,32,42,.07);padding:22px;margin:16px 0}
.pull{margin-top:-40px}.for{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}.for .k{display:block;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600}.for strong{font-size:1.05rem}
h2{margin:0 0 12px;font-size:1.15rem;letter-spacing:-.01em}h3{margin:0;font-size:1.2rem;letter-spacing:-.01em}
.room-head{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.room-head p{margin:2px 0 0;font-size:.9rem}.room-total{text-align:right;display:grid}.room-total strong{font-size:1.5rem;letter-spacing:-.02em;color:var(--brand)}.room-total .muted{font-size:.78rem}
.bands{list-style:none;margin:16px 0 8px;padding:0;display:grid;gap:6px}.bands li{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;background:var(--bg);border-radius:12px;flex-wrap:wrap}.bands em{font-style:normal;margin-inline-start:6px;padding:1px 9px;border-radius:999px;background:color-mix(in srgb,var(--brand) 14%,#fff);color:var(--brand);font-size:.78rem;font-weight:650}.nm{font-variant-numeric:tabular-nums}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 2px;font-variant-numeric:tabular-nums}.row.disc{color:#1e7a46;font-weight:600}.note{margin:8px 0 0;color:var(--muted);font-size:.9rem}
.chips{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}.chips li{padding:7px 14px;border-radius:999px;background:color-mix(in srgb,var(--brand) 10%,#fff);color:var(--ink);font-weight:550;font-size:.9rem}.chips li::before{content:"✓";color:var(--brand);margin-inline-end:7px;font-weight:700}
.totals .row{font-size:.98rem}.totals .grand{border-top:2px solid var(--brand);margin-top:8px;padding-top:12px;font-size:1.35rem;font-weight:750;letter-spacing:-.02em}.saving{margin-top:10px;padding:10px 14px;border-radius:12px;background:#e6f4ea;color:#1e6b3a;font-weight:600}
.deposit{margin-top:16px;padding:16px;border-radius:16px;background:color-mix(in srgb,var(--brand) 9%,#fff);display:grid;grid-template-columns:1fr auto;gap:2px 12px;align-items:center}.deposit span{font-size:1.3rem;font-weight:750;color:var(--brand)}.deposit p{grid-column:1/-1;margin:4px 0 0;font-size:.88rem}
.answer h2{margin-bottom:6px}.answer.ok{background:#e9f6ee}.answer.no{background:#fbeceb}
form{display:grid;gap:12px;margin-top:12px}label{display:grid;gap:5px;font-weight:600;font-size:.9rem}input,textarea{font:inherit;padding:12px 14px;border:1px solid #b9c2cc;border-radius:12px;background:#fff}input:focus,textarea:focus{outline:3px solid color-mix(in srgb,var(--brand) 35%,transparent);border-color:var(--brand)}
.btns{display:flex;gap:10px;flex-wrap:wrap}button{font:inherit;font-weight:650;padding:13px 22px;border-radius:14px;border:0;cursor:pointer}.go{background:var(--brand);color:#fff;flex:1 1 200px;box-shadow:0 4px 14px color-mix(in srgb,var(--brand) 40%,transparent)}.stop{background:#eef1f5;color:var(--ink)}
.terms{font-size:.85rem;color:var(--muted)}.print{text-align:center;margin:8px 0}.print button{background:transparent;color:var(--brand);border:1px solid var(--brand)}
footer{text-align:center;color:var(--muted);font-size:.82rem;margin-top:26px}
@media print{body{background:#fff}.hero{background:none!important;color:#000;padding:0}.hero .pill{border:1px solid #999;background:none}.card{box-shadow:none;border:1px solid #ddd;break-inside:avoid}.pull{margin-top:0}.print,#answer{display:none}.brand img{background:none}}
</style></head><body>
<div class="hero"><div class="wrap"><div class="brand">${b.logoUrl ? `<img src="${esc(b.logoUrl)}" alt="">` : ''}<div><strong>${esc(b.name)}</strong>${where ? `<span>${esc(where)}</span>` : ''}${b.phone ? `<span>${esc(b.phone)}</span>` : ''}</div></div>
<h1>${esc(d.title || 'Your stay quotation')}</h1><p>Quotation ${esc(d.number)} · prepared ${esc(day(d.issued))}</p><span class="pill">Valid until ${esc(day(d.validUntil))}</span></div></div>
<div class="wrap">
<section class="card pull for"><div><span class="k">Prepared for</span><strong>${esc(d.customerName)}</strong>${d.contactName ? `<div class="muted">Attn: ${esc(d.contactName)}</div>` : ''}</div>
<div><span class="k">Rooms</span><strong>${d.pricing.lines.reduce((a, l) => a + l.rooms, 0)} room${d.pricing.lines.reduce((a, l) => a + l.rooms, 0) === 1 ? '' : 's'}</strong><div class="muted">${totalNights} room-night${totalNights === 1 ? '' : 's'}</div></div>
<div><span class="k">Total</span><strong>${esc(money(tot.total, cur))}</strong><div class="muted">including tax</div></div></section>
${lines}${amen}${req}
<section class="card totals"><h2>Summary</h2>
<div class="row"><span>Rooms and nights</span><span>${esc(money(tot.gross, cur))}</span></div>
${hasDisc ? `<div class="row disc"><span>Discount${d.discountReason ? ` — ${esc(d.discountReason)}` : ''}</span><span>− ${esc(money(tot.discount, cur))}</span></div>` : ''}
<div class="row"><span>Price before tax</span><span>${esc(money(tot.net, cur))}</span></div><div class="row"><span>Taxes</span><span>${esc(money(tot.tax, cur))}</span></div>
<div class="row grand"><span>Total</span><span>${esc(money(tot.total, cur))}</span></div>${hasDisc ? `<div class="saving">You save ${esc(money(tot.discount, cur))} on this stay</div>` : ''}${dep}</section>
${state}
${d.terms ? `<section class="card terms"><h2>Terms and conditions</h2><p class="pre">${esc(d.terms)}</p></section>` : ''}
<div class="print"><button type="button" id="p">Print or save as PDF</button></div>
<footer>${b.footer ? `${esc(b.footer)}<br>` : ''}${esc(b.name)}</footer></div>
<script nonce="${esc(nonce)}">document.getElementById('p').addEventListener('click',function(){window.print();});</script>${script}
</body></html>`;
}
