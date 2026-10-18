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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'pacc'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@pacc.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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


const acct = (o: Record<string, unknown> = {}, h = OM) => call('POST', '/v1/payment-accounts', h, { kind: 'BANK', name: `Account ${++n}`, ownerType: 'COMPANY', ...o });
const pay = (w: W, id: string, body: Record<string, unknown>, h = O) => call('POST', u(w, `reservations/${id}/payments`), h, { method: 'BANK_TRANSFER', amount: '1000', reference: `TRF-${++n}`, counterparty: 'HBL', ...body }, key());
async function setup() { at('2026-11-05', '10:00'); const w = await sunset(); await setBd(w, '2026-11-05'); const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-06' }); return { w, b }; }

describe('payment accounts', () => {
  it('are set up by the people who manage them; an account owned by anyone but the company must say whose and is flagged everywhere', async () => {
    const acc = await addUser(T.tenantId, `acc${++n}@pacc.test`); await assignRole(T.tenantId, acc, 'accountant', 'TENANT', null);
    const clerk = await addUser(T.tenantId, `clerk${++n}@pacc.test`); await assignRole(T.tenantId, clerk, 'front_desk_agent', 'TENANT', null);
    await code(acct({}, as(T.tenantId, clerk, { mfa: true })), 403, 'PERMISSION_DENIED');
    await code(acct({}, as(T.tenantId, acc)), 403, 'MFA_REQUIRED');
    await code(acct({ ownerType: 'PERSONAL' }), 400, 'VALIDATION_FAILED');                                   // whose account?
    const co = await ok(acct({ name: 'HBL Operating', bankName: 'HBL', last4: '4321', accountTitle: 'Sunset Hospitality (Pvt) Ltd' }, as(T.tenantId, acc, { mfa: true })), 201);
    expect(co).toMatchObject({ flagged: false, ownerType: 'COMPANY', last4: '4321' });
    const pers = await ok(acct({ name: 'Owner personal account', ownerType: 'PERSONAL', ownerName: 'Mr Owner', bankName: 'Meezan' }), 201);
    expect(pers).toMatchObject({ flagged: true, ownerType: 'PERSONAL', ownerName: 'Mr Owner' });
    await code(acct({ name: 'hbl operating' }), 409, 'DUPLICATE');
    expect((await ok(call('GET', '/v1/payment-accounts', as(T.tenantId, acc)))).items.map((a: any) => a.name)).toEqual(expect.arrayContaining(['HBL Operating', 'Owner personal account']));
    await code(call('GET', '/v1/payment-accounts', as(T.tenantId, clerk)), 403, 'PERMISSION_DENIED');
    const upd = await ok(call('PATCH', `/v1/payment-accounts/${co.id}`, OM, { note: 'main', version: co.version })); expect(upd.version).toBe(co.version + 1);
    await code(call('PATCH', `/v1/payment-accounts/${co.id}`, OM, { note: 'again', version: co.version }), 412, 'VERSION_CONFLICT');
    const audit = await adminDb.selectFrom('audit_log').select(['action', 'reason_code']).where('tenant_id', '=', T.tenantId).where('action', '=', 'payment_account.create').execute();
    expect(audit.filter((a) => a.reason_code === 'NON_COMPANY_ACCOUNT')).toHaveLength(1);
  });

  it('every non-cash receipt names the account it went into, once accounts exist: required, of the right kind, never guessed; cash goes to the drawer; money out is recorded too', async () => {
    await adminDb.updateTable('payment_account').set({ status: 'CLOSED' }).where('tenant_id', '=', T.tenantId).execute();     // start from a tenant with no accounts
    const { w, b } = await setup();
    const early = await ok(pay(w, b.id, {}), 201);                                                      // no accounts yet: recorded without one (and shown as unassigned later)
    expect(early.payment.status).toBe('PENDING_VERIFICATION');
    const bank = await ok(acct({ name: 'Bank A' }), 201); const personal = await ok(acct({ name: 'Personal B', ownerType: 'PERSONAL', ownerName: 'Mr Owner' }), 201);
    const wallet = await ok(acct({ kind: 'WALLET', name: 'Easypaisa' }), 201);
    const miss = await code(pay(w, b.id, {}), 422, 'PAYMENT_ACCOUNT_REQUIRED'); expect(miss.accounts.map((a: any) => a.name).sort()).toEqual(['Bank A', 'Personal B']);
    await code(pay(w, b.id, { paymentAccountId: wallet.id }), 422, 'PAYMENT_ACCOUNT_INVALID');           // a wallet cannot take a bank transfer
    await code(pay(w, b.id, { method: 'WALLET', reference: 'W-1', paymentAccountId: bank.id }), 422, 'PAYMENT_ACCOUNT_INVALID');
    const ownerPay = await ok(pay(w, b.id, { paymentAccountId: personal.id, amount: '4000' }), 201);
    const wal = await ok(pay(w, b.id, { method: 'WALLET', reference: 'W-2', amount: '500', paymentAccountId: wallet.id }), 201);
    const bankPay = await ok(pay(w, b.id, { paymentAccountId: bank.id, amount: '2500' }), 201);
    expect(wal.payment.status).toBe('CAPTURED');
    const pending = (await ok(call('GET', u(w, 'payments/pending'), O))).items;
    expect(pending.find((x: any) => x.id === ownerPay.payment.id).account).toEqual({ name: 'Personal B', flagged: true });
    expect(pending.find((x: any) => x.id === bankPay.payment.id).account).toEqual({ name: 'Bank A', flagged: false });
    const checker = await staff(w, 'property_admin');
    await ok(call('POST', u(w, `payments/${early.payment.id}/verify`), checker.hm, { approve: true }));
    await ok(call('POST', u(w, `payments/${ownerPay.payment.id}/verify`), checker.hm, { approve: true })); await ok(call('POST', u(w, `payments/${bankPay.payment.id}/verify`), checker.hm, { approve: true }));
    // cash: no account, and none may be named
    await ok(call('POST', u(w, 'cashier/sessions'), O, { openingFloat: '0' }), 201);
    await code(pay(w, b.id, { method: 'CASH', amount: '300', reference: undefined, counterparty: undefined, paymentAccountId: bank.id }), 422, 'PAYMENT_ACCOUNT_INVALID');
    await ok(pay(w, b.id, { method: 'CASH', amount: '300', reference: undefined, counterparty: undefined }), 201);
    // a refund by bank transfer needs an account as well
    await code(call('POST', u(w, `payments/${bankPay.payment.id}/refund`), OM, { amount: '500', reason: 'Guest left early', method: 'BANK_TRANSFER', counterparty: 'Guest HBL 9999', reference: 'RF-1' }, key()), 422, 'PAYMENT_ACCOUNT_REQUIRED');
    const refund = await ok(call('POST', u(w, `payments/${bankPay.payment.id}/refund`), OM, { amount: '500', reason: 'Guest left early', method: 'BANK_TRANSFER', counterparty: 'Guest HBL 9999', reference: 'RF-1', paymentAccountId: bank.id }, key()), 201);
    await ok(call('POST', u(w, `payments/${refund.payment.id}/verify`), checker.hm, { approve: true }));
    // a closed account can no longer be chosen
    const closed = await ok(acct({ name: 'Old bank' }), 201);
    await ok(call('POST', `/v1/payment-accounts/${closed.id}/close`, OM, { version: closed.version, reason: 'Account closed at the bank' }));
    await code(pay(w, b.id, { paymentAccountId: closed.id }), 422, 'PAYMENT_ACCOUNT_INVALID');
    expect((await ok(call('GET', u(w, 'payment-accounts'), O))).items.map((a: any) => a.name)).not.toContain('Old bank');

    const s = await ok(call('GET', '/v1/payment-accounts/summary?from=2026-11-01&to=2026-11-30', OM));
    const byName = Object.fromEntries(s.items.map((i: any) => [i.name, i]));
    expect(byName['Bank A']).toMatchObject({ in: { amount: '2500.00' }, out: { amount: '500.00' }, net: { amount: '2000.00' }, flagged: false });
    expect(byName['Personal B']).toMatchObject({ in: { amount: '4000.00' }, flagged: true });
    expect(byName['Easypaisa']).toMatchObject({ in: { amount: '500.00' } });
    expect(s.nonCompany).toMatchObject({ accounts: 1, in: { amount: '4000.00' } });
    expect(s.unassigned).toMatchObject({ count: 1, in: { amount: '1000.00' } });
    const mg = await ok(call('GET', '/v1/management/overview?from=2026-11-01&to=2026-11-30', OM));
    expect(mg.accounts).toMatchObject({ nonCompany: { accounts: 1, in: { amount: '4000.00' } }, unassigned: { count: 1 } });                       // the transfer taken before any account existed stays visible
  });

  it('company payments and OTA money also say where they went', async () => {
    const { w } = await setup();
    const bank = await ok(acct({ name: 'Bank for AR' }), 201);
    const co = await ok(call('POST', '/v1/companies', O, { name: `Acct Co ${++n}` }), 201);
    const rec = (body: Record<string, unknown> = {}) => call('POST', `/v1/companies/${co.id}/receipts`, O, { method: 'BANK_TRANSFER', amount: '100', reference: `R-${++n}`, receivedOn: '2026-11-05', ...body });
    await code(rec(), 422, 'PAYMENT_ACCOUNT_REQUIRED');
    const r = await ok(rec({ paymentAccountId: bank.id }), 201); expect(r.status).toBe('PENDING_VERIFICATION');
    const s = await ok(call('GET', '/v1/payment-accounts/summary?from=2026-11-01&to=2026-11-30', OM));
    expect(s.items.find((i: any) => i.name === 'Bank for AR').in.amount).toBe('0.00');                 // not counted until verified
    void w;
  });
});
