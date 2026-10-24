import { z } from 'zod';

/** The wording around a quotation's figures. Each hotel writes its own (Administration → Property → Quotation wording); until it does, this is used. It follows the layout Sunset BnB already sends. */
export interface QuoteSettings {
  greeting: string; closing: string; signoff: string; contactPhone: string | null; contactEmail: string | null; website: string | null;
  locationNote: string | null; amenities: string[]; taxNote: string | null; advancePct: number; balanceDays: number | null;
  terms: Array<{ title: string; body: string }>;
}

export const DEFAULT_TERMS: Array<{ title: string; body: string }> = [
  { title: 'Reservation confirmation', body: 'All bookings are confirmed only upon receipt of the advance shown in this quotation (or full payment), as specified in the quote.' },
  { title: 'Payment terms', body: 'The balance is paid on or before the date shown in this quotation. Accepted payment methods: cash, bank transfer, credit/debit card, or approved digital wallets.' },
  { title: 'Check-in / check-out', body: 'Check-in: 2:00 PM onwards. Check-out: 12:00 PM noon. Early check-in or late check-out is subject to availability and may incur additional charges.' },
  { title: 'Cancellation policy', body: 'Cancellation 30 or more days before arrival: 75% of the advance is refunded. Cancellation 14 to 30 days before arrival: 50% of the booking amount is retained. Cancellation within 14 days of arrival: no refund. No-shows are charged in full.' },
  { title: 'Amendments', body: 'Changes to a booking (dates, number of guests and so on) are subject to availability and must be requested at least 7 days before arrival. Additional charges may apply.' },
  { title: 'Guest responsibilities', body: 'Guests are responsible for any damage caused to the property, furnishings or equipment during their stay. The management may recover the cost of repairs or replacements.' },
  { title: 'Maximum occupancy', body: 'Each room has a defined maximum occupancy. An additional mattress or person is charged at the rate shown by the hotel. Exceeding the occupancy without prior approval may result in cancellation of the booking without refund.' },
  { title: 'House rules', body: 'No smoking inside rooms. Pets are not allowed unless agreed. Quiet hours are from 10:00 PM to 7:00 AM.' },
  { title: 'Force majeure', body: 'The hotel is not liable for cancellations or changes caused by events beyond its control (natural disasters, government regulations, strikes, pandemics and the like).' },
  { title: 'Acceptance of terms', body: 'By confirming the booking and making payment, the guest acknowledges and agrees to these terms and conditions.' },
];

export const DEFAULT_SETTINGS: QuoteSettings = {
  greeting: 'Greetings from {property}! We are delighted to prepare this quotation and look forward to welcoming you. Below are your booking details:',
  closing: 'Your comfort is our priority, and we are committed to providing you with an exceptional stay. Should you have any special requests or require further assistance, please do not hesitate to contact us. We look forward to hosting you and making your stay a memorable one.',
  signoff: 'Best regards,\n{property} Reservations Team',
  contactPhone: null, contactEmail: null, website: null, locationNote: null,
  amenities: ['Complimentary Wi-Fi', 'Daily housekeeping', 'Complimentary breakfast'],
  taxNote: null, advancePct: 50, balanceDays: 30, terms: DEFAULT_TERMS,
};

const line = (n: number) => z.string().trim().max(n);
export const QuoteSettingsBody = z.object({
  greeting: line(1000), closing: line(1500), signoff: line(300), contactPhone: line(60).nullish(), contactEmail: z.string().trim().email().max(254).nullish().or(z.literal('')), website: line(120).nullish(),
  locationNote: line(600).nullish(), amenities: z.array(line(80).min(1)).max(30), taxNote: line(300).nullish(), advancePct: z.number().min(0).max(100), balanceDays: z.number().int().min(0).max(365).nullable(),
  terms: z.array(z.object({ title: line(120).min(1), body: line(1200).min(1) })).max(30),
}).strict();

/** The property's own wording over the built-in one, with {property} filled in. */
export function mergeSettings(stored: unknown, property: string): QuoteSettings {
  const s = { ...DEFAULT_SETTINGS, ...((stored && typeof stored === 'object' ? stored : {}) as Partial<QuoteSettings>) };
  const fill = (t: string) => t.replace(/\{property\}/g, property);
  return { ...s, greeting: fill(s.greeting), closing: fill(s.closing), signoff: fill(s.signoff), contactEmail: s.contactEmail || null };
}
