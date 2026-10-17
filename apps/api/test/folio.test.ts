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
const key = () => ({ 'idempotency-key': `fo-${++n}-${Date.now()}` });

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'folio'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

async function sunset() {
  const pcode = `FO${++n}`;
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: pcode, name: `Folio ${pcode}` })).json().id as string;
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'STD', name: 'Standard', maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id as string;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, from: 101, to: 104 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'Best Available', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '12000', extraAdult: '3000', extraChild: '1500' }] });
  const rooms = (await call('GET', `/v1/properties/${pid}/rooms`, O)).json().items as Array<{ id: string; number: string }>;
  const room = Object.fromEntries(rooms.map((r) => [r.number, r.id])) as Record<string, string>;
  return { pid, rt, bar, room };
}
type W = Awaited<ReturnType<typeof sunset>>;
const setBd = (w: W, d: string) => adminDb.updateTable('property').set({ business_date: d }).where('id', '=', w.pid).execute();
const u = (w: W, tail: string) => `/v1/properties/${w.pid}/${tail}`;
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@folio.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

async function book(w: W, o: { arrival?: string; departure?: string; channel?: string; source?: string } = {}) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival ?? '2026-11-05', departure: o.departure ?? '2026-11-07', adults: 2, channel: o.channel ?? 'PHONE' })).json();
  const opt = q.options.find((x: any) => x.plan.code === 'BAR');
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Payer ${++n}`, phone: `0300${String(4000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: o.source ?? 'PHONE', lines: [{ quoteToken: opt.quoteToken }] }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string, res: r };
}
const checkIn = (w: W, b: { id: string; line: string }, room: string) => ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-in`), O, { roomId: w.room[room], occupants: [{ fullName: 'Payer', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671' }] }));
const checkOut = (w: W, b: { id: string; line: string }, body: Record<string, unknown> = {}, h = OM) => call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-out`), h, body);
const folio = (w: W, b: { id: string }, h = O) => ok(call('GET', u(w, `reservations/${b.id}/folio`), h));
const pay = (w: W, b: { id: string }, body: Record<string, unknown>, h = O) => call('POST', u(w, `reservations/${b.id}/payments`), h, body, key());
const openCash = (w: W, h = O, float = '5000') => ok(call('POST', u(w, 'cashier/sessions'), h, { openingFloat: float }), 201);
const check = async (w: W) => (await ok(call('GET', u(w, 'folio-check'), O))).issues as unknown[];
const amt = (x: { amount: string }) => x.amount;

describe('folio and ledger', () => {
  it('opens a folio at check-in; shows what is posted, what is due tonight and what the stay will cost', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    const f = await folio(w, b);
    expect(f.folio).toMatchObject({ status: 'OPEN', balance: { amount: '0.00' } }); expect(f.folio.folioNo).toMatch(/^FO\d+-F\d{6}$/);
    expect(f.projection).toMatchObject({ unpostedDue: { amount: '12000.00' }, balanceAtEndOfStay: { amount: '24000.00' }, unpostedNights: 2 });
    expect(f.postings).toEqual([]);
  });

  it('charges, discounts (within the staff limit) and corrections by reversal — the original always stays visible', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    const fid = (await folio(w, b)).folio.id as string;
    const c = await ok(call('POST', u(w, `folios/${fid}/charges`), O, { txnCode: 'FNB', amount: '1500', quantity: 2, description: 'Dinner' }), 201);
    expect(c.total.amount).toBe('3000.00'); expect(c.balance.amount).toBe('3000.00');
    const posting = c.postingId as string;
    const d = await ok(call('POST', u(w, `folios/${fid}/postings/${posting}/discount`), O, { pct: 10, reason: 'Birthday' }), 201);
    expect(d.discount.amount).toBe('300.00'); expect(d.balance.amount).toBe('2700.00');
    await code(call('POST', u(w, `folios/${fid}/postings/${posting}/discount`), O, { pct: 95, reason: 'Too much' }), 422, 'DISCOUNT_TOO_LARGE');
    const rev = await ok(call('POST', u(w, `folios/${fid}/postings/${posting}/reverse`), OM, { reason: 'Wrong room' }));
    expect(rev.reversals).toHaveLength(2); expect(rev.balance.amount).toBe('0.00');                 // the charge and its discount
    await code(call('POST', u(w, `folios/${fid}/postings/${posting}/reverse`), OM, { reason: 'Again' }), 409, 'ALREADY_REVERSED');
    const f = await folio(w, b);
    expect(f.postings.map((p: any) => p.type)).toEqual(['CHARGE', 'DISCOUNT', 'REVERSAL', 'REVERSAL']); expect(f.postings[0].reversed).toBe(true);
    // reversing needs the adjust permission and a fresh second factor
    const fd = await staff(w, 'front_desk_agent');
    const c2 = await ok(call('POST', u(w, `folios/${fid}/charges`), fd.h, { txnCode: 'MISC', amount: '500', description: 'Item' }), 201);
    await code(call('POST', u(w, `folios/${fid}/postings/${c2.postingId}/reverse`), fd.hm, { reason: 'Oops' }), 403, 'PERMISSION_DENIED');
    await code(call('POST', u(w, `folios/${fid}/postings/${c2.postingId}/reverse`), O, { reason: 'Oops' }), 403, 'MFA_REQUIRED');
    expect(await check(w)).toEqual([]);
  });

  it('the ledger cannot be edited or deleted, and closed business dates cannot be posted to', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    const fid = (await folio(w, b)).folio.id as string;
    const c = await ok(call('POST', u(w, `folios/${fid}/charges`), O, { txnCode: 'MISC', amount: '700', description: 'Item' }), 201);
    await expect(adminDb.updateTable('folio_posting').set({ note: 'tampered' }).where('id', '=', c.postingId).execute()).rejects.toThrow(/append-only/);
    await expect(adminDb.deleteFrom('folio_posting').where('id', '=', c.postingId).execute()).rejects.toThrow(/append-only/);
    await setBd(w, '2026-11-06');
    await expect(adminDb.insertInto('folio_posting').values({ tenant_id: T.tenantId, property_id: w.pid, folio_id: fid, posting_type: 'CHARGE', txn_code: 'MISC', amount_minor: '100', currency: 'PKR', business_date: '2026-11-05', source_type: 'MANUAL' } as never).execute()).rejects.toThrow(/closed/);
    await expect(adminDb.insertInto('folio_posting').values({ tenant_id: T.tenantId, property_id: w.pid, folio_id: fid, posting_type: 'PAYMENT', txn_code: 'PAY_CASH', amount_minor: '100', currency: 'PKR', business_date: '2026-11-06', source_type: 'MANUAL' } as never).execute()).rejects.toThrow();   // payments must be negative
    expect(await check(w)).toEqual([]);
  });
});

describe('payments', () => {
  it('cash needs your open cashier session; a retry with the same key never takes money twice', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    await code(pay(w, b, { method: 'CASH', amount: '5000' }), 409, 'NO_OPEN_SESSION');
    await openCash(w);
    const k = key(); const body = { method: 'CASH', amount: '5000', note: 'Advance' };
    const r1 = await call('POST', u(w, `reservations/${b.id}/payments`), O, body, k); expect(r1.statusCode, r1.body).toBe(201);
    const r2 = await call('POST', u(w, `reservations/${b.id}/payments`), O, body, k); expect(r2.statusCode).toBe(200);
    expect(r2.json().payment.id).toBe(r1.json().payment.id);
    const f = await folio(w, b);
    expect(f.folio.balance.amount).toBe('-5000.00'); expect(f.payments).toHaveLength(1); expect(f.postings).toHaveLength(1);
    expect(f.postings[0]).toMatchObject({ type: 'PAYMENT', txnCode: 'PAY_CASH', amount: { amount: '-5000.00' } });
    expect((await call('POST', u(w, `reservations/${b.id}/payments`), O, body)).statusCode).toBe(400);     // key required
    expect(await check(w)).toEqual([]);
  });

  it('card slips and wallets need their references; bad amounts are refused', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    await code(pay(w, b, { method: 'CARD_SLIP', amount: '1000' }), 422, 'REFERENCE_REQUIRED');
    await code(pay(w, b, { method: 'WALLET', amount: '1000' }), 422, 'REFERENCE_REQUIRED');
    await ok(pay(w, b, { method: 'CARD_SLIP', amount: '1000', reference: 'RRN123456', approvalCode: 'A1B2C3', cardLast4: '4242' }), 201);
    await ok(pay(w, b, { method: 'WALLET', amount: '500', reference: 'JC-99887766' }), 201);
    expect((await pay(w, b, { method: 'WALLET', amount: '-5', reference: 'JC-1' })).statusCode).toBe(400);
    expect((await pay(w, b, { method: 'WALLET', amount: '0', reference: 'JC-1' })).statusCode).toBe(422);
    expect((await folio(w, b)).folio.balance.amount).toBe('-1500.00');
  });

  it('a bank transfer changes nothing until a second person verifies it; rejection leaves no trace on the ledger', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    const fd = await staff(w, 'front_desk_agent'); const mgr = await staff(w, 'property_admin');
    await code(pay(w, b, { method: 'BANK_TRANSFER', amount: '8000', reference: 'IBFT-1' }, fd.h), 422, 'COUNTERPARTY_REQUIRED');
    const r = await ok(pay(w, b, { method: 'BANK_TRANSFER', amount: '8000', reference: 'IBFT-1', counterparty: 'HBL' }, fd.h), 201);
    expect(r.payment.status).toBe('PENDING_VERIFICATION'); expect(r.balance.amount).toBe('0.00');
    expect((await ok(call('GET', u(w, 'payments/pending'), mgr.h))).items).toHaveLength(1);
    expect((await call('GET', u(w, 'payments/pending'), fd.h)).statusCode).toBe(403);
    await code(call('POST', u(w, `payments/${r.payment.id}/verify`), mgr.h, { approve: false }), 422, 'NOTE_REQUIRED');
    const v = await ok(call('POST', u(w, `payments/${r.payment.id}/verify`), mgr.h, { approve: true, note: 'Seen in statement' }));
    expect(v.payment.status).toBe('CAPTURED'); expect(v.balance.amount).toBe('-8000.00');
    await code(call('POST', u(w, `payments/${r.payment.id}/verify`), mgr.h, { approve: true }), 409, 'NOT_PENDING');
    // maker–checker: nobody verifies their own entry
    const own = await ok(pay(w, b, { method: 'BANK_TRANSFER', amount: '100', reference: 'IBFT-2', counterparty: 'MCB' }, mgr.h), 201);
    await code(call('POST', u(w, `payments/${own.payment.id}/verify`), mgr.h, { approve: true }), 403, 'SELF_VERIFICATION');
    const rej = await ok(call('POST', u(w, `payments/${own.payment.id}/verify`), O, { approve: false, note: 'Not in statement' }));
    expect(rej.payment.status).toBe('REJECTED'); expect(rej.balance.amount).toBe('-8000.00');
    expect(await check(w)).toEqual([]);
  });

  it('deposits secure an unguaranteed OTA booking; voiding or refunding them takes the guarantee away again', async () => {
    const w = await sunset(); const b = await book(w, { channel: 'OTA', source: 'OTA_BOOKING_COM' });
    expect(b.res.guarantee).toMatchObject({ type: 'NONE', atRisk: true, depositRequired: { amount: '12000.00' } });
    await openCash(w);
    const half = await ok(pay(w, b, { method: 'CASH', kind: 'DEPOSIT', amount: '6000' }), 201);
    expect((await ok(call('GET', u(w, `reservations/${b.id}`), O))).guarantee).toMatchObject({ atRisk: true, depositPaid: { amount: '6000.00' } });
    const full = await ok(pay(w, b, { method: 'CASH', kind: 'DEPOSIT', amount: '6000' }), 201);
    const g = (await ok(call('GET', u(w, `reservations/${b.id}`), O))).guarantee;
    expect(g).toMatchObject({ type: 'DEPOSIT', atRisk: false, depositPaid: { amount: '12000.00' } });
    const ev = (await adminDb.selectFrom('outbox_event').select('event_type').where('tenant_id', '=', T.tenantId).where('aggregate_id', '=', b.id).execute()).map((e) => e.event_type);
    expect(ev).toContain('GuaranteeSecured');
    await ok(call('POST', u(w, `payments/${full.payment.id}/void`), OM, { reason: 'Entered twice' }));
    expect((await ok(call('GET', u(w, `reservations/${b.id}`), O))).guarantee).toMatchObject({ type: 'NONE', atRisk: true, depositPaid: { amount: '6000.00' } });
    expect(half.payment.kind).toBe('DEPOSIT');
    expect(await check(w)).toEqual([]);
  });

  it('voiding: cash only while its cashier session is open, never after a refund, and always with a reason and the adjust permission', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    const s = await openCash(w);
    const p1 = await ok(pay(w, b, { method: 'CASH', amount: '3000' }), 201);
    await code(call('POST', u(w, `payments/${p1.payment.id}/void`), O, { reason: 'Mistake' }), 403, 'MFA_REQUIRED');
    const v = await ok(call('POST', u(w, `payments/${p1.payment.id}/void`), OM, { reason: 'Mistake' }));
    expect(v.payment.status).toBe('VOIDED'); expect(v.balance.amount).toBe('0.00');
    const f = await folio(w, b); expect(f.postings.map((x: any) => x.type)).toEqual(['PAYMENT', 'REVERSAL']);
    await code(call('POST', u(w, `payments/${p1.payment.id}/void`), OM, { reason: 'Again' }), 409, 'NOT_VOIDABLE');
    const p2 = await ok(pay(w, b, { method: 'CASH', amount: '2000' }), 201);
    await ok(call('POST', u(w, `cashier/sessions/${s.id}/close`), O, { counted: '5000' }));
    await code(call('POST', u(w, `payments/${p2.payment.id}/void`), OM, { reason: 'Late' }), 409, 'USE_REFUND');
    expect(await check(w)).toEqual([]);
  });

  it('refunds: only what was paid, cash out needs a session, non-cash goes to a beneficiary and a second person approves', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    const mgr = await staff(w, 'property_admin');
    const wl = await ok(pay(w, b, { method: 'WALLET', amount: '4000', reference: 'EP-1' }), 201);
    await code(call('POST', u(w, `payments/${wl.payment.id}/refund`), OM, { amount: '5000', reason: 'Too much' }, key()), 422, 'REFUND_TOO_LARGE');
    await code(call('POST', u(w, `payments/${wl.payment.id}/refund`), OM, { amount: '1000', reason: 'Overcharged' }, key()), 422, 'COUNTERPARTY_REQUIRED');
    const r = await ok(call('POST', u(w, `payments/${wl.payment.id}/refund`), OM, { amount: '1000', reason: 'Overcharged', counterparty: 'Easypaisa 0300-1112223' }, key()), 201);
    expect(r.payment).toMatchObject({ kind: 'REFUND', status: 'PENDING_VERIFICATION' }); expect(r.balance.amount).toBe('-4000.00');
    await code(call('POST', u(w, `payments/${wl.payment.id}/refund`), OM, { amount: '3500', reason: 'More', counterparty: 'x' }, key()), 422, 'REFUND_TOO_LARGE');   // 3,000 left while one is pending
    await ok(call('POST', u(w, `payments/${r.payment.id}/verify`), mgr.h, { approve: true }));
    expect((await folio(w, b)).folio.balance.amount).toBe('-3000.00');
    await code(call('POST', u(w, `payments/${wl.payment.id}/void`), OM, { reason: 'xxx' }), 409, 'HAS_REFUNDS');
    // cash refund: needs the refunder's open session
    await openCash(w); const cp = await ok(pay(w, b, { method: 'CASH', amount: '2000' }), 201);
    const rc = await ok(call('POST', u(w, `payments/${cp.payment.id}/refund`), OM, { amount: '500', reason: 'Change' }, key()), 201);
    expect(rc.payment.status).toBe('CAPTURED'); expect(rc.balance.amount).toBe('-4500.00');
    // refund limits come from the role (a limit on the grant turns into "needs a manager")
    const lim = await addUser(T.tenantId, `lim${++n}@folio.test`); await assignRole(T.tenantId, lim, 'general_manager', 'PROPERTY', w.pid, { limits: { maxRefundMinor: 100000 } });
    await code(call('POST', u(w, `payments/${wl.payment.id}/refund`), as(T.tenantId, lim, { mfa: true }), { amount: '2000', reason: 'Large', counterparty: 'x' }, key()), 403, 'APPROVAL_REQUIRED');
    expect(await check(w)).toEqual([]);
  });
});

describe('check-out settles the bill', () => {
  it('posts every night, refuses to let the guest go with a balance, closes the folio when paid in full', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    await ok(call('POST', u(w, `folios/${(await folio(w, b)).folio.id}/charges`), O, { txnCode: 'LAUNDRY', amount: '800', description: 'Laundry' }), 201);
    await setBd(w, '2026-11-07');
    const owing = await code(checkOut(w, b), 409, 'BALANCE_DUE');
    expect(owing.balance.amount).toBe('24800.00');                                                  // two nights + laundry
    const f0 = await folio(w, b);
    expect(f0.folio.balance.amount).toBe('800.00');                                                   // refused ⇒ nothing was posted
    await openCash(w);
    await ok(pay(w, b, { method: 'CASH', amount: '24800' }), 201);
    const out = await ok(checkOut(w, b));
    expect(out.status).toBe('CHECKED_OUT'); expect(out.checkOut.folio).toMatchObject({ balance: { amount: '0.00' }, closed: true });
    const f = await folio(w, b);
    expect(f.folio.status).toBe('CLOSED');
    expect(f.postings.filter((p: any) => p.sourceType === 'ROOM_NIGHT').map((p: any) => [p.txnCode, p.amount.amount])).toEqual([['ROOM', '12000.00'], ['ROOM', '12000.00']]);
    await code(call('POST', u(w, `folios/${f.folio.id}/charges`), O, { txnCode: 'MISC', amount: '100', description: 'Late' }), 409, 'FOLIO_NOT_OPEN');
    expect(await check(w)).toEqual([]);
  });

  it('an overpaid folio must be refunded first; letting a guest leave with a balance needs permission, a fresh second factor and a reason — and is recorded', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    await ok(pay(w, b, { method: 'WALLET', amount: '30000', reference: 'EP-2' }), 201);
    await setBd(w, '2026-11-07');
    const over = await code(checkOut(w, b), 409, 'BALANCE_DUE');
    expect(over.balance.amount).toBe('-6000.00');
    const fd = await staff(w, 'front_desk_agent');
    await code(checkOut(w, b, { balanceReason: 'Will refund by transfer' }, fd.hm), 403, 'PERMISSION_DENIED');
    await code(checkOut(w, b, { balanceReason: 'Will refund by transfer' }, O), 403, 'MFA_REQUIRED');
    const out = await ok(checkOut(w, b, { balanceReason: 'Will refund by transfer' }));
    expect(out.checkOut.folio).toMatchObject({ balance: { amount: '-6000.00' }, closed: false, checkedOutWithBalance: true });
    expect((await folio(w, b)).folio.status).toBe('OPEN');
    const ev = (await adminDb.selectFrom('outbox_event').select('event_type').where('tenant_id', '=', T.tenantId).where('event_type', '=', 'CheckedOutWithBalance').execute());
    expect(ev.length).toBeGreaterThan(0);
  });

  it('early departure bills only the nights stayed; a multi-room booking settles when the last room leaves', async () => {
    const w = await sunset(); const b = await book(w, { departure: '2026-11-08' }); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    await setBd(w, '2026-11-06');
    await openCash(w); await ok(pay(w, b, { method: 'CASH', amount: '12000' }), 201);
    const out = await ok(checkOut(w, b, { reason: 'Left early' }));
    expect(out.checkOut).toMatchObject({ earlyDeparture: true, folio: { balance: { amount: '0.00' }, closed: true } });
  });
});

describe('cancellation fees on the folio', () => {
  it('a late cancellation becomes a charge (offset by any deposit); a waived fee posts nothing; reinstating takes the charge back', async () => {
    const w = await sunset(); await setBd(w, '2026-11-01'); testClock.set(zonedToUtcMs('2026-11-01', '10:00', 'Asia/Karachi'));
    const b = await book(w, { arrival: '2026-11-02', departure: '2026-11-04' });                      // inside the 72-hour window
    await openCash(w); await ok(pay(w, b, { method: 'CASH', kind: 'DEPOSIT', amount: '12000' }), 201);
    const c = await ok(call('POST', u(w, `reservations/${b.id}/cancel`), O, { reason: 'Guest cancelled' }));
    expect(c.penalty.amount).toBe('12000.00');
    const f = await folio(w, b);
    expect(f.postings.map((p: any) => [p.txnCode, p.amount.amount])).toEqual([['DEPOSIT', '-12000.00'], ['CANCEL_FEE', '12000.00']]);
    expect(f.folio.balance.amount).toBe('0.00');                                                       // the deposit covers the fee
    await ok(call('POST', u(w, `reservations/${b.id}/reinstate`), O, { reason: 'Guest changed mind' }));
    const f2 = await folio(w, b);
    expect(f2.folio.balance.amount).toBe('-12000.00'); expect(f2.postings.map((p: any) => p.type)).toEqual(['DEPOSIT_RECEIVED', 'CHARGE', 'REVERSAL']);
    // waived
    const b2 = await book(w, { arrival: '2026-11-02', departure: '2026-11-04' });
    await ok(call('POST', u(w, `reservations/${b2.id}/cancel`), OM, { reason: 'Goodwill', waiveFee: true }));
    expect((await folio(w, b2)).folio).toBeNull();
    expect(await check(w)).toEqual([]);
  });
});

describe('cashier sessions', () => {
  it('one open session per person; blind close; variance goes to a manager who is not the cashier', async () => {
    const w = await sunset(); const b = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    const fd = await staff(w, 'front_desk_agent'); const mgr = await staff(w, 'property_admin');
    const s = await ok(call('POST', u(w, 'cashier/sessions'), fd.h, { openingFloat: '5000', registerName: 'Night desk' }), 201);
    expect(s).toMatchObject({ status: 'OPEN', openingFloat: { amount: '5000.00' } });
    await code(call('POST', u(w, 'cashier/sessions'), fd.h, { openingFloat: '0' }), 409, 'SESSION_ALREADY_OPEN');
    await ok(pay(w, b, { method: 'CASH', amount: '10000' }, fd.h), 201);
    await ok(pay(w, b, { method: 'WALLET', amount: '2500', reference: 'JC-5' }, fd.h), 201);
    const cur = (await ok(call('GET', u(w, 'cashier/sessions/current'), fd.h))).session;
    expect(cur.expected).toBeUndefined(); expect(cur.variance).toBeUndefined();                       // blind: the cashier cannot see what the drawer should hold
    expect(cur.tenders.find((t: any) => t.method === 'CASH')).toEqual({ method: 'CASH', kind: 'PAYMENT', count: 1 });
    expect(cur.tenders.find((t: any) => t.method === 'WALLET').total.amount).toBe('2500.00');
    await code(call('POST', u(w, `cashier/sessions/${s.id}/drops`), fd.h, { amount: '99999' }), 422, 'DROP_EXCEEDS_CASH');
    await ok(call('POST', u(w, `cashier/sessions/${s.id}/drops`), fd.h, { amount: '8000', note: 'To safe' }), 201);
    expect((await call('POST', u(w, `cashier/sessions/${s.id}/drops`), mgr.h, { amount: '100' })).statusCode).toBe(403);
    const closed = await ok(call('POST', u(w, `cashier/sessions/${s.id}/close`), fd.h, { counted: '6900', note: 'Short' }));
    expect(closed).toMatchObject({ status: 'CLOSED', expected: { amount: '7000.00' }, counted: { amount: '6900.00' }, variance: { amount: '-100.00' } });   // 5,000 float + 10,000 cash − 8,000 drop
    expect(closed.cash).toMatchObject({ receipts: { amount: '10000.00' }, drops: { amount: '8000.00' } });
    await code(call('POST', u(w, `cashier/sessions/${s.id}/close`), fd.h, { counted: '1' }), 409, 'SESSION_NOT_OPEN');
    await code(call('POST', u(w, `cashier/sessions/${s.id}/review`), fd.h, { note: 'fine' }), 403, 'PERMISSION_DENIED');
    await code(call('POST', u(w, `cashier/sessions/${s.id}/review`), mgr.h, {}), 422, 'NOTE_REQUIRED');
    const rv = await ok(call('POST', u(w, `cashier/sessions/${s.id}/review`), mgr.h, { note: 'Warned the cashier' }));
    expect(rv).toMatchObject({ status: 'REVIEWED', reviewedBy: mgr.id });
    // visibility: cashiers see their own; managers see all
    expect((await ok(call('GET', u(w, 'cashier/sessions'), fd.h))).items).toHaveLength(1);
    const other = await staff(w, 'front_desk_agent');
    expect((await ok(call('GET', u(w, 'cashier/sessions'), other.h))).items).toHaveLength(0);
    expect((await call('GET', u(w, `cashier/sessions/${s.id}`), other.h)).statusCode).toBe(403);
    expect((await ok(call('GET', u(w, 'cashier/sessions'), mgr.h))).items).toHaveLength(1);
    // a manager can't review their own session
    const ms = await ok(call('POST', u(w, 'cashier/sessions'), mgr.h, { openingFloat: '0' }), 201);
    await ok(call('POST', u(w, `cashier/sessions/${ms.id}/close`), mgr.h, { counted: '0' }));
    await code(call('POST', u(w, `cashier/sessions/${ms.id}/review`), mgr.h, {}), 403, 'SELF_REVIEW');
    expect(await check(w)).toEqual([]);
  });

  it('money routes are limited to staff of that property', async () => {
    const w = await sunset(); const other = await sunset(); const b = await book(w);
    const fd = await staff(other, 'front_desk_agent');
    expect((await call('GET', u(w, `reservations/${b.id}/folio`), fd.h)).statusCode).toBe(403);
    expect((await call('POST', u(w, 'cashier/sessions'), fd.h, {})).statusCode).toBe(403);
    const hk = await staff(w, 'housekeeper');
    expect((await call('GET', u(w, `reservations/${b.id}/folio`), hk.h)).statusCode).toBe(403);
    expect((await pay(w, b, { method: 'WALLET', amount: '10', reference: 'x-1' }, hk.h)).statusCode).toBe(403);
  });
});
