import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { zonedToUtcMs } from '@hos/domain-types';
import { addUser, adminDb, as, assignRole, createTestApp, provision, testClock } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
let O: Record<string, string>, OM: Record<string, string>, ACC: ReturnType<typeof as>, ACCM: ReturnType<typeof as>;
const OPEN = '2026-11-01';
let n = 0;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...headers, ...extra }, payload: body as object | undefined });
const ok = async (r: Promise<any>, status = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json(); };
const code = async (r: Promise<any>, status: number, c: string) => { const x = await r; expect(x.statusCode, x.body).toBe(status); expect(x.json().code).toBe(c); return x.json(); };
const key = () => ({ 'idempotency-key': `tx-${++n}-${Date.now()}` });
const at = (date: string, time: string) => testClock.set(zonedToUtcMs(date, time, 'Asia/Karachi'));

beforeAll(async () => {
  app = await createTestApp(); T = await provision(app, 'corp'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true });
  const acc = await addUser(T.tenantId, 'accountant@corp.test'); await assignRole(T.tenantId, acc, 'accountant', 'TENANT', null);
  ACC = as(T.tenantId, acc); ACCM = as(T.tenantId, acc, { mfa: true });
});
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

// Fictional rates for the tests only — the product itself ships with none.
const version = (o: Record<string, unknown> = {}) => ({ rateBp: 1000, appliesTo: ['ROOM', 'ROOM_EXTRAS'], effectiveFrom: '2026-01-01', ...o });
async function activate(codeName: string, jurisdiction: string, v: Record<string, unknown> = {}, name = codeName) {
  const c = await ok(call('POST', '/v1/tax/codes', ACCM, { code: codeName, name, jurisdiction, version: version(v) }), 201);
  const a = await ok(call('POST', `/v1/tax/versions/${c.version.id}/approve`, OM, { advisorRef: 'TEST-ADVISOR-1', legalBasis: 'Test fixture, not law' }));
  return { codeId: c.id as string, versionId: a.id as string };
}
async function sunset(jurisdiction?: string) {
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `TX${++n}`, name: `Tax ${n}` })).json().id as string;
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'STD', name: 'Standard', maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id as string;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, from: 101, to: 104 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'BAR', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '12000', extraAdult: '3000', extraChild: '1500' }] });
  const intl = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'INTL', name: 'Intl', residency: 'NON_RESIDENT', ...rules, derive: { parentPlanId: bar, type: 'PERCENT', value: 0, roundTo: '1' } })).json().id as string;
  void intl;
  const rooms = (await call('GET', `/v1/properties/${pid}/rooms`, O)).json().items as Array<{ id: string; number: string }>;
  if (jurisdiction) await ok(call('PUT', `/v1/properties/${pid}/tax-jurisdiction`, OM, { jurisdiction }));
  return { pid, rt, room: Object.fromEntries(rooms.map((r) => [r.number, r.id])) as Record<string, string> };
}
type W = Awaited<ReturnType<typeof sunset>>;
const u = (w: W, tail: string) => `/v1/properties/${w.pid}/${tail}`;
const setBd = (w: W, d: string) => adminDb.updateTable('property').set({ business_date: d }).where('id', '=', w.pid).execute();
async function book(w: W, o: { arrival?: string; departure?: string; nationality?: string; name?: string } = {}) {
  const foreign = !!o.nationality && o.nationality !== 'PK';
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival ?? '2026-11-05', departure: o.departure ?? '2026-11-07', adults: 2, channel: 'PHONE', residency: foreign ? 'NON_RESIDENT' : 'RESIDENT' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: o.name ?? `Guest ${++n}`, phone: `0300${String(7000000 + n).slice(-7)}`, nationality: o.nationality ?? 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string, quote: q };
}
const checkIn = (w: W, b: { id: string; line: string }, room: string, passport = false) => ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-in`), O, { roomId: w.room[room], occupants: [passport ? { fullName: 'Guest', isPrimary: true, idType: 'PASSPORT', idNumber: 'GB1234567', nationality: 'GB' } : { fullName: 'Guest', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671' }] }));
const checkOut = (w: W, b: { id: string; line: string }, body: Record<string, unknown> = {}) => call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-out`), OM, body);
const folio = (w: W, b: { id: string }) => ok(call('GET', u(w, `reservations/${b.id}/folio`), O));
const bal = async (w: W, b: { id: string }) => (await folio(w, b)).folio.balance.amount as string;
const charge = (w: W, fid: string, amount: string, txnCode = 'FNB') => ok(call('POST', u(w, `folios/${fid}/charges`), O, { txnCode, amount, description: 'Item' }), 201);


let FD: ReturnType<typeof as>, FDM: ReturnType<typeof as>;
beforeAll(async () => {
  const fd = await addUser(T.tenantId, 'desk@corp.test'); await assignRole(T.tenantId, fd, 'front_desk_agent', 'TENANT', null);
  FD = as(T.tenantId, fd); FDM = as(T.tenantId, fd, { mfa: true });
});
async function company(over: Record<string, unknown> = {}) {
  return ok(call('POST', '/v1/companies', OM, { name: `Acme ${++n} Ltd`, ntn: '1234567-8', creditLimit: '100000', termsDays: 30, ...over }), 201);
}
const usedRooms = new Map<string, number>();
/** A stay with a manual charge of `amount` outstanding on the bill (nights post at the night audit). */
async function stayOwing(w: W, companyId: string | null, amount = '5000') {
  await setBd(w, '2026-11-05'); at('2026-11-05', '10:00');
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: '2026-11-05', departure: '2026-11-06', adults: 1, channel: 'PHONE', ...(companyId ? { companyId } : {}) })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Traveller ${++n}`, phone: `0300${String(6000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'CORPORATE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
  const b = { id: r.id as string, line: r.lines[0].id as string };
  const room = Object.keys(w.room).sort()[(usedRooms.get(w.pid) ?? 0)]!; usedRooms.set(w.pid, (usedRooms.get(w.pid) ?? 0) + 1);
  await adminDb.updateTable('room').set({ hk_status: 'CLEAN' }).where('id', '=', w.room[room]!).execute();
  await checkIn(w, b, room);
  const f = await folio(w, b);
  await charge(w, f.folio.id, amount);
  return { ...b, folioId: f.folio.id as string };
}
const bill = (w: W, b: { id: string }, body: Record<string, unknown> = {}, h: Record<string, string> = O) => call('POST', u(w, `reservations/${b.id}/bill-to-company`), h, body, key());
const owes = async (id: string) => (await ok(call('GET', `/v1/companies/${id}`, O))).owed.amount as string;
const receipt = (cid: string, body: Record<string, unknown>, h: Record<string, string> = ACC) => call('POST', `/v1/companies/${cid}/receipts`, h, { method: 'BANK_TRANSFER', receivedOn: '2026-11-05', reference: `REF-${++n}-${Date.now()}`, counterparty: 'HBL', ...body });

describe('corporate accounts', () => {
  it('are created by people who manage them; the credit limit and terms need a second factor; names are unique; a front-desk agent can look but not change', async () => {
    await code(call('POST', '/v1/companies', O, { name: 'Needs MFA Ltd', creditLimit: '50000' }), 403, 'MFA_REQUIRED');
    const noCredit = await ok(call('POST', '/v1/companies', O, { name: `Cash Co ${++n}` }), 201);
    expect(noCredit).toMatchObject({ creditLimit: { amount: '0.00' }, termsDays: 30, status: 'ACTIVE', owed: { amount: '0.00' } });
    const c = await company({ name: 'Unique Name Ltd' });
    expect(c).toMatchObject({ creditLimit: { amount: '100000.00' }, available: { amount: '100000.00' } });
    await code(call('POST', '/v1/companies', OM, { name: 'unique name ltd' }), 409, 'DUPLICATE');
    expect((await ok(call('GET', '/v1/companies?q=unique', FD))).items.map((x: any) => x.id)).toEqual([c.id]);
    await code(call('POST', '/v1/companies', FDM, { name: 'Sneaky Ltd' }), 403, 'PERMISSION_DENIED');
    await code(call('PATCH', `/v1/companies/${c.id}`, O, { creditLimit: '900000' }), 403, 'MFA_REQUIRED');
    expect(await ok(call('PATCH', `/v1/companies/${c.id}`, OM, { creditLimit: '120000', contactName: 'Ms Khan' }))).toMatchObject({ creditLimit: { amount: '120000.00' }, contactName: 'Ms Khan', version: 2 });
    await code(call('PUT', `/v1/companies/${c.id}/status`, O, { status: 'ON_HOLD' }), 400, 'VALIDATION_FAILED');
    expect(await ok(call('PUT', `/v1/companies/${c.id}/status`, O, { status: 'ON_HOLD', reason: 'Overdue 90 days' }))).toMatchObject({ status: 'ON_HOLD', holdReason: 'Overdue 90 days' });
  });

  it('are the only companies a quote can name: an unknown or archived company is refused', async () => {
    const w = await sunset();
    await code(call('POST', u(w, 'quotes'), O, { arrival: '2026-11-05', departure: '2026-11-06', adults: 1, channel: 'PHONE', companyId: '11111111-1111-4111-8111-111111111111' }), 422, 'COMPANY_NOT_FOUND');
    const c = await company(); await ok(call('PUT', `/v1/companies/${c.id}/status`, O, { status: 'ARCHIVED', reason: 'Closed account' }));
    await code(call('POST', u(w, 'quotes'), O, { arrival: '2026-11-05', departure: '2026-11-06', adults: 1, channel: 'PHONE', companyId: c.id }), 422, 'COMPANY_ARCHIVED');
  });
});

describe('billing a stay to a company', () => {
  it('moves the amount from the guest’s bill to the company’s account, within its credit limit; a retry changes nothing; the due date follows the terms', async () => {
    const w = await sunset(); const c = await company({ creditLimit: '10000', termsDays: 15 });
    const b = await stayOwing(w, c.id, '6000');
    await code(bill(w, b, { amount: '0' }), 422, 'AMOUNT_INVALID');
    await code(bill(w, b, { amount: '9000' }), 422, 'AMOUNT_TOO_LARGE');
    const k = key();
    const first = await ok(call('POST', u(w, `reservations/${b.id}/bill-to-company`), O, { amount: '2500' }, k), 201);
    expect(first.item).toMatchObject({ companyId: c.id, amount: { amount: '2500.00' }, open: { amount: '2500.00' }, billedOn: '2026-11-05', dueOn: '2026-11-20', status: 'OPEN', confirmationNo: expect.any(String) });
    expect(first.balance.amount).toBe('3500.00');
    const again = await ok(call('POST', u(w, `reservations/${b.id}/bill-to-company`), O, { amount: '2500' }, k), 200);
    expect(again.replayed).toBe(true); expect(await owes(c.id)).toBe('2500.00');
    // the rest of the balance: no amount means "all of it"
    const rest = await ok(bill(w, b), 201);
    expect(rest.balance.amount).toBe('0.00'); expect(await owes(c.id)).toBe('6000.00');
    expect((await folio(w, b)).postings.find((p: any) => p.txnCode === 'AR_TRANSFER')).toMatchObject({ type: 'PAYMENT', amount: { amount: '-2500.00' } });
    await code(bill(w, b), 422, 'NOTHING_TO_BILL');
    expect((await ok(call('GET', u(w, `reservations/${b.id}/company-billings`), O))).items).toHaveLength(2);
  });

  it('stops at the credit limit and at a company on hold; a manager can override with a reason and a second factor; nobody else can', async () => {
    const w = await sunset(); const c = await company({ creditLimit: '4000' });
    const b = await stayOwing(w, c.id, '5000');
    const r = await code(bill(w, b, { amount: '4500' }), 403, 'CREDIT_LIMIT_EXCEEDED');
    expect(r).toMatchObject({ overridable: true, limit: { amount: '4000.00' }, requested: { amount: '4500.00' } });
    await ok(bill(w, b, { amount: '4000' }), 201);                                                  // exactly the limit is fine
    await code(bill(w, b, { amount: '500' }), 403, 'CREDIT_LIMIT_EXCEEDED');
    const ov = { amount: '500', override: { reason: 'Director approved by phone' } };
    await code(bill(w, b, ov, FDM), 403, 'PERMISSION_DENIED');                                      // a front-desk agent cannot override
    await code(bill(w, b, ov, O), 403, 'MFA_REQUIRED');
    const done = await ok(bill(w, b, ov, OM), 201);
    expect(done.item.overrideReason).toBe('Director approved by phone');
    // on hold
    const h = await company({ creditLimit: '90000' }); await ok(call('PUT', `/v1/companies/${h.id}/status`, O, { status: 'ON_HOLD', reason: 'Unpaid statements' }));
    const b2 = await stayOwing(w, h.id, '1000');
    await code(bill(w, b2), 403, 'COMPANY_ON_HOLD');
    await ok(bill(w, b2, { override: { reason: 'Paying tomorrow' } }, OM), 201);
    // no credit at all by default
    const none = await ok(call('POST', '/v1/companies', O, { name: `No Credit ${++n}` }), 201);
    const b3 = await stayOwing(w, null, '700');
    await code(bill(w, b3, { companyId: none.id }), 403, 'CREDIT_LIMIT_EXCEEDED');
    await code(bill(w, b3), 422, 'COMPANY_REQUIRED');                                                // no company on the booking and none chosen
  });

  it('can be cancelled while nothing has been paid against it: the amount returns to the guest’s bill and the ledger still agrees with itself', async () => {
    const w = await sunset(); const c = await company();
    const b = await stayOwing(w, c.id, '3000');
    const item = (await ok(bill(w, b), 201)).item;
    expect(await bal(w, b)).toBe('0.00');
    await code(call('POST', u(w, `ar-items/${item.id}/void`), O, { reason: 'Billed in error' }), 403, 'MFA_REQUIRED');
    const v = await ok(call('POST', u(w, `ar-items/${item.id}/void`), OM, { reason: 'Billed in error' }));
    expect(v).toMatchObject({ status: 'CANCELLED', open: { amount: '0.00' }, voidReason: 'Billed in error' });
    expect(await bal(w, b)).toBe('3000.00'); expect(await owes(c.id)).toBe('0.00');
    await code(call('POST', u(w, `ar-items/${item.id}/void`), OM, { reason: 'Again please' }), 409, 'ALREADY_VOID');
    const issues = await ok(call('GET', u(w, 'folio-check'), O)); expect(issues.ok).toBe(true);
    // a billing that has been paid cannot be cancelled
    const item2 = (await ok(bill(w, b), 201)).item;
    const rc = await ok(receipt(c.id, { amount: '1000' }), 201); await ok(call('POST', `/v1/ar/receipts/${rc.id}/verify`, O, { approve: true }));
    await code(call('POST', u(w, `ar-items/${item2.id}/void`), OM, { reason: 'Too late' }), 409, 'ITEM_HAS_PAYMENTS');
  });
});

describe('money received from a company', () => {
  it('is recorded by one person and verified by another; it settles the oldest bills first; the rest stays as credit on account and is used by the next billing', async () => {
    const w = await sunset(); const c = await company();
    const b1 = await stayOwing(w, c.id, '3000'); await ok(bill(w, b1), 201);
    await setBd(w, '2026-11-06'); const b2 = await stayOwing(w, c.id, '2000');
    await setBd(w, '2026-11-06'); await ok(bill(w, b2), 201);
    expect(await owes(c.id)).toBe('5000.00');
    const r = await ok(receipt(c.id, { amount: '4000' }), 201);
    expect(r.status).toBe('PENDING_VERIFICATION'); expect(await owes(c.id)).toBe('5000.00');          // nothing counts until verified
    await code(call('POST', `/v1/ar/receipts/${r.id}/verify`, ACC, { approve: true }), 403, 'SELF_VERIFICATION');
    await code(call('POST', `/v1/ar/receipts/${r.id}/verify`, FD, { approve: true }), 403, 'PERMISSION_DENIED');
    const v = await ok(call('POST', `/v1/ar/receipts/${r.id}/verify`, O, { approve: true }));
    expect(v).toMatchObject({ status: 'CAPTURED', applied: { amount: '4000.00' }, onAccount: { amount: '0.00' } });
    expect(await owes(c.id)).toBe('1000.00');
    const items = (await ok(call('GET', `/v1/companies/${c.id}/items`, O))).items;
    expect(items.map((i: any) => [i.status, i.open.amount])).toEqual([['PAID', '0.00'], ['PART_PAID', '1000.00']]);
    expect((await ok(call('GET', `/v1/companies/${c.id}/items?open=true`, O))).items).toHaveLength(1);
    // overpay: the surplus waits on account…
    const r2 = await ok(receipt(c.id, { amount: '1500' }), 201);
    expect(await ok(call('POST', `/v1/ar/receipts/${r2.id}/verify`, O, { approve: true }))).toMatchObject({ applied: { amount: '1000.00' }, onAccount: { amount: '500.00' } });
    expect(await owes(c.id)).toBe('-500.00');
    // …and the next billing uses it
    const b3 = await stayOwing(w, c.id, '800'); await ok(bill(w, b3), 201);
    expect(await owes(c.id)).toBe('300.00');
    expect((await ok(call('GET', `/v1/ar/aging`, O))).items.find((x: any) => x.companyId === c.id)).toMatchObject({ onAccount: { amount: '0.00' }, totalOpen: { amount: '300.00' } });
  });

  it('can name the bills it pays; tax withheld by the company settles what is owed too but needs its certificate number; references are not accepted twice; a rejection needs a reason', async () => {
    const w = await sunset(); const c = await company();
    const b1 = await stayOwing(w, c.id, '3000'); const i1 = (await ok(bill(w, b1), 201)).item;
    await setBd(w, '2026-11-06'); const b2 = await stayOwing(w, c.id, '2000'); await setBd(w, '2026-11-06'); const i2 = (await ok(bill(w, b2), 201)).item;
    const r = await ok(receipt(c.id, { amount: '1800', withheld: '200', withholdingRef: 'CPR-77', applyTo: [i2.id] }), 201);
    expect(r).toMatchObject({ withheld: { amount: '200.00' }, total: { amount: '2000.00' }, withholdingRef: 'CPR-77' });
    await ok(call('POST', `/v1/ar/receipts/${r.id}/verify`, O, { approve: true }));
    const items = (await ok(call('GET', `/v1/companies/${c.id}/items`, O))).items;
    expect(items.find((i: any) => i.id === i2.id).status).toBe('PAID'); expect(items.find((i: any) => i.id === i1.id).status).toBe('OPEN');   // the named bill first, not the oldest
    await code(receipt(c.id, { amount: '100', withheld: '10' }), 422, 'WITHHOLDING_REF_REQUIRED');
    await code(receipt(c.id, { amount: '100', reference: r.reference }), 409, 'DUPLICATE_REFERENCE');
    const bad = await ok(receipt(c.id, { amount: '999' }), 201);
    await code(call('POST', `/v1/ar/receipts/${bad.id}/verify`, O, { approve: false }), 422, 'NOTE_REQUIRED');
    expect(await ok(call('POST', `/v1/ar/receipts/${bad.id}/verify`, O, { approve: false, note: 'Not on our bank statement' }))).toMatchObject({ status: 'REJECTED' });
    await code(call('POST', `/v1/ar/receipts/${bad.id}/verify`, O, { approve: true }), 409, 'NOT_PENDING');
    expect(await owes(c.id)).toBe('3000.00');
    expect((await ok(call('GET', '/v1/ar/receipts?status=PENDING_VERIFICATION', O))).items.some((x: any) => x.id === bad.id)).toBe(false);
  });
});

describe('statements and ageing', () => {
  it('show what was billed and received with a running balance, and age what is unpaid by how late it is', async () => {
    const w = await sunset(); const c = await company({ name: 'Stmt <b>Co</b> & Sons', termsDays: 10 });
    const b1 = await stayOwing(w, c.id, '1000'); await ok(bill(w, b1), 201);                          // billed 2026-11-05, due 2026-11-15
    await setBd(w, '2026-12-01'); const b2 = await stayOwing(w, c.id, '2000'); await setBd(w, '2026-12-01'); await ok(bill(w, b2), 201);   // due 2026-12-11
    await setBd(w, '2026-12-20'); const b3 = await stayOwing(w, c.id, '4000'); await setBd(w, '2026-12-20'); await ok(bill(w, b3), 201);   // due 2012-12-30
    const rc = await ok(receipt(c.id, { amount: '500', receivedOn: '2026-12-02' }), 201); await ok(call('POST', `/v1/ar/receipts/${rc.id}/verify`, O, { approve: true }));
    const ag = await ok(call('GET', '/v1/ar/aging?asOf=2026-12-20', O));
    const mine = ag.items.find((x: any) => x.companyId === c.id);
    expect(mine.buckets).toMatchObject({ current: { amount: '4000.00' }, d1_30: { amount: '2000.00' }, d31_60: { amount: '500.00' }, d61_90: { amount: '0.00' }, d90plus: { amount: '0.00' } });
    expect(mine.totalOpen.amount).toBe('6500.00');
    const st = await ok(call('GET', `/v1/companies/${c.id}/statement?from=2026-12-01&to=2026-12-31`, O));
    expect(st).toMatchObject({ opening: { amount: '1000.00' }, billed: { amount: '6000.00' }, received: { amount: '500.00' }, closing: { amount: '6500.00' } });
    expect(st.lines.map((l: any) => [l.kind, l.balance.amount])).toEqual([['BILLED', '3000.00'], ['RECEIPT', '2500.00'], ['BILLED', '6500.00']]);
    const page = await call('GET', `/v1/companies/${c.id}/statement/print?from=2026-12-01&to=2026-12-31`, O);
    expect(page.statusCode).toBe(200); expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.body).toContain('Stmt &lt;b&gt;Co&lt;/b&gt; &amp; Sons'); expect(page.body).not.toContain('<b>Co</b>');
  });
});

describe('invoices to a company, and who can see what', () => {
  it('an invoice can be made out to the corporate account with its registered numbers and shows the amount as charged to the account', async () => {
    const w = await sunset(); const c = await company({ name: 'Invoice Co', ntn: '9999999-9', strn: 'S-123', address: 'Blue Area, Islamabad' });
    const b = await stayOwing(w, c.id, '2000'); await ok(bill(w, b), 201);
    await setBd(w, '2026-11-06'); await ok(checkOut(w, b, { balanceReason: 'Rest goes to the company account' }));
    await ok(bill(w, b), 201);                                                                          // the night's room charge posted at check-out
    const inv = await ok(call('POST', u(w, `reservations/${b.id}/invoices`), O, { companyId: c.id }), 201);
    expect(inv.billTo).toMatchObject({ name: 'Invoice Co', ntn: '9999999-9', strn: 'S-123', address: 'Blue Area, Islamabad', companyId: c.id });
    expect(inv.payments.received).toEqual([{ method: 'COMPANY_CREDIT', amountMinor: '1400000' }]);
    await code(call('POST', u(w, `reservations/${b.id}/invoices`), O, { companyId: '22222222-2222-4222-8222-222222222222' }), 422, 'NOTHING_TO_INVOICE');
  });

  it('are private to the tenant and need the right permission', async () => {
    const c = await company();
    const other = await provision(app, 'corp-other'); const OO = as(other.tenantId, other.ownerUserId, { mfa: true });
    await code(call('GET', `/v1/companies/${c.id}`, OO), 404, 'NOT_FOUND');
    expect((await ok(call('GET', '/v1/companies', OO))).items).toHaveLength(0);
    const acc = await ok(call('GET', `/v1/companies/${c.id}`, ACC)); expect(acc.id).toBe(c.id);
    await code(receipt(c.id, { amount: '10' }, FD), 403, 'PERMISSION_DENIED');
  });
});
