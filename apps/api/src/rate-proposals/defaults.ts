/** The wording of a corporate rate proposal as Sunset BnB writes it. A new proposal starts from this and every line can be changed. {property} is filled with the hotel's name. */
export const DEFAULT_INTRO = `Greetings from {property}!
Thank you for reaching out regarding corporate room rates for your guest accommodations. We are pleased to present our exclusive corporate rates, designed to provide comfort, convenience and value for your esteemed corporate guests.
Our commitment to exceptional service remains unwavering, and we look forward to continuing to serve you with the same enthusiasm and dedication.
Please find below the details of our corporate room rates, along with the complimentary facilities included, subject to availability.
We appreciate the opportunity to collaborate and look forward to hosting your guests at {property}.`;

export const DEFAULT_NOTES = ['The above rates are subject to applicable Government Taxes.', '{property} reserves the right to change the rate or withdraw any of the facilities without prior notice. Confirmed reservations will be honored at the confirmed rate.'];

export const DEFAULT_FACILITIES = [
  'Complimentary breakfast to be served', '01 large mineral water bottle per day', 'High speed internet connectivity', 'All rooms are equipped with a smart entertainment system including pre-configured Netflix and digital cable',
  'Electronic safety deposit locker in room', 'Inside property parking (limited spots, first come first serve basis)',
];

export const DEFAULT_TERMS = [
  'The corporate package is not applicable during special events or seasons.', 'Bill to the company requires prior approval along with the PO.', 'The corporate package is offered on a per-person, per-room, per-night basis.',
  'Guaranteed reservations must be cancelled or amended at least 48 hours prior to arrival to avoid charges.', 'Non-guaranteed reservations will be held until 16:00 hours only.',
  'In case of a no-show, late cancellation or late amendment, the first night’s room rent will be charged for guaranteed reservations.', 'For early departures, the remaining nights will be charged in full for guaranteed reservations.',
  'Check-in time is 14:00 hours. Early arrivals before 14:00 hours are subject to availability unless guaranteed and paid for from the previous night.', 'Checkout time is 12:00 noon. Late checkout requests are subject to availability and may incur an additional night’s charge.',
  'All bills must be settled before checkout unless prior credit arrangements have been agreed for the bill to the company.', 'For credit facilitation, Bill to Company (BTC) requires prior approval and a PO.', 'All invoices must be settled within 7 days after the BTC invoice is generated.',
  'All room rates are exclusive of applicable government taxes.', 'Any additional charges, such as extra meals, minibar usage or laundry and ironing services, will be billed separately as per actual.', 'Any disputes regarding invoices must be raised within 7 days of receipt.',
  'Any changes to group bookings must be notified at least 7 days in advance.', 'All guests must provide valid identification (CNIC or passport) at check-in as per local regulations. The management reserves the right to deny check-in if proper identification is not provided.',
  'Extra beds are available upon request and subject to availability, at an additional price.', 'Guests will be held responsible for any damage caused to the property during their stay.', '{property} is not liable for loss of personal belongings.',
  'Unmarried couples are not permitted to stay together in the same room.', 'All guests must meet visitors in the lobby or backyard; in-room visits are not allowed.',
  '{property} shall not be liable for any delays or failures in performance due to circumstances beyond its control, such as natural disasters, strikes or government-imposed restrictions.',
];

export const DEFAULT_BILLING_STEPS = [
  'Reservations must be made through the reservations desk using the reference code shown above (to avail the corporate rates).',
  'For Bill to Company (BTC) requests, prior approval is required along with: the company Purchase Order (PO) or a written approval email on the official company domain or letterhead; and the company billing details, including billing name, address and NTN/STN (if applicable).',
  'All BTC reservations will be confirmed only after receipt of the above documents and will be billed as per the agreed credit terms.',
];

export const fill = (t: string, property: string) => t.replace(/\{property\}/g, property);
