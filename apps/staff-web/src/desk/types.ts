export interface Amount { amount: string; currency: string }
export interface ListItem {
  reservationId: string; lineId: string; confirmationNo: string; status: string; reservationStatus: string; guest: { fullName: string; phone: string | null; vip: boolean };
  roomType?: { id: string; code: string; name: string }; arrival: string; departure: string; nights: number; adults: number; children: number; assignedRoom: string | null; source: string; atRisk: boolean;
  externalRef: string | null; total: Amount; deposit: { required: Amount; paid: Amount };
}
export interface Line {
  id: string; lineNo: number; status: string; roomType: { id: string; code: string; name: string }; ratePlan: { id: string; code: string; name: string }; arrival: string; departure: string; nights: number; adults: number; children: number; extraBeds: number;
  total: Amount; assignedRoom: { id: string; number: string } | null; allowedActions: string[]; version: number; nightPrices: Array<{ date: string; total: string }>;
}
export interface ReservationDetail {
  id: string; confirmationNo: string; status: string; source: string; channel: string; externalRef: string | null; companyId: string | null; residency: string; version: number;
  guest: { id: string; fullName: string; phone: string | null; email: string | null; nationality: string | null; vip: boolean };
  guarantee: { type: string; atRisk: boolean; deadline: string | null; depositRequired: Amount; depositPaid: Amount };
  optionExpiresAt: string | null; penalty: { amount: Amount; reason: string | null; waived: boolean }; notes: { internal: string | null; guest: string | null; specialRequests: string | null }; totalExTax: Amount; lines: Line[];
  history: Array<{ at: string; action: string; from: string | null; to: string | null; reason: string | null }>;
}
export interface Posting { id: string; type: string; txnCode: string; description: string | null; amount: Amount; businessDate: string; reversed: boolean; paymentId: string | null; sourceType: string }
export interface PaymentRow { id: string; kind: string; method: string; status: string; amount: Amount; reference: string | null; businessDate: string; refundOf: string | null }
export interface FolioView {
  reservationId: string; folio: { id: string; folioNo: string; status: string; balance: Amount } | null;
  projection: { unpostedDue: Amount; unpostedRemainingStay: Amount; balanceAfterDue: Amount; balanceAtEndOfStay: Amount; unpostedNights: number };
  postings: Posting[]; payments: PaymentRow[];
}
export interface RackRoom {
  id: string; number: string; roomTypeId: string; floor: string | null; hkStatus: string; occupancy: string; readyToSell: boolean; arrivingToday: boolean; dueOutToday: boolean;
  stays: Array<{ lineId: string; reservationId: string; confirmationNo: string; guestName: string; vip: boolean; status: string; from: string; to: string; atRisk: boolean }>;
  blocks: Array<{ id: string; type: string; from: string; to: string; reason: string }>;
}
export interface RackData {
  businessDate: string; from: string; to: string; days: string[];
  roomTypes: Array<{ id: string; code: string; name: string; availability: Array<{ date: string; sellable: number; reserved: number; held: number; available: number }> }>;
  rooms: RackRoom[]; unassigned: Array<{ lineId: string; reservationId: string; confirmationNo: string; roomTypeId: string; arrival: string; departure: string; status: string; guestName: string; atRisk: boolean }>;
  summary: { arrivals: { pending: number; checkedIn: number }; departures: { pending: number; checkedOut: number }; inHouse: number; overdueDepartures: number; noShowCandidates: number; atRisk: number;
    rooms: { total: number; occupied: number; vacantClean: number; vacantDirty: number; outOfOrder: number; outOfService: number } };
}
export const STATUS_TONE: Record<string, 'neutral' | 'clean' | 'cleaning' | 'dirty' | 'inspected' | 'warn'> = { OPTION: 'warn', CONFIRMED: 'inspected', CHECKED_IN: 'clean', CHECKED_OUT: 'neutral', CANCELLED: 'dirty', NO_SHOW: 'dirty' };
