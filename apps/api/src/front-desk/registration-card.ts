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

export interface CardView {
  company: string; property: string; confirmationNo: string; room: string | null; roomType: string; arrival: string; departure: string; adults: number; children: number; printedOn: string; idRevealed: boolean;
  guests: Array<{ fullName: string; isPrimary: boolean; ageGroup: string; idType: string | null; idNumber: string | null; nationality: string | null; idExpiry: string | null; guestType?: string | null; documents?: Record<string, { state: string; note?: string | null }>; foreign?: Record<string, unknown> | null }>;
  /** Whether every required document was seen. */ complete?: boolean;
}

export function renderRegistrationCard(v: CardView): string {
  const rows = v.guests.map((g, i) => `<tr><td>${i + 1}</td><td>${esc(g.fullName)}${g.isPrimary ? ' <span class="muted">(booked by)</span>' : ''}</td><td>${g.ageGroup === 'CHILD' ? 'Child' : 'Adult'}${g.guestType ? `<br><span class="muted">${esc(TYPE[g.guestType] ?? g.guestType)}</span>` : ''}</td><td>${esc(g.nationality ?? '')}</td><td>${g.idType ? `${esc(ID[g.idType] ?? g.idType)} ${esc(g.idNumber ?? '')}` : g.ageGroup === 'CHILD' ? '<span class="muted">Child — no ID</span>' : '<span class="muted">Covered by the main guest’s ID</span>'}${g.idExpiry ? `<br><span class="muted">expires ${esc(g.idExpiry)}</span>` : ''}</td></tr>${(g.documents && Object.keys(g.documents).length) || g.foreign ? `<tr><td></td><td colspan="4" class="muted">${[docLine(g) && `Documents — ${docLine(g)}`, foreignLine(g) && `Foreign guest record — ${foreignLine(g)}`].filter(Boolean).join('<br>')}</td></tr>` : ''}`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Registration card ${esc(v.confirmationNo)}</title>
<style>
@page { size: A4; margin: 16mm; } body { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1d2a30; max-width: 760px; margin: 0 auto; padding: 16px; }
h1 { font-size: 20px; margin: 0; letter-spacing: .04em; } .head { border-bottom: 2px solid #1d2a30; padding-bottom: 10px; margin-bottom: 14px; } .muted { color: #5d6b72; }
table { width: 100%; border-collapse: collapse; margin: 10px 0; } th, td { text-align: left; padding: 6px; border-bottom: 1px solid #dcd7cb; vertical-align: top; } th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #5d6b72; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; margin: 8px 0; } .two div { padding: 4px 0; border-bottom: 1px solid #eee9de; }
.sign { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; margin-top: 64px; } .line { border-top: 1px solid #1d2a30; padding-top: 4px; }
@media print { body { padding: 0; } }
</style></head><body>
<div class="head"><h1>GUEST REGISTRATION CARD</h1><div class="muted">${esc(v.company)} · ${esc(v.property)}</div></div>
<div class="two"><div><span class="muted">Booking</span><br><strong>${esc(v.confirmationNo)}</strong></div><div><span class="muted">Room</span><br><strong>${esc(v.room ?? 'not yet assigned')}</strong> · ${esc(v.roomType)}</div>
<div><span class="muted">Arrival</span><br>${esc(v.arrival)}</div><div><span class="muted">Departure</span><br>${esc(v.departure)}</div><div><span class="muted">Guests</span><br>${esc(v.adults)} adult(s)${v.children ? `, ${esc(v.children)} child(ren)` : ''}</div></div>
<table><thead><tr><th>#</th><th>Name</th><th>Age</th><th>Nat.</th><th>Identity document</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No guests registered yet</td></tr>'}</tbody></table>
${v.complete === false ? '<p class="muted"><strong>Registration incomplete:</strong> some required documents were not seen. See the front desk.</p>' : ''}
${v.idRevealed ? '' : '<p class="muted">Identity numbers are shown with only the last digits. Anyone with permission can print the full numbers, which needs the second factor and is recorded.</p>'}
<div class="sign"><div class="line">Guest signature</div><div class="line">Front desk</div></div>
<p class="muted" style="margin-top:28px">Printed ${esc(v.printedOn)}.</p>
</body></html>`;
}
