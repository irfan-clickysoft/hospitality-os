/** Printable guest registration card: a self-contained HTML page (print to paper or PDF) with lines for the guest's and the clerk's signatures. Every dynamic value is escaped. */
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const ID: Record<string, string> = { CNIC: 'CNIC', NICOP: 'NICOP', PASSPORT: 'Passport', DRIVING_LICENSE: 'Driving licence', OTHER: 'Other ID' };

const TYPE: Record<string, string> = { PAKISTANI_ADULT: 'Pakistani adult', OVERSEAS_PAKISTANI: 'Overseas Pakistani', POC_HOLDER: 'POC holder', FOREIGN_ADULT: 'Foreign adult', PAKISTANI_MINOR: 'Pakistani minor', FOREIGN_MINOR: 'Foreign minor' };
const DOC: Record<string, string> = { CNIC_OR_PASSPORT: 'CNIC or passport', NICOP: 'NICOP', PASSPORT: 'Passport', FOREIGN_PASSPORT: 'Passport', PASSPORT_BIO_COPY: 'Passport bio-page copy', POC: 'POC', ENTRY_STATUS_EVIDENCE: 'Entry-status evidence', VISA_BASIS: 'Visa / eVisa / ETA / exemption',
  ENTRY_STAMP: 'Entry stamp', MINOR_ID: 'Passport / CRC / B-Form / Juvenile card', GUARDIAN_ID: 'Guardian’s ID', COMPANY_LETTER: 'Company letter / employee card' };
const FOREIGN: Array<[string, string]> = [['passportIssuePlace', 'Passport issued at'], ['visaType', 'Visa / entry permission'], ['stayExpiry', 'Permitted stay until'], ['entryDate', 'Entered Pakistan on'], ['entryPort', 'Port of entry'], ['localAddress', 'Local address'], ['nextDestination', 'Next destination'],
  ['formCRef', 'Form C'], ['residentialPermitRef', 'Residential permit'], ['remarks', 'Remarks']];
const docLine = (g: CardView['guests'][number]) => Object.entries(g.documents ?? {}).map(([k, d]) => `${esc(DOC[k] ?? k)}: ${d.state === 'SEEN' ? 'seen' : `not available${d.note ? ` (${esc(d.note)})` : ''}`}`).join(' · ');
const foreignLine = (g: CardView['guests'][number]) => FOREIGN.filter(([k]) => g.foreign?.[k]).map(([k, label]) => `${label}: ${esc(g.foreign![k])}`).join(' · ') + (g.foreign?.froInstruction ? ' · FRO-registration instruction on passport' : '');

const money = (minor: string | bigint, cur: string): string => { const n = BigInt(minor); const neg = n < 0n; const a = neg ? -n : n; const w = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); const f = (a % 100n).toString().padStart(2, '0'); return `${neg ? '−' : ''}${cur} ${w}${f === '00' ? '' : `.${f}`}`; };

/** Shown on the card when the property has not written its own rules. */
export const DEFAULT_RULES = `1. Check-in and check-out follow the times printed on this card; late departure may be charged.
2. A valid photo ID (CNIC, NICOP or passport) is required for every adult guest; foreign guests are registered with the authorities as the law requires.
3. Only the guests named on this card may stay in the room. Visitors must leave by 10 pm.
4. Smoking is not allowed inside the rooms; a cleaning charge applies.
5. Guests are responsible for damage to or loss of hotel property during their stay.
6. The hotel is not responsible for valuables left in the room; please use the safe.
7. Please keep noise low between 10 pm and 7 am.
8. Illegal items, weapons and unlawful activity are not allowed on the premises.
9. Rent is payable in advance or as agreed; taxes are added as applicable. The balance is settled at check-out.
10. Cancellation and refund terms follow the booking confirmation.`;

export interface CardView {
  company: string; property: string; confirmationNo: string; room: string | null; roomType: string; arrival: string; departure: string; adults: number; children: number; printedOn: string; idRevealed: boolean;
  guestName?: string; guestPhone?: string | null; purpose?: string | null; checkInTime?: string; checkOutTime?: string; checkedInAt?: string | null; rules?: string;
  rent?: { currency: string; nights: number; bands: Array<{ nights: number; rateMinor: string }>; subtotalMinor: string; discountMinor: string; totalMinor: string; advanceMinor: string };
  signature?: { image: string; signedAt: string | null; name: string | null } | null;
  guests: Array<{ fullName: string; isPrimary: boolean; ageGroup: string; relationship?: string | null; idType: string | null; idNumber: string | null; nationality: string | null; idExpiry: string | null; guestType?: string | null; documents?: Record<string, { state: string; note?: string | null }>; foreign?: Record<string, unknown> | null }>;
  /** Whether every required document was seen. */ complete?: boolean;
}

export function renderRegistrationCard(v: CardView): string {
  const rows = v.guests.map((g, i) => `<tr><td>${i + 1}</td><td>${esc(g.fullName)}${g.isPrimary ? ' <span class="muted">(main guest)</span>' : g.relationship ? `<br><span class="muted">${esc(g.relationship)} of main guest</span>` : ''}</td><td>${g.ageGroup === 'CHILD' ? 'Child' : 'Adult'}${g.guestType ? `<br><span class="muted">${esc(TYPE[g.guestType] ?? g.guestType)}</span>` : ''}</td><td>${esc(g.nationality ?? '')}</td><td>${g.idType ? `${esc(ID[g.idType] ?? g.idType)} ${esc(g.idNumber ?? '')}` : g.ageGroup === 'CHILD' ? '<span class="muted">Child — no ID</span>' : '<span class="muted">Covered by the main guest’s ID</span>'}${g.idExpiry ? `<br><span class="muted">expires ${esc(g.idExpiry)}</span>` : ''}</td></tr>${(g.documents && Object.keys(g.documents).length) || g.foreign ? `<tr><td></td><td colspan="4" class="muted">${[docLine(g) && `Documents — ${docLine(g)}`, foreignLine(g) && `Foreign guest record — ${foreignLine(g)}`].filter(Boolean).join('<br>')}</td></tr>` : ''}`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Registration card ${esc(v.confirmationNo)}</title>
<style>
@page { size: A4; margin: 16mm; } body { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1d2a30; max-width: 760px; margin: 0 auto; padding: 16px; }
h1 { font-size: 20px; margin: 0; letter-spacing: .04em; } .head { border-bottom: 2px solid #1d2a30; padding-bottom: 10px; margin-bottom: 14px; } .muted { color: #5d6b72; }
table { width: 100%; border-collapse: collapse; margin: 10px 0; } th, td { text-align: left; padding: 6px; border-bottom: 1px solid #dcd7cb; vertical-align: top; } th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #5d6b72; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; margin: 8px 0; } .two div { padding: 4px 0; border-bottom: 1px solid #eee9de; }
.sign { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; margin-top: 24px; align-items: end; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; margin: 18px 0 6px; } .rules { white-space: pre-line; font-size: 12px; border: 1px solid #dcd7cb; padding: 8px 10px; } .num { text-align: right; white-space: nowrap; } .sigimg { display: block; height: 70px; max-width: 100%; } .line { border-top: 1px solid #1d2a30; padding-top: 4px; }
@media print { body { padding: 0; } }
</style></head><body>
<div class="head"><h1>GUEST REGISTRATION CARD</h1><div class="muted">${esc(v.company)} · ${esc(v.property)}</div></div>
<div class="two"><div><span class="muted">Guest name</span><br><strong>${esc(v.guestName ?? '')}</strong>${v.guestPhone ? ` · ${esc(v.guestPhone)}` : ''}</div><div><span class="muted">Booking</span><br><strong>${esc(v.confirmationNo)}</strong></div>
<div><span class="muted">Room</span><br><strong>${esc(v.room ?? 'not yet assigned')}</strong> · ${esc(v.roomType)}</div><div><span class="muted">Guests</span><br>${esc(v.adults)} adult(s)${v.children ? `, ${esc(v.children)} child(ren)` : ''}</div>
<div><span class="muted">Arrival</span><br>${esc(v.arrival)}${v.checkInTime ? ` · check-in from ${esc(v.checkInTime.slice(0, 5))}` : ''}</div><div><span class="muted">Departure</span><br>${esc(v.departure)}${v.checkOutTime ? ` · check-out by ${esc(v.checkOutTime.slice(0, 5))}` : ''}</div>
${v.rent ? `<div><span class="muted">Total nights</span><br><strong>${esc(v.rent.nights)}</strong></div>` : ''}<div><span class="muted">Purpose of visit</span><br>${esc(v.purpose ?? '—')}</div>
${v.checkedInAt ? `<div><span class="muted">Checked in at</span><br>${esc(v.checkedInAt.slice(0, 16))}</div>` : ''}</div>
<table><thead><tr><th>#</th><th>Name</th><th>Age</th><th>Nat.</th><th>Identity document</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No guests registered yet</td></tr>'}</tbody></table>
${v.rent ? (() => { const r = v.rent, c = r.currency, bal = BigInt(r.totalMinor) - BigInt(r.advanceMinor); return `<h2>Rent and payment</h2><table class="rent"><tbody>${r.bands.map((b) => `<tr><td>${esc(b.nights)} night(s) × ${esc(money(b.rateMinor, c))}</td><td class="num">${esc(money(BigInt(b.rateMinor) * BigInt(b.nights), c))}</td></tr>`).join('')}
${BigInt(r.discountMinor) > 0n ? `<tr><td>Discount</td><td class="num">− ${esc(money(r.discountMinor, c))}</td></tr>` : ''}<tr><td><strong>Total rent (${esc(r.nights)} night(s))</strong> <span class="muted">· taxes as applicable</span></td><td class="num"><strong>${esc(money(r.totalMinor, c))}</strong></td></tr>
<tr><td>Advance received</td><td class="num">${esc(money(r.advanceMinor, c))}</td></tr><tr><td><strong>Balance</strong></td><td class="num"><strong>${esc(money(bal > 0n ? bal : 0n, c))}</strong></td></tr></tbody></table>`; })() : ''}
${v.complete === false ? '<p class="muted"><strong>Registration incomplete:</strong> some required documents were not seen. See the front desk.</p>' : ''}
${v.idRevealed ? '' : '<p class="muted">Identity numbers are shown with only the last digits. Anyone with permission can print the full numbers, which needs the second factor and is recorded.</p>'}
<h2>Rules &amp; policies</h2><div class="rules">${esc(v.rules ?? DEFAULT_RULES)}</div>
<p>I have read and accept the rules and policies above, and the details on this card are correct.</p>
<div class="sign"><div>${v.signature ? `<img class="sigimg" alt="Guest signature" src="${esc(v.signature.image)}">` : ''}<div class="line">Guest signature${v.signature ? ` — ${esc(v.signature.name ?? '')}<br><span class="muted">signed on screen ${esc((v.signature.signedAt ?? '').slice(0, 16))}</span>` : ''}</div></div><div class="line">Front desk</div></div>
<p class="muted" style="margin-top:28px">Printed ${esc(v.printedOn)}.</p>
</body></html>`;
}
