/** Why a discount was given, and which kind of discount that makes it for reports. */
export const DISCOUNT_REASONS = {
  NEGOTIATED: 'Negotiated', CORPORATE: 'Negotiated', LONG_STAY: 'Negotiated', LOYALTY: 'Loyalty', PROMOTION: 'Promotional', LAST_MINUTE: 'Manual', SERVICE_RECOVERY: 'Manual', STAFF_FRIENDS: 'Manual', MANAGER_DISCRETION: 'Manual',
  COMPLIMENTARY: 'Complimentary', HOUSE_USE: 'House use', OTHER: 'Manual',
} as const;
export type DiscountCode = keyof typeof DISCOUNT_REASONS;
export const DISCOUNT_CODES = Object.keys(DISCOUNT_REASONS) as [DiscountCode, ...DiscountCode[]];
export const LABELS: Record<DiscountCode, string> = {
  NEGOTIATED: 'Negotiated with the guest', CORPORATE: 'Corporate or agreed rate', LONG_STAY: 'Long stay', LOYALTY: 'Loyal or repeat guest', PROMOTION: 'Promotion or offer', LAST_MINUTE: 'Unsold room, last minute', SERVICE_RECOVERY: 'Service recovery (a complaint)',
  STAFF_FRIENDS: 'Staff, friends or family', MANAGER_DISCRETION: 'Manager’s decision', COMPLIMENTARY: 'Complimentary stay', HOUSE_USE: 'House use', OTHER: 'Other',
};
