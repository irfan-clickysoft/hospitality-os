/** The standard reasons a booking is cancelled or becomes a no-show, and who is taken to have started it. The desk picks one; the wording they add is kept as the note. */
export const INITIATORS = ['GUEST', 'PROPERTY', 'CHANNEL', 'COMPANY', 'SYSTEM'] as const;
export type Initiator = (typeof INITIATORS)[number];
export const CANCEL_REASONS = {
  PLANS_CHANGED: 'GUEST', FOUND_ELSEWHERE: 'GUEST', TRAVEL_DISRUPTION: 'GUEST', ILLNESS_EMERGENCY: 'GUEST', TRIP_CANCELLED: 'GUEST', DUPLICATE: 'GUEST',
  PAYMENT_NOT_MADE: 'PROPERTY', OVERBOOKED: 'PROPERTY', ROOM_UNAVAILABLE: 'PROPERTY',
  CHANNEL_CANCELLED: 'CHANNEL', COMPANY_CANCELLED: 'COMPANY',
  DID_NOT_ARRIVE: 'GUEST', UNREACHABLE: 'GUEST', OPTION_EXPIRED: 'SYSTEM', OTHER: 'GUEST',
} as const satisfies Record<string, Initiator>;
export type CancelCode = keyof typeof CANCEL_REASONS;
export const CANCEL_CODES = Object.keys(CANCEL_REASONS) as [CancelCode, ...CancelCode[]];
/** The reasons offered when marking a no-show. */
export const NO_SHOW_CODES: CancelCode[] = ['DID_NOT_ARRIVE', 'UNREACHABLE', 'TRAVEL_DISRUPTION', 'OTHER'];
export const LABELS: Record<CancelCode, string> = {
  PLANS_CHANGED: 'Guest changed plans', FOUND_ELSEWHERE: 'Found a better price or place', TRAVEL_DISRUPTION: 'Travel disrupted (flight, road, weather)', ILLNESS_EMERGENCY: 'Illness or emergency', TRIP_CANCELLED: 'Trip or meeting cancelled', DUPLICATE: 'Duplicate booking',
  PAYMENT_NOT_MADE: 'Deposit or payment not made', OVERBOOKED: 'We could not honour it (overbooked)', ROOM_UNAVAILABLE: 'Room unavailable (maintenance or damage)', CHANNEL_CANCELLED: 'Cancelled by the booking channel', COMPANY_CANCELLED: 'Cancelled by the company',
  DID_NOT_ARRIVE: 'Did not arrive', UNREACHABLE: 'Could not be reached', OPTION_EXPIRED: 'Hold expired', OTHER: 'Other',
};
