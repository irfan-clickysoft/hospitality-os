/** Transaction codes drive reporting and (later) tax classification and ledger mapping. System codes are fixed; the manual ones can be charged by staff. */
export const MANUAL_CHARGE_CODES = {
  FNB: 'Food & beverage', LAUNDRY: 'Laundry', TRANSPORT: 'Transport / pick-up', MINIBAR: 'Minibar', MISC: 'Miscellaneous',
} as const;
export type ManualChargeCode = keyof typeof MANUAL_CHARGE_CODES;
export const MANUAL_CODES = Object.keys(MANUAL_CHARGE_CODES) as [ManualChargeCode, ...ManualChargeCode[]];

export const SYSTEM_CODES = {
  ROOM: 'Room charge', ROOM_EXTRAS: 'Room extras (extra person, bed, meals)', ROOM_DISCOUNT: 'Room discount',
  CANCEL_FEE: 'Late cancellation fee', NOSHOW_FEE: 'No-show fee', DISCOUNT: 'Discount', ADJUSTMENT: 'Adjustment',
  DEPOSIT: 'Advance deposit', REFUND: 'Refund',
  PAY_CASH: 'Cash', PAY_BANK_TRANSFER: 'Bank transfer', PAY_CARD_SLIP: 'Card (POS slip)', PAY_WALLET: 'Wallet',
} as const;
