/** Transaction codes drive reporting and (later) tax classification and ledger mapping. System codes are fixed; the manual ones can be charged by staff. */
export const MANUAL_CHARGE_CODES = {
  FNB: 'Food & beverage (paid in cash)', FNB_DIGITAL: 'Food & beverage (paid digitally)', LAUNDRY: 'Laundry', TRANSPORT_OWNED: 'Transport (our own vehicle)', TRANSPORT_THIRDPARTY: 'Transport (hired from a third party)', MINIBAR: 'Minibar', MISC: 'Miscellaneous',
} as const;
export type ManualChargeCode = keyof typeof MANUAL_CHARGE_CODES;
export const MANUAL_CODES = Object.keys(MANUAL_CHARGE_CODES) as [ManualChargeCode, ...ManualChargeCode[]];

export const SYSTEM_CODES = {
  ROOM: 'Room charge', ROOM_EXTRAS: 'Room extras (extra person, bed, meals)', ROOM_DISCOUNT: 'Room discount',
  HALL: 'Conference room hire', CANCEL_FEE: 'Late cancellation fee', NOSHOW_FEE: 'No-show fee', DISCOUNT: 'Discount', ADJUSTMENT: 'Adjustment',
  DEPOSIT: 'Advance deposit', REFUND: 'Refund',
  PAY_CASH: 'Cash', PAY_BANK_TRANSFER: 'Bank transfer', PAY_CARD_SLIP: 'Card (POS slip)', PAY_WALLET: 'Wallet',
} as const;
