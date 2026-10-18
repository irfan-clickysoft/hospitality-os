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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'spaces'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@spaces.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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


const S = (w: W, tail = '') => u(w, `spaces${tail}`);
const hall = (w: W, o: Record<string, unknown> = {}) => ok(call('POST', S(w), O, { name: 'Conference room', nameUr: 'کانفرنس روم', capacity: 40, bufferMinutes: 30, hourly: '5000', halfDay: '15000', fullDay: '25000', ...o }), 201);
const hire = (w: W, space: { id: string }, o: Record<string, unknown> = {}, h = O) => call('POST', S(w, '/bookings'), h, { spaceId: space.id, eventName: 'Board meeting', hostName: 'Mr Khan', hostPhone: '03001234567', date: '2026-11-05', startTime: '14:00', endTime: '18:00', pricing: 'HALF_DAY', billTo: 'SEPARATE', ...o });
const bal = async (w: W, b: { id: string }) => (await ok(call('GET', u(w, `reservations/${b.id}/folio`), O))).folio.balance.amount as string;

describe('conference room', () => {
  it('a space has hourly / half-day / full-day prices; only people who manage spaces set them; names are unique', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const desk = await staff(w, 'front_desk_agent'); const clerk = await staff(w, 'cashier');
    const s = await hall(w);
    expect(s).toMatchObject({ name: 'Conference room', hourly: { amount: '5000.00' }, halfDay: { amount: '15000.00' }, fullDay: { amount: '25000.00' }, bufferMinutes: 30, active: true });
    await code(call('POST', S(w), desk.h, { name: 'Boardroom' }), 403, 'PERMISSION_DENIED');
    await code(call('POST', S(w), O, { name: 'conference ROOM' }), 409, 'DUPLICATE');
    expect((await ok(call('GET', S(w), desk.h))).items).toHaveLength(1);                                   // the front desk can see it
    await code(call('GET', S(w), clerk.h), 403, 'PERMISSION_DENIED');
    expect(await ok(call('PATCH', S(w, `/${s.id}`), O, { hourly: '6000', fullDay: null, version: s.version }))).toMatchObject({ hourly: { amount: '6000.00' }, fullDay: null, version: s.version + 1 });
    await code(call('PATCH', S(w, `/${s.id}`), O, { hourly: '1', version: s.version }), 412, 'VERSION_CONFLICT');
  });

  it('pricing: hourly counts started hours, a half day is up to 4 hours, a full day up to 12; a price that is not offered is refused', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const s = await hall(w, { fullDay: null });
    expect(await ok(hire(w, s, { pricing: 'HOURLY', startTime: '09:00', endTime: '11:15' }), 201)).toMatchObject({ amount: { amount: '15000.00' }, hours: 3, status: 'BOOKED', billTo: 'SEPARATE', number: expect.stringMatching(/-CF00001$/) });   // 2h15 → 3 hours × 5000
    await code(hire(w, s, { pricing: 'HALF_DAY', date: '2026-11-06', startTime: '09:00', endTime: '14:00' }), 422, 'TOO_LONG_FOR_HALF_DAY');
    await code(hire(w, s, { pricing: 'FULL_DAY', date: '2026-11-06' }), 422, 'PRICING_NOT_OFFERED');
    await code(hire(w, s, { date: '2026-11-06', startTime: '10:00', endTime: '09:00' }), 422, 'TIME_RANGE_INVALID');
    await code(hire(w, s, { date: '2026-11-06', startTime: '10:00', endTime: '10:15' }), 422, 'TOO_SHORT');
    await code(hire(w, s, { date: '2026-11-04' }), 422, 'DATE_IN_PAST');
    await ok(call('PATCH', S(w, `/${s.id}`), O, { hourly: null, version: s.version }));
    await code(hire(w, s, { pricing: 'HOURLY', date: '2026-11-06' }), 422, 'PRICING_NOT_OFFERED');
    await ok(call('PATCH', S(w, `/${s.id}`), O, { active: false, version: s.version + 1 }));
    await code(hire(w, s, { date: '2026-11-06' }), 422, 'SPACE_INACTIVE');
  });

  it('two hires can never overlap, and the changeover buffer after a hire counts as taken; a cancelled hire frees the slot', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const s = await hall(w);
    const first = await ok(hire(w, s, { startTime: '14:00', endTime: '17:00' }), 201);
    await code(hire(w, s, { startTime: '16:00', endTime: '18:00' }), 409, 'SPACE_TAKEN');
    await code(hire(w, s, { startTime: '17:10', endTime: '19:00' }), 409, 'SPACE_TAKEN');                      // inside the 30-minute changeover
    await code(hire(w, s, { startTime: '12:00', endTime: '14:10' }), 409, 'SPACE_TAKEN');
    await ok(hire(w, s, { startTime: '17:30', endTime: '19:00' }), 201);                                      // exactly after the buffer
    await ok(hire(w, s, { startTime: '10:00', endTime: '13:30' }), 201);                                      // ends exactly 30 minutes before
    await ok(call('POST', S(w, `/bookings/${first.id}/cancel`), O, { reason: 'Host postponed' }));
    await ok(hire(w, s, { startTime: '14:00', endTime: '17:00' }), 201);
    const other = await hall(w, { name: 'Boardroom' });
    await ok(hire(w, other, { startTime: '14:00', endTime: '17:00' }), 201);                                  // another space is independent
    const cal = await ok(call('GET', S(w, '/bookings?from=2026-11-05&to=2026-11-05'), O));
    expect(cal.items.map((x: any) => [x.startTime, x.status])).toEqual([['10:00', 'BOOKED'], ['14:00', 'CANCELLED'], ['14:00', 'BOOKED'], ['14:00', 'BOOKED'], ['17:30', 'BOOKED']].sort((a, b) => 0) as never);
  });

  it('a staying guest: the hire is a charge on the stay’s bill, put there when the hire is completed (not before, and once)', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const s = await hall(w); const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' }); await checkIn(w, b, '101');
    const stays = await ok(call('GET', S(w, '/stays'), O)); expect(stays.items.find((x: any) => x.reservationId === b.id)).toMatchObject({ room: '101', status: 'IN_HOUSE' });
    await code(hire(w, s, { billTo: 'STAY' }), 400, 'VALIDATION_FAILED');                                        // a stay is needed
    await code(hire(w, s, { billTo: 'STAY', reservationId: b.id, companyId: '11111111-1111-4111-8111-111111111111' }), 400, 'VALIDATION_FAILED');
    const h = await ok(hire(w, s, { billTo: 'STAY', reservationId: b.id }), 201);
    expect(h).toMatchObject({ billTo: 'STAY', bill: null, stay: { reservationId: b.id }, amount: { amount: '15000.00' } });
    const before = await bal(w, b);
    await code(call('POST', S(w, `/bookings/${h.id}/complete`), O, {}), 409, 'NOT_STARTED');
    at('2026-11-05', '15:00');
    expect(await ok(call('POST', S(w, `/bookings/${h.id}/complete`), O, {}))).toMatchObject({ status: 'COMPLETED' });
    expect(Number(await bal(w, b)) - Number(before)).toBe(15000);
    const f = await ok(call('GET', u(w, `reservations/${b.id}/folio`), O)); const hallPostings = f.postings.filter((p: any) => p.txnCode === 'HALL');
    expect(hallPostings).toHaveLength(1); expect(hallPostings[0].description).toContain('-CF00001 · Conference room · Board meeting');
    await code(call('POST', S(w, `/bookings/${h.id}/complete`), O, {}), 409, 'WRONG_STATE');
    await code(call('POST', S(w, `/bookings/${h.id}/cancel`), O, { reason: 'changed mind' }), 409, 'ALREADY_COMPLETED');
    expect((await ok(call('GET', u(w, 'folio-check'), O))).ok).toBe(true);
  });

  it('someone not staying with us: the hire has a bill of its own that takes payments; cancelling is refused once money is on it', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const s = await hall(w);
    const h = await ok(hire(w, s, { billTo: 'SEPARATE', hostName: 'Walk-in Client' }), 201);
    expect(h.bill).toMatchObject({ balance: { amount: '0.00' }, status: 'OPEN' });
    const pay = (amount: string) => call('POST', u(w, `folios/${h.bill.folioId}/payments`), O, { method: 'CARD_SLIP', amount, cardLast4: '4242', reference: 'RRNA12345', approvalCode: 'A12345', kind: 'DEPOSIT' }, key());
    const dep = await ok(pay('5000'), 201); expect(dep.balance.amount).toBe('-5000.00');
    at('2026-11-05', '15:00');
    const done = await ok(call('POST', S(w, `/bookings/${h.id}/complete`), O, {}));
    expect(done.bill.balance.amount).toBe('10000.00');
    const rest = await ok(call('POST', u(w, `folios/${h.bill.folioId}/payments`), O, { method: 'CARD_SLIP', amount: '10000', cardLast4: '4242', reference: 'RRNB99999', approvalCode: 'B99999' }, key()), 201);
    expect(rest.balance.amount).toBe('0.00');
    expect(await ok(call('POST', u(w, `folios/${h.bill.folioId}/close`), O, {}))).toMatchObject({ status: 'CLOSED' });
    expect((await ok(call('GET', u(w, 'folio-check'), O))).ok).toBe(true);
    // a second, cancelled before anything happens: the empty bill is voided; with a deposit on it, cancelling is refused
    const h2 = await ok(hire(w, s, { startTime: '19:00', endTime: '20:00', pricing: 'HOURLY' }), 201);
    expect(await ok(call('POST', S(w, `/bookings/${h2.id}/cancel`), O, { reason: 'Host cancelled' }))).toMatchObject({ status: 'CANCELLED' });
    expect((await adminDb.selectFrom('folio').select('status').where('id', '=', h2.bill.folioId).executeTakeFirstOrThrow()).status).toBe('VOID');
    const h3 = await ok(hire(w, s, { date: '2026-11-06' }), 201);
    await ok(call('POST', u(w, `folios/${h3.bill.folioId}/payments`), O, { method: 'CARD_SLIP', amount: '3000', cardLast4: '4242', reference: 'RRNC11111', approvalCode: 'C11111', kind: 'DEPOSIT' }, key()), 201);
    await code(call('POST', S(w, `/bookings/${h3.id}/cancel`), O, { reason: 'Host cancelled' }), 409, 'BILL_HAS_PAYMENTS');
  });

  it('booking needs the right to book; a stay that is over is refused; a company can be noted on a separate bill', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const s = await hall(w); const clerk = await staff(w, 'cashier'); const desk = await staff(w, 'front_desk_agent');
    await code(hire(w, s, {}, clerk.h), 403, 'PERMISSION_DENIED');
    const co = await ok(call('POST', '/v1/companies', OM, { name: `Acme ${++n}`, creditLimit: '100000', termsDays: 30 }), 201);
    expect(await ok(hire(w, s, { companyId: co.id }, desk.h), 201)).toMatchObject({ company: { id: co.id } });
    const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-06' }); await checkIn(w, b, '102'); await ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-out`), OM, { reason: 'left early', balanceReason: 'test: settled elsewhere' }));
    await code(hire(w, s, { billTo: 'STAY', reservationId: b.id, startTime: '20:00', endTime: '21:00', pricing: 'HOURLY' }), 422, 'STAY_NOT_ACTIVE');
  });

  it('a hire on its own bill gets a tax invoice (with the tax from the setup), can be credited, and can be billed to a company on credit instead', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    await adminDb.updateTable('property').set({ tax_jurisdiction: `HALL${++n}` }).where('id', '=', w.pid).execute();
    const jur = (await adminDb.selectFrom('property').select('tax_jurisdiction').where('id', '=', w.pid).executeTakeFirstOrThrow()).tax_jurisdiction!;
    const acc = await addUser(T.tenantId, `acc${++n}@spaces.test`); await assignRole(T.tenantId, acc, 'accountant', 'TENANT', null);
    const c = await ok(call('POST', '/v1/tax/codes', as(T.tenantId, acc, { mfa: true }), { code: `HALL-${n}`, name: 'Hall hire (test)', jurisdiction: jur, version: { rateBp: 1600, appliesTo: ['HALL'], effectiveFrom: '2026-01-01' } }), 201);
    await ok(call('POST', `/v1/tax/versions/${c.version.id}/approve`, OM, { advisorRef: 'TEST-1', legalBasis: 'Test fixture, not law' }));
    const s = await hall(w);
    const co = await ok(call('POST', '/v1/companies', OM, { name: `Hall Co ${++n}`, ntn: '1234567-8', creditLimit: '100000', termsDays: 30 }), 201);
    const h = await ok(hire(w, s, { hostName: 'Walk-in Client' }), 201);
    await code(call('POST', S(w, `/bookings/${h.id}/invoices`), O, {}), 409, 'HIRE_NOT_DONE');
    await code(call('POST', S(w, `/bookings/${h.id}/bill-to-company`), O, { companyId: co.id }, key()), 409, 'HIRE_NOT_DONE');
    at('2026-11-05', '15:00'); const done = await ok(call('POST', S(w, `/bookings/${h.id}/complete`), O, {}));
    expect(done.bill.balance.amount).toBe('17400.00');                                                           // 15,000 + 16% tax
    const inv = await ok(call('POST', S(w, `/bookings/${h.id}/invoices`), O, {}), 201);
    expect(inv).toMatchObject({ docType: 'TAX_INVOICE', billTo: { name: 'Walk-in Client' }, net: { amount: '15000.00' }, tax: { amount: '2400.00' }, total: { amount: '17400.00' }, reservationId: null,
      reference: { hireNumber: expect.stringMatching(/-CF00001$/), space: 'Conference room', from: '14:00', to: '18:00', hireDate: '2026-11-05' } });
    await code(call('POST', S(w, `/bookings/${h.id}/invoices`), O, {}), 422, 'NOTHING_TO_INVOICE');             // already invoiced
    expect((await ok(call('GET', S(w, `/bookings/${h.id}/invoices`), O))).items.map((x: any) => x.number)).toEqual([inv.number]);
    const html = (await call('GET', u(w, `invoices/${inv.id}/print`), O)).body; expect(html).toContain('Walk-in Client'); expect(html).toContain('Conference room'); expect(html).toContain(h.number);
    // a credit note brings the items back so the invoice can be made again, this time to the company
    await ok(call('POST', u(w, `invoices/${inv.id}/credit`), OM, { reason: 'Wrong name' }));
    const again = await ok(call('POST', S(w, `/bookings/${h.id}/invoices`), O, { companyId: co.id }), 201);
    expect(again.billTo).toMatchObject({ name: co.name, ntn: '1234567-8' });
    // billed to the company on credit: the amount leaves the hire's bill and becomes a receivable
    const stay = await book(w, { arrival: '2026-11-05', departure: '2026-11-06' }); await checkIn(w, stay, '103');
    const own = await ok(hire(w, s, { startTime: '19:00', endTime: '20:00', pricing: 'HOURLY', hostName: 'Acme rep' }), 201);
    at('2026-11-05', '21:00'); await ok(call('POST', S(w, `/bookings/${own.id}/complete`), O, {}));
    const billed = await ok(call('POST', S(w, `/bookings/${own.id}/bill-to-company`), O, { companyId: co.id }, key()), 201);
    expect(billed.item).toMatchObject({ companyId: co.id, amount: { amount: '5800.00' }, confirmationNo: expect.stringMatching(/-CF00002$/), guest: 'Acme rep', status: 'OPEN' }); expect(billed.balance.amount).toBe('0.00');
    await code(call('POST', S(w, `/bookings/${own.id}/bill-to-company`), O, { companyId: co.id }, key()), 422, 'NOTHING_TO_BILL');                // nothing left to bill
    expect((await ok(call('GET', `/v1/companies/${co.id}/items?open=true`, O))).items.some((x: any) => x.id === billed.item.id)).toBe(true);
    // a hire on a guest's stay is invoiced and billed through the stay, not this way
    const onStay = await ok(hire(w, s, { billTo: 'STAY', reservationId: stay.id, date: '2026-11-06', startTime: '10:00', endTime: '11:00', pricing: 'HOURLY' }), 201);
    await code(call('POST', S(w, `/bookings/${onStay.id}/invoices`), O, {}), 422, 'NOT_A_SEPARATE_BILL');
    await code(call('POST', S(w, `/bookings/${onStay.id}/bill-to-company`), O, { companyId: co.id }, key()), 422, 'NOT_A_SEPARATE_BILL');
    expect((await ok(call('GET', u(w, 'folio-check'), O))).ok).toBe(true);
  });
});
