/** The standard reasons for a cancellation or a no-show and who each is taken to come from (the same list the server keeps). */
export const INITIATORS = ['GUEST', 'PROPERTY', 'CHANNEL', 'COMPANY', 'SYSTEM'] as const;
export type Initiator = (typeof INITIATORS)[number];
export const REASON_INITIATOR = {
  PLANS_CHANGED: 'GUEST', FOUND_ELSEWHERE: 'GUEST', TRAVEL_DISRUPTION: 'GUEST', ILLNESS_EMERGENCY: 'GUEST', TRIP_CANCELLED: 'GUEST', DUPLICATE: 'GUEST', PAYMENT_NOT_MADE: 'PROPERTY', OVERBOOKED: 'PROPERTY', ROOM_UNAVAILABLE: 'PROPERTY',
  CHANNEL_CANCELLED: 'CHANNEL', COMPANY_CANCELLED: 'COMPANY', DID_NOT_ARRIVE: 'GUEST', UNREACHABLE: 'GUEST', OTHER: 'GUEST',
} as const satisfies Record<string, Initiator>;
export type ReasonCode = keyof typeof REASON_INITIATOR;
export const CANCEL_REASONS: ReasonCode[] = ['PLANS_CHANGED', 'FOUND_ELSEWHERE', 'TRAVEL_DISRUPTION', 'ILLNESS_EMERGENCY', 'TRIP_CANCELLED', 'DUPLICATE', 'PAYMENT_NOT_MADE', 'OVERBOOKED', 'ROOM_UNAVAILABLE', 'CHANNEL_CANCELLED', 'COMPANY_CANCELLED', 'OTHER'];
export const NO_SHOW_REASONS: ReasonCode[] = ['DID_NOT_ARRIVE', 'UNREACHABLE', 'TRAVEL_DISRUPTION', 'OTHER'];
/** The note kept when the desk adds none of their own. */
export const REASON_NOTE: Record<ReasonCode, string> = {
  PLANS_CHANGED: 'Guest changed plans', FOUND_ELSEWHERE: 'Found a better price or place', TRAVEL_DISRUPTION: 'Travel disrupted', ILLNESS_EMERGENCY: 'Illness or emergency', TRIP_CANCELLED: 'Trip or meeting cancelled', DUPLICATE: 'Duplicate booking',
  PAYMENT_NOT_MADE: 'Deposit or payment not made', OVERBOOKED: 'We could not honour the booking', ROOM_UNAVAILABLE: 'Room unavailable', CHANNEL_CANCELLED: 'Cancelled by the booking channel', COMPANY_CANCELLED: 'Cancelled by the company',
  DID_NOT_ARRIVE: 'Guest did not arrive', UNREACHABLE: 'Guest could not be reached', OTHER: 'Other',
};
