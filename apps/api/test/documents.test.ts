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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'docs'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

async function sunset() {
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `NA${++n}`, name: `Audit ${n}` })).json().id as string;
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'STD', name: 'Standard', maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id as string;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, from: 101, to: 104 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'BAR', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '12000', extraAdult: '3000', extraChild: '1500' }] });
  const rooms = (await call('GET', `/v1/properties/${pid}/rooms`, O)).json().items as Array<{ id: string; number: string }>;
  return { pid, rt, room: Object.fromEntries(rooms.map((r) => [r.number, r.id])) as Record<string, string> };
}
type W = Awaited<ReturnType<typeof sunset>>;
const u = (w: W, tail: string) => `/v1/properties/${w.pid}/${tail}`;
const setBd = (w: W, d: string) => adminDb.updateTable('property').set({ business_date: d }).where('id', '=', w.pid).execute();
const bdOf = async (w: W) => (await adminDb.selectFrom('property').select('business_date').where('id', '=', w.pid).executeTakeFirstOrThrow()).business_date;
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@docs.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

async function book(w: W, o: { arrival?: string; departure?: string; hold?: number } = {}) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival ?? '2026-11-05', departure: o.departure ?? '2026-11-07', adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(6000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }], ...(o.hold ? { hold: { minutes: o.hold } } : {}) }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string };
}
const checkIn = (w: W, b: { id: string; line: string }, room: string) => ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-in`), O, { roomId: w.room[room], occupants: [{ fullName: 'Guest', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671' }] }));
const checkOut = (w: W, b: { id: string; line: string }) => ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-out`), OM, { balanceReason: 'test: settled elsewhere' }));
const audit = (w: W, body: Record<string, unknown> = {}, h = O) => call('POST', u(w, 'night-audit/runs'), h, body);
const folioOf = (w: W, b: { id: string }) => ok(call('GET', u(w, `reservations/${b.id}/folio`), O));



const F = (w: W, tail: string) => u(w, `fnb/${tail}`);
async function inHouse(w: W) {
  at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
  const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' }); await checkIn(w, b, '101');
  const stay = (await ok(call('GET', F(w, 'in-house'), O))).items.find((x: any) => x.room === '101');
  return { b, stay };
}
const item = (w: W, o: Record<string, unknown> = {}) => ok(call('POST', F(w, 'menu'), O, { category: 'Mains', name: `Dish ${++n}`, price: '800', ...o }), 201);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
function upload(url: string, headers: Record<string, string>, data: Buffer, fields: Record<string, string> = {}, name = 'x.png') {
  const b = '----hosboundary';
  const text = Object.entries(fields).map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
  const payload = Buffer.concat([Buffer.from(`${text}--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]);
  return app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': `multipart/form-data; boundary=${b}` }, payload });
}
const pay = (w: W, b: { id: string }, body: Record<string, unknown>) => ok(call('POST', u(w, `reservations/${b.id}/payments`), O, body, key()), 201);
const transfer = (w: W, b: { id: string }, amount = '10000', ref = 'TT-77123') => pay(w, b, { kind: 'DEPOSIT', method: 'BANK_TRANSFER', amount, reference: ref, counterparty: 'HBL' });

describe('branded documents', () => {
  it('a property has a look: address, phone, colour, a footer line and a logo, shown on its receipts', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    const v = (await call('GET', `/v1/properties/${w.pid}`, O)).json().version;
    await code(call('PATCH', `/v1/properties/${w.pid}`, O, { brandColor: 'teal', version: v }), 400, 'VALIDATION_FAILED');
    await ok(call('PATCH', `/v1/properties/${w.pid}`, O, { address: '12 Seaview Road, Clifton', phone: '+92 21 1234567', receiptFooter: 'Thank you for choosing us', brandColor: '#0a6c74', version: v }));
    const lg = await ok(upload(u(w, 'branding/logo'), O, PNG), 201);
    expect((await app.inject({ method: 'GET', url: lg.logoUrl })).statusCode).toBe(200);
    expect((await call('GET', `/v1/properties/${w.pid}`, O)).json()).toMatchObject({ address: '12 Seaview Road, Clifton', brandColor: '#0a6c74', logoUrl: lg.logoUrl });
    const b = await book(w); const p = await pay(w, b, { kind: 'DEPOSIT', method: 'CARD_SLIP', amount: '5000', reference: 'RRN123456', approvalCode: 'A1B2C3', cardLast4: '4242' });
    const html = await call('GET', u(w, `documents/payment/${p.payment.id}`), O);
    expect(html.statusCode).toBe(200); expect(html.headers['content-type']).toContain('text/html'); expect(html.headers['cache-control']).toContain('no-store');
    expect(html.headers['content-security-policy']).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
    for (const s of ['12 Seaview Road, Clifton', '+92 21 1234567', 'Thank you for choosing us', '--brand: #0a6c74', lg.logoUrl, p.payment.receiptNo, 'PAID', 'PKR 5,000.00', 'ADVANCE DEPOSIT', '•••• 4242']) expect(html.body, s).toContain(s);
    expect((await app.inject({ method: 'DELETE', url: u(w, 'branding/logo'), headers: O })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: lg.logoUrl })).statusCode).toBe(404);
  });

  it('a receipt for a bank transfer says it is awaiting confirmation until verified; a refund has its own voucher', async () => {
    const w = await sunset(); at('2026-11-01', '09:00'); const b = await book(w);
    const t = await transfer(w, b);
    expect((await call('GET', u(w, `documents/payment/${t.payment.id}`), O)).body).toContain('AWAITING BANK CONFIRMATION');
    const acct = await staff(w, 'accountant'); await ok(call('POST', u(w, `payments/${t.payment.id}/verify`), acct.hm, { approve: true }));
    expect((await call('GET', u(w, `documents/payment/${t.payment.id}`), O)).body).toContain('>PAID<');
    const rf = await ok(call('POST', u(w, `payments/${t.payment.id}/refund`), OM, { amount: '2000', reason: 'Guest shortened the stay', method: 'BANK_TRANSFER', counterparty: 'HBL account 1234', reference: 'REF-2001' }, key()), 201);
    const doc = (await call('GET', u(w, `documents/payment/${rf.payment.id}`), O)).body;
    expect(doc).toContain('REFUND VOUCHER'); expect(doc).toContain(t.payment.receiptNo); expect(doc).toContain('RFD-');
  });

  it('a private link opens a document without signing in; it is the same link every time, can be revoked, never leaks another document, and shows nothing unescaped', async () => {
    const w = await sunset(); at('2026-11-01', '09:00');
    const g = await ok(call('POST', '/v1/guests', O, { fullName: 'Eve <script>alert(1)</script> Khan', phone: '0300 5557777', nationality: 'PK' }), 201);
    const q = (await call('POST', u(w, 'quotes'), O, { arrival: '2026-11-05', departure: '2026-11-07', adults: 2, channel: 'PHONE' })).json();
    const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
    const p = await transfer(w, { id: r.id });
    const l1 = await ok(call('POST', u(w, 'documents/links'), O, { kind: 'PAYMENT', refId: p.payment.id }));
    const l2 = await ok(call('POST', u(w, 'documents/links'), O, { kind: 'PAYMENT', refId: p.payment.id }));
    expect(l2.token).toBe(l1.token); expect(l1.url).toContain('/v1/guest/doc/');
    const open = await app.inject({ method: 'GET', url: `/v1/guest/doc/${l1.token}` });
    expect(open.statusCode, open.body).toBe(200); expect(open.body).toContain(p.payment.receiptNo); expect(open.body).not.toContain('<script>alert'); expect(open.body).toContain('&lt;script&gt;');
    expect(open.headers['x-robots-tag']).toBe('noindex');
    expect((await app.inject({ method: 'GET', url: `/v1/guest/doc/${l1.token.slice(0, 32)}-${'0'.repeat(32)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/guest/doc/not-a-token' })).statusCode).toBe(404);
    await code(call('POST', u(w, 'documents/links'), O, { kind: 'PAYMENT', refId: '00000000-0000-4000-8000-000000000000' }), 404, 'NOT_FOUND');
    const views = await adminDb.selectFrom('document_link').select('views').where('token', '=', l1.token).executeTakeFirstOrThrow(); expect(views.views).toBe(1);
    await ok(call('POST', u(w, 'documents/links/revoke'), O, { kind: 'PAYMENT', refId: p.payment.id }));
    expect((await app.inject({ method: 'GET', url: `/v1/guest/doc/${l1.token}` })).statusCode).toBe(404);
    const l3 = await ok(call('POST', u(w, 'documents/links'), O, { kind: 'PAYMENT', refId: p.payment.id })); expect(l3.token).not.toBe(l1.token);
    // another hotel's link is not a way in to this one
    const other = await sunset(); const ob = await book(other); const op = await transfer(other, ob);
    const ol = await ok(call('POST', u(other, 'documents/links'), O, { kind: 'PAYMENT', refId: op.payment.id }));
    expect((await app.inject({ method: 'GET', url: `/v1/guest/doc/${ol.token}` })).body).not.toContain(p.payment.receiptNo);
  });

  it('the final bill lists charges, taxes and payments with the balance; the room-service slip is open to the kitchen but not to everyone', async () => {
    const w = await sunset(); const { b, stay } = await inHouse(w);
    await pay(w, b, { kind: 'DEPOSIT', method: 'CARD_SLIP', amount: '3000', reference: 'RRN999888', approvalCode: 'ZZ99' });
    const st = await call('GET', u(w, `documents/statement/${b.id}`), O);
    expect(st.statusCode, st.body).toBe(200); expect(st.body).toContain('STATEMENT OF ACCOUNT'); expect(st.body).toContain('Guest'); expect(st.body).toMatch(/BALANCE DUE|SETTLED|CREDIT BALANCE/);
    const it = await item(w, { name: 'Karahi', price: '1800' });
    const o = await ok(call('POST', F(w, 'orders'), O, { reservationRoomId: stay.reservationRoomId, lines: [{ menuItemId: it.id, quantity: 2 }] }), 201);
    const cook = await staff(w, 'kitchen_support'); const hk = await staff(w, 'housekeeper');
    const slip = await call('GET', u(w, `documents/order/${o.id}`), cook.h);
    expect(slip.statusCode).toBe(200); expect(slip.body).toContain('ROOM SERVICE ORDER'); expect(slip.body).toContain('Karahi'); expect(slip.body).toContain('PKR 3,600.00');
    await code(call('GET', u(w, `documents/order/${o.id}`), hk.h), 403, 'PERMISSION_DENIED');
    await code(call('GET', u(w, `documents/statement/${b.id}`), cook.h), 403, 'PERMISSION_DENIED');
  });

  it('the payment-received message carries the receipt link', async () => {
    const w = await sunset(); at('2026-11-01', '09:00'); const b = await book(w); const t = await transfer(w, b);
    const m = await ok(call('POST', u(w, 'messages/compose'), O, { reservationId: b.id, event: 'PAYMENT_RECEIVED', channel: 'WHATSAPP', paymentId: t.payment.id, origin: 'https://pms.example' }));
    expect(m.text).toMatch(/https:\/\/pms\.example\/v1\/guest\/doc\/[0-9a-f]{32}-[0-9a-f]{32}/);
  });
});

describe('bank-transfer slips', () => {
  async function guestLink(w: W, b: { id: string }) { const { token } = await ok(call('GET', u(w, `reservations/${b.id}/guest-link`), O)); return token as string; }

  it('a guest sends the slip from their booking page; the desk records the money from it, which attaches it to the payment for whoever verifies; the guest sees what became of it', async () => {
    const w = await sunset(); at('2026-11-01', '09:00'); const b = await book(w); const token = await guestLink(w, b);
    const s = await upload(`/v1/guest/booking/${token}/slips`, {}, PNG, { amount: '12000', reference: 'IBFT 55501', bank: 'Meezan' });
    expect(s.statusCode, s.body).toBe(201); const slipId = s.json().id;
    expect((await upload(`/v1/guest/booking/${token}/slips`, {}, Buffer.from('this is not a picture or a pdf at all'))).statusCode).toBe(400);
    expect((await upload('/v1/guest/booking/nope/slips', {}, PNG)).statusCode).toBe(404);
    const page = await app.inject({ method: 'GET', url: `/v1/guest/booking/${token}` });
    expect(page.json().slips).toMatchObject([{ status: 'SUBMITTED', reference: 'IBFT 55501', claimed: { amount: '12000.00' } }]);
    const list = await ok(call('GET', u(w, 'payment-slips'), O));
    expect(list.items).toMatchObject([{ id: slipId, status: 'SUBMITTED', claimed: { amount: '12000.00' }, bank: 'Meezan', confirmationNo: expect.any(String), guest: expect.any(String) }]);
    expect((await app.inject({ method: 'GET', url: u(w, `payment-slips/${slipId}/file`) })).statusCode).toBe(401);            // the file is never public
    const clerk = await staff(w, 'housekeeper'); await code(call('GET', u(w, 'payment-slips'), clerk.h), 403, 'PERMISSION_DENIED');
    const f = await call('GET', u(w, `payment-slips/${slipId}/file`), O); expect(f.statusCode).toBe(200); expect(f.headers['content-type']).toBe('image/png'); expect(f.headers['cache-control']).toContain('no-store');
    const rec = await ok(call('POST', u(w, `payment-slips/${slipId}/record`), O, { kind: 'DEPOSIT', amount: '12000', reference: 'IBFT 55501', counterparty: 'Meezan' }));
    expect(rec.payment).toMatchObject({ method: 'BANK_TRANSFER', status: 'PENDING_VERIFICATION' });
    await code(call('POST', u(w, `payment-slips/${slipId}/record`), O, { kind: 'DEPOSIT', amount: '12000', reference: 'IBFT 55501', counterparty: 'Meezan' }), 409, 'WRONG_STATE');
    const pending = (await ok(call('GET', u(w, 'payments/pending'), OM))).items; expect(pending[0].slipCount).toBe(1);
    expect((await ok(call('GET', u(w, `payments/${rec.payment.id}/slips`), O))).items).toHaveLength(1);
    expect((await ok(call('GET', u(w, 'payment-slips?status=LINKED'), O))).items[0]).toMatchObject({ paymentId: rec.payment.id, receiptNo: rec.payment.receiptNo });
    expect((await app.inject({ method: 'GET', url: `/v1/guest/booking/${token}` })).json().slips[0].status).toBe('LINKED');
  });

  it('a slip that does not match can be rejected with a reason, which the guest sees; a guest cannot flood the desk', async () => {
    const w = await sunset(); at('2026-11-01', '09:00'); const b = await book(w); const token = await guestLink(w, b);
    const ids: string[] = [];
    for (let k = 0; k < 5; k++) ids.push((await upload(`/v1/guest/booking/${token}/slips`, {}, PNG)).json().id);
    expect((await upload(`/v1/guest/booking/${token}/slips`, {}, PNG)).statusCode).toBe(429);
    await code(call('POST', u(w, `payment-slips/${ids[0]}/reject`), O, { reason: 'x' }), 400, 'VALIDATION_FAILED');
    await ok(call('POST', u(w, `payment-slips/${ids[0]}/reject`), O, { reason: 'No such transfer in our account' }));
    await code(call('POST', u(w, `payment-slips/${ids[0]}/reject`), O, { reason: 'Again please' }), 409, 'WRONG_STATE');
    const g = (await app.inject({ method: 'GET', url: `/v1/guest/booking/${token}` })).json().slips.find((x: any) => x.id === ids[0]);
    expect(g).toMatchObject({ status: 'REJECTED', rejectReason: 'No such transfer in our account' });
    expect((await upload(`/v1/guest/booking/${token}/slips`, {}, PNG)).statusCode).toBe(201);                          // one slot is free again
  });

  it('the desk attaches the slip to a transfer it recorded itself; only a bank transfer takes one', async () => {
    const w = await sunset(); at('2026-11-01', '09:00'); const b = await book(w);
    const t = await transfer(w, b); const card = await pay(w, b, { kind: 'DEPOSIT', method: 'CARD_SLIP', amount: '1000', reference: 'RRN111222', approvalCode: 'Q1' });
    const a = await ok(upload(u(w, `payments/${t.payment.id}/slip`), O, PDF, {}, 'slip.pdf'), 201);
    expect((await ok(call('GET', u(w, `payments/${t.payment.id}/slips`), O))).items).toMatchObject([{ id: a.id, source: 'STAFF' }]);
    const f = await call('GET', u(w, `payment-slips/${a.id}/file`), O); expect(f.headers['content-type']).toBe('application/pdf');
    await code(upload(u(w, `payments/${card.payment.id}/slip`), O, PNG), 422, 'NOT_A_TRANSFER');
    const clerk = await staff(w, 'housekeeper'); expect((await upload(u(w, `payments/${t.payment.id}/slip`), clerk.h, PNG)).statusCode).toBe(403);
  });
});
