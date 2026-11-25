import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { zonedToUtcMs } from '@hos/domain-types';
import { addUser, adminDb, as, assignRole, createTestApp, provision, testClock } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
let O: Record<string, string>;
const OPEN = '2026-11-01';
let n = 0;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...headers, ...extra }, payload: body as object | undefined });
const ok = async (r: Promise<any>, status = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json(); };
const code = async (r: Promise<any>, status: number, c: string) => { const x = await r; expect(x.statusCode, x.body).toBe(status); expect(x.json().code).toBe(c); return x.json(); };
const key = () => ({ 'idempotency-key': `cm-${++n}-${Date.now()}` });
const at = (date: string, time: string) => testClock.set(zonedToUtcMs(date, time, 'Asia/Karachi'));

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'banks'); O = as(T.tenantId, T.ownerUserId); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

const U = (t: string) => `/v1/finance/${t}`;
describe('banks, cash and simple vouchers', () => {
  it('bank accounts need setting up before use; owner-titled ones need authorising; cash closes daily with approved variances; contra and receipt vouchers post', async () => {
    at('2026-11-10', '10:00');
    const OM = as(T.tenantId, T.ownerUserId, { mfa: true });
    const mkProp = async () => (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `BK${++n}`, name: `Branch ${n}` })).json().id as string;
    const p1 = await mkProp(), p2 = await mkProp();
    const mk = async (role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@banks.test`); await assignRole(T.tenantId, id, role, 'TENANT', null); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };
    const prep = await mk('accountant'), fd = await mk('front_desk_agent'), hk = await mk('housekeeper');
    await ok(call('POST', U('accounts/starter'), OM)); await ok(call('POST', U('pms/enable'), OM, { from: '2026-11-01' }));
    await ok(call('PUT', U('settings'), OM, { selfApproveLimit: '1000000' }));
    const bankBody = (name: string, over: object = {}) => ({ kind: 'BANK', name, bankName: 'Test Bank', accountTitle: 'Sunset BNB', iban: 'PK36SCBL0000001123456702', accountNumber: '0123456789', ...over });
    const co = await ok(call('POST', '/v1/payment-accounts', OM, bankBody('Company bank')), 201);
    const own = await ok(call('POST', '/v1/payment-accounts', OM, bankBody('Partner account', { ownerType: 'PERSONAL', ownerName: 'Farooq Saleh' })), 201);
    let banks = (await ok(call('GET', U('banks'), prep.h))).items; const b1 = banks.find((b: any) => b.id === co.id);
    expect(b1).toMatchObject({ status: 'NEEDS_SETUP', iban: '•••• 6702', accountNumber: '•••• 6789', ledger: null }); expect(JSON.stringify(banks)).not.toContain('PK36SCBL');
    await code(call('GET', U('banks'), fd.h), 403, 'PERMISSION_DENIED');
    const rcv = (bankId: string, branchId: string, amt = '2500') => call('POST', U('vouchers/quick'), prep.h, { type: 'BRV', date: '2026-11-10', narration: 'Guest transfer', amount: amt, money: { kind: 'BANK', bankId, branchId }, other: '4010' });
    await code(rcv(co.id, p1), 409, 'BANK_NO_LEDGER');
    expect((await ok(call('POST', U(`banks/${co.id}/ledger-account`), OM))).code).toBe('1101'); await code(call('POST', U(`banks/${co.id}/ledger-account`), OM), 409, 'ALREADY_LINKED');
    await code(rcv(co.id, p1), 409, 'BANK_NOT_MAPPED');
    await ok(call('PUT', U(`banks/${co.id}`), OM, { accountType: 'CURRENT', purpose: 'COLLECTIONS', branchIds: [p1] }));
    await code(rcv(co.id, p2), 409, 'BANK_BRANCH_NOT_MAPPED');
    const v1 = await ok(rcv(co.id, p1), 201); await ok(call('POST', U(`vouchers/${v1.id}/submit`), prep.h)); await ok(call('POST', U(`vouchers/${v1.id}/approve`), OM));
    const tb = async (extra = '') => (await ok(call('GET', U(`reports/trial-balance?from=2026-11-01&to=2026-11-30${extra}`), O))).rows as any[];
    expect((await tb()).find((r) => r.code === '1101')).toMatchObject({ closingDr: '2500.00' });
    expect((await ok(call('GET', U('banks'), prep.h))).items.find((b: any) => b.id === co.id)).toMatchObject({ status: 'READY', ledger: { code: '1101' }, purpose: 'COLLECTIONS', branches: [{ id: p1 }] });
    // a PMS bank-transfer receipt for this account now lands in its own ledger account, not suspense
    expect((await ok(call('GET', U('pms'), O))).paymentAccounts.find((m: any) => m.key === `PAYACC:${co.id}`).account).toBe('1101');
    // an account in someone else's name needs authorising, and its vouchers always need a second person
    await ok(call('POST', U(`banks/${own.id}/ledger-account`), OM)); await ok(call('PUT', U(`banks/${own.id}`), OM, { accountType: 'CURRENT', purpose: 'BOTH', branchIds: [p1, p2] }));
    expect((await ok(call('GET', U('banks'), prep.h))).items.find((b: any) => b.id === own.id).status).toBe('NEEDS_AUTHORISATION');
    await code(rcv(own.id, p1), 409, 'BANK_NOT_AUTHORISED');
    await code(call('POST', U(`banks/${co.id}/authorise`), OM, { note: 'not needed here' }), 409, 'NOT_NEEDED'); await code(call('POST', U(`banks/${own.id}/authorise`), OM, { note: 'no' }), 400, 'VALIDATION_FAILED');
    await ok(call('POST', U(`banks/${own.id}/authorise`), OM, { note: 'Partner of the company; used for non-tax transfers. Approved by the CEO.' }));
    const v2 = await ok(rcv(own.id, p2, '700'), 201); await ok(call('POST', U(`vouchers/${v2.id}/submit`), prep.h)); await code(call('POST', U(`vouchers/${v2.id}/approve`), prep.hm), 403, 'FINANCE_SELF_APPROVAL');   // allowed limit is large, but this account is owner-titled
    await ok(call('POST', U(`vouchers/${v2.id}/approve`), OM));
    // full details only to those allowed, and every look is recorded
    const rev = await ok(call('GET', U(`banks/${co.id}/reveal`), prep.hm)); expect(rev).toEqual({ iban: 'PK36SCBL0000001123456702', accountNumber: '0123456789' });
    await code(call('GET', U(`banks/${co.id}/reveal`), fd.hm), 403, 'PERMISSION_DENIED');
    expect((await adminDb.selectFrom('audit_log').select('id').where('action', '=', 'finance.bank.reveal').where('resource_id', '=', co.id).execute()).length).toBe(1);
    // cash drawers
    await code(call('POST', U('cash/drawers'), prep.h, { propertyId: p1, kind: 'CASH', name: 'Front desk cash' }), 403, 'MFA_REQUIRED');
    await ok(call('POST', U('cash/drawers'), OM, { propertyId: p1, kind: 'CASH', name: 'Front desk cash', openingFloat: '1000', maxLimit: '100000' }), 201);
    const dr = (await ok(call('GET', U(`cash/drawers?propertyId=${p1}`), O))).items[0];
    await code(call('POST', U('cash/drawers'), OM, { propertyId: p1, kind: 'CASH', name: 'Another' }), 409, 'DRAWER_EXISTS');
    const crv = await ok(call('POST', U('vouchers/quick'), prep.h, { type: 'CRV', date: '2026-11-10', narration: 'Cash sale', amount: '5000', money: { kind: 'CASH', branchId: p1 }, other: '4010' }), 201);
    await ok(call('POST', U(`vouchers/${crv.id}/submit`), prep.h)); await ok(call('POST', U(`vouchers/${crv.id}/approve`), OM));
    expect((await ok(call('GET', U(`cash/drawers?propertyId=${p1}`), O))).items[0]).toMatchObject({ balance: '5000.00', overLimit: false });
    await code(call('POST', U(`cash/drawers/${dr.id}/close`), hk.h, { date: '2026-11-10', counted: '4800', note: 'x' }), 403, 'PERMISSION_DENIED');
    await code(call('POST', U(`cash/drawers/${dr.id}/close`), prep.h, { date: '2026-11-10', counted: '4800' }), 400, 'EXPLANATION_REQUIRED');
    const cl = await ok(call('POST', U(`cash/drawers/${dr.id}/close`), prep.h, { date: '2026-11-10', counted: '4800', note: 'Change given to a guest was not written down' }), 201);
    expect(cl).toMatchObject({ expected: '5000.00', counted: '4800.00', variance: '-200.00', status: 'PENDING_APPROVAL' });
    await code(call('POST', U(`cash/drawers/${dr.id}/close`), prep.h, { date: '2026-11-10', counted: '4800', note: 'again' }), 409, 'ALREADY_CLOSED');
    await code(call('POST', U(`cash/closings/${cl.id}/decide`), prep.hm, { approve: true }), 403, 'FINANCE_SELF_APPROVAL');
    expect((await tb()).find((r) => r.code === '5210')).toBeUndefined();                      // nothing is adjusted silently
    await ok(call('POST', U(`cash/closings/${cl.id}/decide`), OM, { approve: true }));
    expect((await tb()).find((r) => r.code === '5210')).toMatchObject({ closingDr: '200.00' }); expect((await ok(call('GET', U(`cash/drawers?propertyId=${p1}`), O))).items[0].balance).toBe('4800.00');
    await code(call('POST', U(`cash/closings/${cl.id}/decide`), OM, { approve: true }), 409, 'NOT_PENDING');
    // contra: cash to bank
    const ctv = await ok(call('POST', U('vouchers/quick'), prep.h, { type: 'CTV', date: '2026-11-10', narration: 'Banked the cash', amount: '1000', from: { kind: 'CASH', branchId: p1 }, to: { kind: 'BANK', bankId: co.id, branchId: p1 } }), 201);
    await ok(call('POST', U(`vouchers/${ctv.id}/submit`), prep.h)); await ok(call('POST', U(`vouchers/${ctv.id}/approve`), OM));
    const rows = await tb(); expect(rows.find((r) => r.code === '1010')).toMatchObject({ closingDr: '3800.00' }); expect(rows.find((r) => r.code === '1101')).toMatchObject({ closingDr: '3500.00' });
    await code(call('POST', U('vouchers/quick'), prep.h, { type: 'CTV', date: '2026-11-10', narration: 'Cross branch', amount: '10', from: { kind: 'CASH', branchId: p1 }, to: { kind: 'CASH', branchId: p2 } }), 409, 'USE_INTERBRANCH');
    await code(call('POST', U('vouchers/quick'), prep.h, { type: 'CRV', date: '2026-11-10', narration: 'Wrong kind', amount: '10', money: { kind: 'BANK', bankId: co.id }, other: '4010' }), 400, 'VALIDATION_FAILED');
    expect((await tb()).reduce((s, r) => s + Number(r.debit), 0)).toBeCloseTo((await tb()).reduce((s, r) => s + Number(r.credit), 0), 2);
  });
});
