import { describe, expect, it } from 'vitest';
import { defaultTemplate, EVENTS, render, unknownVariables, VARIABLES } from '../src/messages/templates.js';

describe('message templates', () => {
  it('fills a payment message in your wording', () => {
    const text = render(defaultTemplate('PAYMENT_RECEIVED', 'WHATSAPP').body, { guest_name: 'Mr. Ali Raza', property_name: 'Sunset BnB Boulevard, Karachi', booking_reference: 'BLVD-2600002', currency: 'PKR', amount: '25,000',
      payment_date: '22 October 2026', payment_method: 'Cash', receipt_number: 'RCT-BLVD-26-00012', balance: '10,000', secure_link: 'https://pms.example/#/d/abc', document_link: 'https://pms.example/v1/guest/doc/abc', manager_name: 'Hira Khan' });
    expect(text).toBe(`Dear Mr. Ali Raza,

Thank you. We confirm receipt of your payment for your reservation at Sunset BnB Boulevard, Karachi.

Booking reference: BLVD-2600002
Amount received: PKR 25,000
Payment date: 22 October 2026
Payment method: Cash
Receipt number: RCT-BLVD-26-00012
Remaining balance: PKR 10,000

Your payment receipt (to view or print): https://pms.example/v1/guest/doc/abc
Your booking page: https://pms.example/#/d/abc

Warm regards,
Hira Khan
Sunset BnB Boulevard, Karachi`);
  });
  it('leaves out a line that has a value missing', () => {
    const t = 'Hello {{guest_name}}\nBalance: {{currency}} {{balance}}\nLocation: {{maps_link}}\n\n\n\nBye';
    expect(render(t, { guest_name: 'Sara', currency: 'PKR' })).toBe('Hello Sara\n\nBye');
    expect(render(t, { guest_name: 'Sara', currency: 'PKR', balance: '500', maps_link: 'https://m' })).toBe('Hello Sara\nBalance: PKR 500\nLocation: https://m\n\nBye');
    expect(render(t, { guest_name: 'Sara' })).toBe('Hello Sara\n\nBye');
  });
  it('every built-in message uses only the placeholders its kind offers', () => {
    for (const e of EVENTS) for (const ch of ['WHATSAPP', 'EMAIL'] as const) {
      const t = defaultTemplate(e, ch); expect(unknownVariables(e, t.body + (t.subject ?? '')), `${e}/${ch}`).toEqual([]);
    }
  });
  it('names a placeholder it does not know', () => {
    expect(unknownVariables('CHECK_IN', 'Hi {{guest_name}} {{room_no}} {{ amount }}')).toEqual(['room_no', 'amount']);
    expect(VARIABLES.PAYMENT_RECEIVED).toContain('receipt_number');
  });
});
