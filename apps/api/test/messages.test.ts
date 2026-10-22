import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addUser, as, assignRole, createTestApp, provision } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>, O: Record<string, string>, OM: Record<string, string>, pid: string, resId: string, payId: string, receipt: string;
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string> = {}, body?: unknown) => app.inject({ method, url, headers, payload: body as object | undefined });
const compose = (extra: Record<string, unknown>) => call('POST', `/v1/properties/${pid}/messages/compose`, O, { reservationId: resId, origin: 'https://pms.example', ...extra });

beforeAll(async () => {
  app = await createTestApp();
  T = await provision(app, 'msgs'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); pid = T.propertyIds[0];
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'DLX', name: 'Deluxe', maxAdults: 2, maxChildren: 1, maxOccupancy: 3, baseOccupancy: 2 })).json().id;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, from: 101, to: 101 });
  const v = (await call('GET', `/v1/properties/${pid}`, O)).json().version;
  await call('PATCH', `/v1/properties/${pid}`, O, { city: 'Karachi', mapsUrl: 'https://maps.app.goo.gl/abc', version: v });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: '2026-11-01' });
  const plan = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'Best Available (local)', residency: 'RESIDENT' })).json();
  await call('PUT', `/v1/properties/${pid}/rate-plans/${plan.id}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '10000', extraAdult: '3000', extraChild: '1500' }] });
  const q = (await call('POST', `/v1/properties/${pid}/quotes`, O, { arrival: '2026-11-05', departure: '2026-11-07', adults: 2 })).json();
  const g = (await call('POST', '/v1/guests', O, { fullName: 'Ali Raza', phone: '03001234567', nationality: 'PK' })).json().id;
  const r = await call('POST', `/v1/properties/${pid}/reservations`, { ...O, 'idempotency-key': 'msgs-key-0001' }, { guestId: g, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] });
  resId = r.json().id;
  expect((await call('POST', `/v1/properties/${pid}/cashier/sessions`, O, { openingFloat: '0' })).statusCode).toBe(201);
  const p = await call('POST', `/v1/properties/${pid}/reservations/${resId}/payments`, { ...O, 'idempotency-key': 'msgs-pay-0001' }, { kind: 'PAYMENT', method: 'CASH', amount: '8000' });
  expect(p.statusCode, p.body).toBe(201);
  payId = p.json().payment.id; receipt = p.json().payment.receiptNo;
});
afterAll(async () => { await app.close(); });

describe('payment receipt numbers', () => {
  it('every payment gets the next number for the property and year', async () => {
    expect(receipt).toMatch(/^RCT-P1-26-00001$/);
    const p2 = await call('POST', `/v1/properties/${pid}/reservations/${resId}/payments`, { ...O, 'idempotency-key': 'msgs-pay-0002' }, { kind: 'PAYMENT', method: 'CASH', amount: '1000' });
    expect(p2.json().payment.receiptNo).toBe('RCT-P1-26-00002');
  });
});

describe('guest messages', () => {
  it('writes the reservation confirmation in the agreed wording, with the booking link', async () => {
    const r = await compose({ event: 'RESERVATION_CONFIRMED', salutation: 'Mr.' });
    expect(r.statusCode, r.body).toBe(200);
    const { text } = r.json();
    expect(text).toContain('Dear Mr. Ali Raza,');
    expect(text).toContain('Greetings from P1 msgs P1, Karachi.'.replace('P1 msgs P1', 'msgs P1'));
    expect(text).toMatch(/Booking reference: P1-26\d{5}/);
    expect(text).toContain('Check-in: 5 November 2026 at 2:00 PM');
    expect(text).toContain('Check-out: 7 November 2026 at 12:00 PM');
    expect(text).toContain('Location: https://maps.app.goo.gl/abc');
    expect(text).toMatch(/https:\/\/pms\.example\/#\/b\/[0-9a-f]{32}-[0-9a-f]{32}/);
    expect(text).not.toContain('{{');
  });
  it('writes the payment message from the real payment: amount, method, receipt number, what is still owed', async () => {
    const { text } = (await compose({ event: 'PAYMENT_RECEIVED', paymentId: payId })).json();
    expect(text).toContain('Amount received: PKR 8,000');
    expect(text).toContain('Payment method: Cash');
    expect(text).toContain(`Receipt number: ${receipt}`);
    expect(text).toMatch(/Remaining balance: PKR [\d,]+/);
    expect(text).toContain('Payment date: 1 November 2026');
  });
  it('leaves out the balance line when nothing is owed', async () => {
    const p3 = await call('POST', `/v1/properties/${pid}/reservations/${resId}/payments`, { ...O, 'idempotency-key': 'msgs-pay-0003' }, { kind: 'PAYMENT', method: 'CASH', amount: '99999' });
    const { text } = (await compose({ event: 'PAYMENT_RECEIVED', paymentId: p3.json().payment.id })).json();
    expect(text).not.toContain('Remaining balance');
  });
});

describe('editing the wording', () => {
  it('the owner can change a message, it is used straight away, and can go back to the built-in one', async () => {
    const list = (await call('GET', '/v1/message-templates', OM)).json().items;
    expect(list).toHaveLength(14); expect(list.find((x: any) => x.event === 'CHECK_IN' && x.channel === 'WHATSAPP')).toMatchObject({ custom: false });
    const put = await call('PUT', '/v1/message-templates/CHECK_IN/WHATSAPP', OM, { body: 'Welcome {{guest_name}} to {{property_name}}! Stay: {{secure_link}}' });
    expect(put.statusCode, put.body).toBe(200); expect(put.json().custom).toBe(true);
    expect((await compose({ event: 'CHECK_IN' })).json().text).toMatch(/^Welcome Ali Raza to msgs P1, Karachi! Stay: https:\/\/pms\.example\/#\/b\//);
    expect((await call('DELETE', '/v1/message-templates/CHECK_IN/WHATSAPP', OM)).statusCode).toBe(204);
    expect((await compose({ event: 'CHECK_IN' })).json().text).toContain('Welcome to msgs P1, Karachi. Your check-in has been completed');
  });
  it('refuses a placeholder the message does not offer, and says which are available', async () => {
    const r = await call('PUT', '/v1/message-templates/CHECK_IN/WHATSAPP', OM, { body: 'Hello {{guest_name}}, your room is {{room_number}}' });
    expect(r.statusCode).toBe(422); expect(r.json().code).toBe('UNKNOWN_PLACEHOLDER'); expect(r.json().detail).toContain('{{room_number}}');
  });
  it('only the owner or super admin edits wording; front desk can only send it', async () => {
    const u = await addUser(T.tenantId, 'fd@msgs.test'); await assignRole(T.tenantId, u, 'front_desk_agent', 'PROPERTY', pid);
    const fd = as(T.tenantId, u);
    expect((await call('PUT', '/v1/message-templates/CHECK_IN/WHATSAPP', fd, { body: 'Hello {{guest_name}} welcome' })).statusCode).toBe(403);
    expect((await call('GET', '/v1/message-templates', fd)).statusCode).toBe(403);
    expect((await call('POST', `/v1/properties/${pid}/messages/compose`, fd, { reservationId: resId, event: 'CHECK_IN' })).statusCode).toBe(200);
  });
});
