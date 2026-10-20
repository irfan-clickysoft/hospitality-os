import { describe, expect, it } from 'vitest';
import { clock12, confirmationText, longDate } from './confirmation.js';

describe('WhatsApp booking confirmation', () => {
  it('writes dates and times the way guests read them', () => {
    expect(longDate('2026-10-22')).toBe('22 October 2026');
    expect(clock12('14:00')).toBe('2:00 PM'); expect(clock12('12:00')).toBe('12:00 PM'); expect(clock12('00:30')).toBe('12:30 AM');
  });
  it('follows the hotel wording exactly', () => {
    const text = confirmationText({ guestName: 'Ali Raza', salutation: 'Mr.', manager: 'Hira Khan', propertyName: 'Sunset BnB Boulevard', city: 'Karachi', confirmationNo: 'BLVD-2600002',
      arrival: '2026-10-22', departure: '2026-11-01', checkInTime: '14:00', checkOutTime: '12:00', mapsUrl: 'https://maps.app.goo.gl/abc' });
    expect(text).toBe(`Dear Mr. Ali Raza,

Greetings from Sunset BnB Boulevard, Karachi.

This is Hira Khan. We are pleased to confirm your reservation:

Booking reference: BLVD-2600002
Check-in: 22 October 2026 at 2:00 PM
Check-out: 1 November 2026 at 12:00 PM
Location: https://maps.app.goo.gl/abc

We look forward to welcoming you. If you need any assistance before your arrival, please reply to this message.

Warm regards,
Hira Khan
Sunset BnB Boulevard, Karachi`);
  });
  it('adds the guest’s own booking page when there is one', () => {
    const text = confirmationText({ guestName: 'Sara', salutation: '', manager: 'Hira', propertyName: 'Sunset BnB', confirmationNo: 'X-1', arrival: '2026-11-05', departure: '2026-11-07', mapsUrl: 'https://m/x', bookingUrl: 'https://pms.example/#/b/abc' });
    expect(text).toContain('Location: https://m/x\nBooking details and requests: https://pms.example/#/b/abc\n\nWe look forward');
  });
  it('leaves out what is not known instead of printing a blank', () => {
    const text = confirmationText({ guestName: 'Sara', salutation: '', manager: 'Hira', propertyName: 'Sunset BnB Creek', confirmationNo: 'CRK-2600001', arrival: '2026-11-05', departure: '2026-11-07' });
    expect(text).toContain('Dear Sara,'); expect(text).not.toContain('Location'); expect(text).toContain('Greetings from Sunset BnB Creek.'); expect(text).toContain('Check-in: 5 November 2026\n');
  });
});
