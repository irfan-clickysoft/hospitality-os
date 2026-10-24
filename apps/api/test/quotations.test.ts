import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { zonedToUtcMs } from '@hos/domain-types';
import { addUser, adminDb, as, assignRole, createTestApp, provision, testClock } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
let O: Record<string, string>, OM: Record<string, string>;
const OPEN = '2026-11-01';
let n = 0;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...headers, ...extra }, payload: body as object | undefined });
const ok = async (r: Promise<any>, status = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json(); };
const code = async (r: Promise<any>, status: number, c: string) => { const x = await r; expect(x.statusCode, x.body).toBe(status); expect(x.json().code).toBe(c); return x.json(); };
const key = () => ({ 'idempotency-key': `na-${++n}-${Date.now()}` });
const at = (date: string, time: string) => testClock.set(zonedToUtcMs(date, time, 'Asia/Karachi'));

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'qt'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

async function sunset() {
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `QT${++n}`, name: `Quote ${n}` })).json().id as string;
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'STD', name: 'Standard', maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id as string;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, from: 101, to: 104 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'BAR', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '12000', extraAdult: '3000', extraChild: '1500' }] });
  await ok(call('POST', `/v1/properties/${pid}/rate-plans/${bar}/seasons`, O, { name: 'Peak', startDate: '2026-11-05', endDate: '2026-11-08', priority: 5, values: [{ roomTypeId: rt, amount: '35000' }] }), 201);
  return { pid, rt, bar };
}
type W = Awaited<ReturnType<typeof sunset>>;
const u = (w: W, tail: string) => `/v1/properties/${w.pid}/${tail}`;
const body = (w: W, o: Record<string, unknown> = {}) => ({
  customerName: 'Acme Retreat Ltd', address: 'DHA Phase 5, Karachi', customerRef: 'ART0810-108', balanceDueDays: 30, contactName: 'Mr. Aslam', phone: '0300 1234567', email: 'aslam@acme.test', residency: 'RESIDENT', title: 'Team retreat in November', validUntil: '2026-11-20',
  discount: { kind: 'AMOUNT', value: '5000' }, discountReason: 'Repeat customer', deposit: { kind: 'PCT', value: '30' }, specialRequests: 'Ground floor rooms, airport pickup on arrival', amenities: ['Breakfast for all guests', 'Free Wi-Fi', 'Evening tea'],
  lines: [{ roomTypeId: w.rt, rooms: 2, arrival: '2026-11-03', departure: '2026-11-08', adults: 2, roomNumbers: '101, 102', discount: { kind: 'PCT', value: '10' } }], ...o });

describe('quotations', () => {
  it('prices seasons night by night, takes a percentage off a line and an amount off the whole, and asks for an advance', async () => {
    const w = await sunset();
    const p = await ok(call('POST', u(w, 'quotations/price'), O, body(w)));
    const l = p.lines[0];
    expect(l.bands.map((g: any) => [g.nights, g.rate, g.label])).toEqual([[2, '1200000', ''], [3, '3500000', 'Peak season']]);        // 2 nights at 12,000 then 3 at 35,000
    expect(l.grossPerRoom).toBe('12900000'); expect(l.gross).toBe('25800000');
    expect(l.lineDiscount).toBe('2580000'); expect(l.overallShare).toBe('500000'); expect(p.discount).toBe('3080000');
    expect(p.total).toBe('22720000'); expect(p.deposit).toEqual({ kind: 'PCT', amount: '6816000' });
    expect(l.roomDiscounts.reduce((a: number, x: string) => a + Number(x), 0)).toBe(3080000);
    const none = await ok(call('POST', u(w, 'quotations/price'), O, body(w, { discount: { kind: 'NONE' }, deposit: { kind: 'NONE' }, lines: [{ roomTypeId: w.rt, rooms: 1, arrival: '2026-11-03', departure: '2026-11-05' }] })));
    expect(none.total).toBe('2400000'); expect(none.discount).toBe('0');
    await code(call('POST', u(w, 'quotations/price'), O, body(w, { lines: [{ roomTypeId: w.rt, rooms: 1, arrival: '2026-11-05', departure: '2026-11-05' }] })), 400, 'VALIDATION_FAILED');
  });

  it('is drafted, sent as a private page, answered by the customer (which tells the desk), and turned into a booking at the agreed prices', async () => {
    const w = await sunset();
    const q = await ok(call('POST', u(w, 'quotations'), O, body(w)), 201);
    expect(q.number).toMatch(/^QT-QT\d+-26\d{4}$/); expect(q.status).toBe('DRAFT'); expect(q.pricing.total).toBe('22720000');
    const edited = await ok(call('PUT', u(w, `quotations/${q.id}`), O, { ...body(w, { title: 'Retreat, revised' }), version: q.version })); expect(edited.title).toBe('Retreat, revised');
    await code(call('PUT', u(w, `quotations/${q.id}`), O, { ...body(w), version: q.version }), 412, 'VERSION_CONFLICT');
    const staffPage = await call('GET', u(w, `quotations/${q.id}/page`), O); expect(staffPage.statusCode).toBe(200); expect(staffPage.body).toContain('Peak season'); expect(staffPage.body).toContain('Repeat customer'); expect(staffPage.body).toContain('Evening tea'); expect(staffPage.body).not.toContain('Accept quotation');
    for (const t of ['Guest details', 'Booking details', 'Customer ID', 'ART0810-108', 'DHA Phase 5, Karachi', 'no 101, 102', 'Unit price / night', 'Special discount', 'Grand total', '30% advance at the time of booking', 'Balance', 'Amenities included', 'Booking terms', 'Cancellation policy', 'Greetings from Quote']) expect(staffPage.body, t).toContain(t);

    const msg = await ok(call('POST', u(w, `quotations/${q.id}/message`), O, {}));
    expect(msg.text).toContain('QT-'); expect(msg.text).toContain('/v1/guest/quote/'); expect(msg.text).toContain('227,200'); expect(msg.phone).toBe('0300 1234567');
    const sent = await ok(call('GET', u(w, `quotations/${q.id}`), O)); expect(sent.status).toBe('SENT');
    await code(call('PUT', u(w, `quotations/${q.id}`), O, { ...body(w), version: sent.version }), 409, 'WRONG_STATE');

    const path = new URL(msg.url, 'http://x').pathname;
    const page = await app.inject({ method: 'GET', url: path });
    expect(page.statusCode).toBe(200); expect(page.body).toContain('Accept quotation'); expect(page.body).toContain('Acme Retreat Ltd'); expect(page.body).toContain('PKR 227,200'); expect(page.headers['x-robots-tag']).toBe('noindex');
    expect((await app.inject({ method: 'GET', url: '/v1/guest/quote/00000000000000000000000000000000-00000000000000000000000000000000' })).statusCode).toBe(404);
    const respond = (b: object) => app.inject({ method: 'POST', url: `${path}/respond`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(b) });
    expect((await respond({ decision: 'ACCEPT', name: 'A' })).statusCode).toBe(400);
    expect((await respond({ decision: 'ACCEPT', name: 'Aslam Khan', note: 'Please keep rooms together' })).statusCode).toBe(200);
    expect((await respond({ decision: 'DECLINE', name: 'Aslam Khan' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: path })).body).toContain('you accepted this quotation');

    const inbox = await ok(call('GET', u(w, 'inbox'), O)); const item = inbox.items.find((x: any) => x.kind === 'QUOTATION_ACCEPTED');
    expect(item).toMatchObject({ guest: 'Acme Retreat Ltd', level: 'ACTION' });
    const open = await ok(call('GET', u(w, 'quotations?status=ACCEPTED'), O)); expect(open.items[0]).toMatchObject({ answered: true, total: '22720000' });
    await ok(call('POST', u(w, `quotations/${q.id}/seen`), O, {}));
    expect((await ok(call('GET', u(w, 'inbox'), O))).items.some((x: any) => x.kind === 'QUOTATION_ACCEPTED')).toBe(false);

    const made = await ok(call('POST', u(w, `quotations/${q.id}/convert`), O, {}));
    expect(made.status).toBe('CONVERTED'); expect(made.bookings).toHaveLength(1);
    const res = await ok(call('GET', u(w, `reservations/${made.bookings[0].id}`), O));
    expect(res.lines).toHaveLength(2); expect(res.totalExTax.amount).toBe('227200.00'); expect(res.notes.specialRequests).toContain('Ground floor');
    await code(call('POST', u(w, `quotations/${q.id}/convert`), O, {}), 409, 'WRONG_STATE');
  });

  it('a customer can decline; staff can record a phone answer, revise or cancel; an expired or draft page cannot be answered; rooms short is reported', async () => {
    const w = await sunset();
    const q = await ok(call('POST', u(w, 'quotations'), O, body(w, { discount: { kind: 'NONE' }, lines: [{ roomTypeId: w.rt, rooms: 5, arrival: '2026-11-03', departure: '2026-11-05' }] })), 201);
    expect(q.pricing.lines[0].warning).toContain('Only 4');
    const msg = await ok(call('POST', u(w, `quotations/${q.id}/message`), O, {})); const path = new URL(msg.url, 'http://x').pathname;
    expect((await app.inject({ method: 'POST', url: `${path}/respond`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ decision: 'DECLINE', name: 'Aslam', note: 'Too many rooms' }) })).statusCode).toBe(200);
    expect((await ok(call('GET', u(w, 'inbox'), O))).items.find((x: any) => x.kind === 'QUOTATION_DECLINED')).toMatchObject({ level: 'INFO' });
    const rev = await ok(call('POST', u(w, `quotations/${q.id}/revise`), O, {})); expect(rev.status).toBe('DRAFT'); expect(rev.response).toBeNull();
    expect((await app.inject({ method: 'GET', url: path })).body).toContain('being updated');
    await ok(call('POST', u(w, `quotations/${q.id}/message`), O, {}));
    const marked = await ok(call('POST', u(w, `quotations/${q.id}/mark`), O, { status: 'ACCEPTED', note: 'Agreed on the phone' })); expect(marked.status).toBe('ACCEPTED');
    await code(call('POST', u(w, `quotations/${q.id}/convert`), O, {}), 409, 'NOT_AVAILABLE');                                   // five rooms asked, four exist
    await ok(call('POST', u(w, `quotations/${q.id}/cancel`), O, {}));
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    await code(call('POST', u(w, `quotations/${q.id}/message`), O, {}), 409, 'WRONG_STATE');
    const hk = await addUser(T.tenantId, `hk${++n}@qt.test`); await assignRole(T.tenantId, hk, 'housekeeper', 'PROPERTY', w.pid);
    expect((await call('GET', u(w, 'quotations'), as(T.tenantId, hk))).statusCode).toBe(403);
    await code(call('POST', u(w, 'quotations'), O, body(w, { validUntil: '2026-10-01' })), 422, 'VALIDATION_FAILED');
  });

  it('keeps the wording around the figures per property: the built-in one until the owner writes their own, which the page then uses', async () => {
    const w = await sunset();
    const d = await ok(call('GET', u(w, 'quotations/settings'), O)); expect(d.custom).toBe(false); expect(d.greeting).toContain('{property}'); expect(d.terms.length).toBeGreaterThanOrEqual(10); expect(d.advancePct).toBe(50);
    const mine = { greeting: 'Welcome to {property}, our pleasure!', closing: 'Thank you for choosing us.', signoff: 'Warm regards,\nReservations', contactPhone: '+92 334 7725555', contactEmail: 'Reservations@hotel.test', website: 'www.hotel.test', locationNote: '26/B Creek Lane, Karachi', amenities: ['Wi-Fi'], taxNote: '15% tax applies to online payments only.', advancePct: 50, balanceDays: 30, terms: [{ title: 'Payment', body: 'Pay on time.' }] };
    const saved = await ok(call('PUT', u(w, 'quotations/settings'), O, mine)); expect(saved.custom).toBe(true);
    const q = await ok(call('POST', u(w, 'quotations'), O, body(w, { amenities: [] })), 201);
    const page = (await call('GET', u(w, `quotations/${q.id}/page`), O)).body;
    for (const t of ['Welcome to Quote', 'Thank you for choosing us.', 'Reservations@hotel.test', '+92 334 7725555', 'www.hotel.test', '26/B Creek Lane, Karachi', 'Pay on time.', '15% tax applies to online payments only.', 'Wi-Fi']) expect(page, t).toContain(t);
    expect(page).not.toContain('Cancellation policy');
    const hk = await addUser(T.tenantId, `hk${++n}@qt.test`); await assignRole(T.tenantId, hk, 'housekeeper', 'PROPERTY', w.pid);
    expect((await call('PUT', u(w, 'quotations/settings'), as(T.tenantId, hk), mine)).statusCode).toBe(403);
    await code(call('PUT', u(w, 'quotations/settings'), O, { ...mine, advancePct: 120 }), 400, 'VALIDATION_FAILED');
    expect((await ok(call('POST', u(w, 'quotations/settings/reset'), O, {}))).custom).toBe(false);
  });
});
