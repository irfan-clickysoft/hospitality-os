import type { Brand } from '../documents/render.js';
import type { QuoteSettings } from './defaults.js';
import type { Pricing } from './service.js';

/**
 * The quotation the customer opens, laid out the way Sunset BnB writes them: who it is for and the booking details, a greeting, the stay, the rooms with their rates, the totals
 * (discount, tax, grand total, advance and balance), where the hotel is, what is included, a closing note with contacts, and the terms. One self-contained, printable page in the hotel's
 * own look. Every dynamic value is escaped, there is no external file, and the only script is the print button and the accept / decline form, which carry the response's nonce.
 */
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (minor: string | bigint, cur: string): string => { const n = BigInt(minor); const neg = n < 0n; const a = (neg ? -n : n); const w = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); const f = (a % 100n).toString().padStart(2, '0'); return `${neg ? '−' : ''}${cur} ${w}${f === '00' ? '' : `.${f}`}`; };
const plain = (minor: string | bigint): string => { const n = BigInt(minor); const a = n < 0n ? -n : n; const w = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); const f = (a % 100n).toString().padStart(2, '0'); return `${w}${f === '00' ? '' : `.${f}`}`; };
const day = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const safeColor = (c: string) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : '#1d4e5f');
const link = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);
const BREAKFAST = new Set(['BREAKFAST', 'HALF_BOARD', 'FULL_BOARD']);
const MEAL: Record<string, string> = { BREAKFAST: 'with breakfast', HALF_BOARD: 'half board', FULL_BOARD: 'full board' };
const para = (t: string) => esc(t).replace(/\n/g, '<br>');

export interface QuotationPage { number: string; status: string; expired: boolean; customerName: string; contactName: string | null; address: string | null; phone: string | null; email: string | null; customerRef: string | null; title: string | null;
  validUntil: string; issued: string; discountReason: string | null; specialRequests: string | null; amenities: string[]; terms: string | null; pricing: Pricing; balanceDueDays: number | null; depositKind: string; depositPct: number | null;
  settings: QuoteSettings; property: { address: string | null; city: string | null; phone: string | null; mapsUrl: string | null };
  response: { at: string; name: string | null; note: string | null; accepted: boolean } | null; interactive: boolean }

export function renderQuotation(b: Brand, d: QuotationPage, nonce: string): string {
  const cur = d.pricing.currency; const color = safeColor(b.color); const tot = d.pricing; const st = d.settings;
  const where = [b.address, b.city].filter(Boolean).join(', ');
  const first = tot.lines.map((l) => l.arrival).sort()[0]!; const last = tot.lines.map((l) => l.departure).sort().slice(-1)[0]!;
  const guests = tot.lines.reduce((a, l) => a + l.rooms * (l.adults + l.children), 0); const nightsAll = tot.lines.every((l) => l.arrival === tot.lines[0]!.arrival && l.departure === tot.lines[0]!.departure) ? tot.lines[0]!.nights : null;
  const hasDisc = BigInt(tot.discount) > 0n; const depositAmt = BigInt(tot.deposit.amount); const balance = BigInt(tot.total) - depositAmt;
  const balanceDate = d.balanceDueDays !== null && d.balanceDueDays !== undefined ? addDays(first, -d.balanceDueDays) : null;
  const advLabel = d.depositKind === 'PCT' && d.depositPct !== null ? `${d.depositPct}% advance at the time of booking` : 'Advance at the time of booking';
  const balLabel = balance <= 0n ? '' : balanceDate && balanceDate > d.issued ? `Balance by ${day(balanceDate)}${d.balanceDueDays ? ` (${d.balanceDueDays} days before check-in)` : ''}` : 'Balance at check-in';
  const rows = tot.lines.flatMap((l) => l.bands.map((g, k) => {
    const desc = `${esc(l.roomTypeName)}${l.roomNumbers ? ` no ${esc(l.roomNumbers)}` : ''} (${l.adults + l.children} guest${l.adults + l.children === 1 ? '' : 's'})${MEAL[l.mealPlan ?? ''] ? ` ${MEAL[l.mealPlan!]}` : ''}${g.label ? ` <em>${esc(g.label)}</em>` : ''}`;
    return `<tr><td class="n" data-l="Nights">${g.nights}</td><td data-l="Room / rate">${desc}${k === 0 && l.note ? `<div class="sub">${esc(l.note)}</div>` : ''}${k === 0 && l.warning ? `<div class="sub warn">${esc(l.warning)}</div>` : ''}</td><td class="r" data-l="Per night">${esc(plain(g.rate))}</td><td class="n" data-l="Rooms">${l.rooms}</td><td class="r" data-l="Line total">${esc(plain(BigInt(g.rate) * BigInt(g.nights) * BigInt(l.rooms)))}</td></tr>`;
  })).join('');
  const taxRows = tot.taxLines.length ? tot.taxLines.filter((x) => BigInt(x.amount) > 0n).map((x) => `<div class="row"><span>${esc(x.label)}</span><span>${esc(plain(x.amount))}</span></div>`).join('') : '';
  const mapUrl = link(d.property.mapsUrl);
  const loc = [d.settings.locationNote ?? [b.name, d.property.address, d.property.city].filter(Boolean).join(', ')].filter(Boolean).join('');
  const contact = [st.contactPhone ?? b.phone ? `Phone / WhatsApp: ${esc(st.contactPhone ?? b.phone)}` : '', st.contactEmail ? `Email: ${esc(st.contactEmail)}` : '', st.website ? `Website: ${esc(st.website)}` : ''].filter(Boolean).join(' &nbsp;·&nbsp; ');
  const amen = [...new Set([...st.amenities, ...d.amenities])];
  const terms = d.terms ? `<p class="pre">${esc(d.terms)}</p>` : st.terms.length ? `<ol class="tc">${st.terms.map((x) => `<li><strong>${esc(x.title)}</strong><br>${esc(x.body)}</li>`).join('')}</ol>${st.taxNote ? `<p class="tc-note"><strong>Tax note.</strong> ${esc(st.taxNote)}</p>` : ''}` : '';
  const state = d.response ? `<section class="card answer ${d.response.accepted ? 'ok' : 'no'}"><h2>${d.response.accepted ? 'Thank you — you accepted this quotation' : 'You declined this quotation'}</h2><p>${esc(d.response.name ?? '')} · ${esc(day(d.response.at))}</p>${d.response.note ? `<p class="pre">${esc(d.response.note)}</p>` : ''}${d.response.accepted ? '<p class="muted">The hotel has been told and will be in touch to confirm your booking.</p>' : ''}</section>`
    : d.status === 'DRAFT' ? `<section class="card answer"><h2>This quotation is being updated</h2><p class="muted">Please check back shortly or contact the hotel.</p></section>`
    : d.expired ? `<section class="card answer no"><h2>This quotation has expired</h2><p class="muted">It was valid until ${esc(day(d.validUntil))}. Please contact the hotel for a new one.</p></section>`
    : d.interactive ? `<section class="card answer" id="answer"><h2>Would you like to go ahead?</h2><p class="muted">Accepting lets the hotel know. We then confirm your booking${depositAmt > 0n ? ' once the advance is received' : ''}.</p>
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
.wrap{max-width:860px;margin:0 auto;padding:0 16px 48px}.muted{color:var(--muted)}.pre{white-space:pre-wrap}
.hero{background:linear-gradient(135deg,var(--brand),color-mix(in srgb,var(--brand) 55%,#000));color:#fff;padding:26px 0 62px}.hero .wrap{padding-bottom:0}
.top{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-start}.brand{display:flex;gap:14px;align-items:center}.brand img{max-height:52px;max-width:120px;object-fit:contain;background:#fff;border-radius:12px;padding:6px}.brand strong{font-size:1.15rem;letter-spacing:-.01em}.brand span{display:block;opacity:.85;font-size:.85rem}
.hero h1{margin:24px 0 4px;font-size:clamp(1.7rem,5vw,2.4rem);letter-spacing:-.03em;line-height:1.1}.hero p{margin:0;opacity:.92}.pill{display:inline-block;margin-top:14px;padding:5px 14px;border-radius:999px;background:rgba(255,255,255,.18);font-weight:600;font-size:.85rem}
.card{background:var(--card);border-radius:22px;box-shadow:0 1px 2px rgba(20,32,42,.05),0 8px 28px rgba(20,32,42,.07);padding:22px;margin:16px 0}.pull{margin-top:-38px}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.kv{display:grid;grid-template-columns:120px 1fr;gap:6px 12px;margin:0}.kv dt{color:var(--muted);font-size:.85rem}.kv dd{margin:0;font-weight:550;word-break:break-word}
h2{margin:0 0 12px;font-size:.78rem;text-transform:uppercase;letter-spacing:.1em;color:var(--brand)}.greet{font-size:1.02rem}
.stay{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}.stay div{background:var(--bg);border-radius:14px;padding:12px 14px}.stay .k{display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600}.stay strong{font-size:1.05rem}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);padding:8px 8px;border-bottom:2px solid var(--line)}td{padding:12px 8px;border-bottom:1px solid var(--line);vertical-align:top}.r{text-align:right;font-variant-numeric:tabular-nums}.n{text-align:center;font-variant-numeric:tabular-nums}th.r{text-align:right}th.n{text-align:center}
td em{font-style:normal;margin-inline-start:6px;padding:1px 9px;border-radius:999px;background:color-mix(in srgb,var(--brand) 14%,#fff);color:var(--brand);font-size:.76rem;font-weight:650;white-space:nowrap}.sub{color:var(--muted);font-size:.85rem;margin-top:3px}.sub.warn{color:#a35d00}
.totals{margin-top:14px;margin-inline-start:auto;max-width:380px}.row{display:flex;justify-content:space-between;gap:12px;padding:6px 2px;font-variant-numeric:tabular-nums}.row.disc{color:#1e7a46;font-weight:600}.row.grand{border-top:2px solid var(--brand);margin-top:6px;padding-top:12px;font-size:1.3rem;font-weight:750;letter-spacing:-.02em}
.row.adv{font-weight:650}.row.adv span:last-child{color:var(--brand)}.saving{margin-top:10px;padding:10px 14px;border-radius:12px;background:#e6f4ea;color:#1e6b3a;font-weight:600}
.terms-pay{margin:6px 0 0;padding:12px 14px;border-radius:14px;background:color-mix(in srgb,var(--brand) 8%,#fff);font-size:.92rem}
.chips{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}.chips li{padding:7px 14px;border-radius:999px;background:color-mix(in srgb,var(--brand) 10%,#fff);font-weight:550;font-size:.9rem}.chips li::before{content:"✓";color:var(--brand);margin-inline-end:7px;font-weight:700}
.maplink{display:inline-block;margin-top:6px;color:var(--brand);font-weight:650}.sign{white-space:pre-line;margin-top:14px}
.answer h2{color:var(--ink);font-size:1.15rem;text-transform:none;letter-spacing:-.01em}.answer.ok{background:#e9f6ee}.answer.no{background:#fbeceb}
form{display:grid;gap:12px;margin-top:12px}label{display:grid;gap:5px;font-weight:600;font-size:.9rem}input,textarea{font:inherit;padding:12px 14px;border:1px solid #b9c2cc;border-radius:12px;background:#fff}input:focus,textarea:focus{outline:3px solid color-mix(in srgb,var(--brand) 35%,transparent);border-color:var(--brand)}
.btns{display:flex;gap:10px;flex-wrap:wrap}button{font:inherit;font-weight:650;padding:13px 22px;border-radius:14px;border:0;cursor:pointer}.go{background:var(--brand);color:#fff;flex:1 1 200px;box-shadow:0 4px 14px color-mix(in srgb,var(--brand) 40%,transparent)}.stop{background:#eef1f5;color:var(--ink)}
.tc{margin:0;padding-inline-start:20px;display:grid;gap:10px;font-size:.88rem;color:var(--muted)}.tc strong{color:var(--ink)}.tc-note{font-size:.88rem;color:var(--muted)}.print{text-align:center;margin:8px 0}.print button{background:transparent;color:var(--brand);border:1px solid var(--brand)}
footer{text-align:center;color:var(--muted);font-size:.82rem;margin-top:26px}
@media(max-width:640px){thead{display:none}tr{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:10px 0;border-bottom:1px solid var(--line)}td{border:0;padding:2px 0;text-align:left}td.n,td.r{text-align:left}td[data-l]::before{content:attr(data-l) ": ";color:var(--muted);font-size:.78rem}td:nth-child(2){grid-column:1/-1;font-weight:600}td:nth-child(2)::before{content:""}}
@media print{body{background:#fff}.hero{background:none!important;color:#000;padding:0}.hero .pill{border:1px solid #999;background:none}.card{box-shadow:none;border:1px solid #ddd;break-inside:avoid}.pull{margin-top:0}.print,#answer{display:none}.brand img{background:none}}
</style></head><body>
<div class="hero"><div class="wrap"><div class="top"><div class="brand">${b.logoUrl ? `<img src="${esc(b.logoUrl)}" alt="">` : ''}<div><strong>${esc(b.name)}</strong>${where ? `<span>${esc(where)}</span>` : ''}</div></div><span class="pill">Valid until ${esc(day(d.validUntil))}</span></div>
<h1>${esc(d.title || 'Booking Quotation')}</h1><p>Quotation ${esc(d.number)} · ${esc(day(d.issued))}</p></div></div>
<div class="wrap">
<section class="card pull two"><div><h2>Guest details</h2><dl class="kv"><dt>To</dt><dd>${esc(d.customerName)}${d.contactName ? `<br><span class="muted">Attn: ${esc(d.contactName)}</span>` : ''}</dd>${d.address ? `<dt>Address</dt><dd>${esc(d.address)}</dd>` : ''}${d.phone ? `<dt>Phone</dt><dd>${esc(d.phone)}</dd>` : ''}${d.email ? `<dt>Email</dt><dd>${esc(d.email)}</dd>` : ''}</dl></div>
<div><h2>Booking details</h2><dl class="kv"><dt>Date</dt><dd>${esc(day(d.issued))}</dd><dt>Booking ref #</dt><dd>${esc(d.number)}</dd>${d.customerRef ? `<dt>Customer ID</dt><dd>${esc(d.customerRef)}</dd>` : ''}<dt>Payment terms</dt><dd>${depositAmt > 0n ? `${esc(advLabel)}${balLabel ? `<br>${esc(balLabel)}` : ''}` : esc(balLabel || 'Payment at check-in')}</dd></dl></div></section>
<section class="card"><p class="greet">${para(st.greeting)}</p>
<div class="stay"><div><span class="k">Check in</span><strong>${esc(day(first))}</strong></div><div><span class="k">Check out</span><strong>${esc(day(last))}</strong></div>${nightsAll !== null ? `<div><span class="k">Nights</span><strong>${nightsAll}</strong></div>` : ''}<div><span class="k">Guests</span><strong>${guests}</strong></div></div></section>
<section class="card"><table><thead><tr><th class="n">Nights</th><th>Room / rate description</th><th class="r">Unit price / night</th><th class="n"># of rooms</th><th class="r">Line total</th></tr></thead><tbody>${rows}</tbody></table>
<div class="totals"><div class="row"><span>Total</span><span>${esc(money(tot.gross, cur))}</span></div>${hasDisc ? `<div class="row disc"><span>Special discount${d.discountReason ? ` — ${esc(d.discountReason)}` : ''}</span><span>− ${esc(plain(tot.discount))}</span></div>` : ''}${taxRows}
<div class="row grand"><span>Grand total</span><span>${esc(money(tot.total, cur))}</span></div>${depositAmt > 0n ? `<div class="row adv"><span>Advance${d.depositKind === 'PCT' && d.depositPct !== null ? ` (${d.depositPct}%)` : ''}</span><span>${esc(plain(depositAmt))}</span></div><div class="row"><span>Balance</span><span>${esc(plain(balance))}</span></div>` : ''}
${hasDisc ? `<div class="saving">You save ${esc(money(tot.discount, cur))} on this stay</div>` : ''}</div>
${depositAmt > 0n ? `<p class="terms-pay"><strong>${esc(advLabel)}: ${esc(money(depositAmt, cur))}.</strong>${balLabel ? ` ${esc(balLabel)}: ${esc(money(balance, cur))}.` : ''} We confirm the rooms once the advance is received.</p>` : ''}</section>
${loc || mapUrl ? `<section class="card"><h2>Location</h2><p>${esc(loc)}</p>${mapUrl ? `<a class="maplink" href="${esc(mapUrl)}" rel="noopener noreferrer" target="_blank">Open the map</a>` : ''}</section>` : ''}
${amen.length ? `<section class="card"><h2>Amenities included</h2><ul class="chips">${amen.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></section>` : ''}
${d.specialRequests ? `<section class="card"><h2>Your special requests</h2><p class="pre">${esc(d.specialRequests)}</p></section>` : ''}
${state}
<section class="card"><p>${para(st.closing)}</p>${contact ? `<p>${contact}</p>` : ''}<p class="sign">${esc(st.signoff)}</p></section>
${terms ? `<section class="card"><h2>Booking terms &amp; conditions</h2>${terms}</section>` : ''}
<div class="print"><button type="button" id="p">Print or save as PDF</button></div>
<footer>${b.footer ? `${esc(b.footer)}<br>` : ''}${esc(b.name)}</footer></div>
<script nonce="${esc(nonce)}">document.getElementById('p').addEventListener('click',function(){window.print();});</script>${script}
</body></html>`;
}
