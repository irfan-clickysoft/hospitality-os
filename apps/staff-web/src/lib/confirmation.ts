/** The WhatsApp booking confirmation a guest receives. Always in English, in the hotel's agreed wording. */
export interface ConfirmationInput {
  guestName: string; salutation: '' | 'Mr.' | 'Mrs.'; manager: string; propertyName: string; city?: string | null;
  confirmationNo: string; arrival: string; departure: string; checkInTime?: string; checkOutTime?: string; mapsUrl?: string | null;
  /** The guest's private booking page, when there is one. */
  bookingUrl?: string | null;
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
/** "2026-10-22" → "22 October 2026". */
export const longDate = (d: string) => dateFmt.format(new Date(`${d}T00:00:00Z`));
/** "14:00" → "2:00 PM". */
export function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${(h! % 12) || 12}:${String(m ?? 0).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`;
}

export function confirmationText(i: ConfirmationInput): string {
  const where = i.city ? `${i.propertyName}, ${i.city}` : i.propertyName;
  const at = (d: string, t?: string) => (t ? `${longDate(d)} at ${clock12(t)}` : longDate(d));
  return [
    `Dear ${i.salutation ? `${i.salutation} ` : ''}${i.guestName},`,
    '',
    `Greetings from ${where}.`,
    '',
    `This is ${i.manager}. We are pleased to confirm your reservation:`,
    '',
    `Booking reference: ${i.confirmationNo}`,
    `Check-in: ${at(i.arrival, i.checkInTime)}`,
    `Check-out: ${at(i.departure, i.checkOutTime)}`,
    ...(i.mapsUrl ? [`Location: ${i.mapsUrl}`] : []),
    ...(i.bookingUrl ? [`Booking details and requests: ${i.bookingUrl}`] : []),
    '',
    'We look forward to welcoming you. If you need any assistance before your arrival, please reply to this message.',
    '',
    'Warm regards,',
    i.manager,
    where,
  ].join('\n');
}
