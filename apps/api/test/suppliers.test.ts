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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'supp'); O = as(T.tenantId, T.ownerUserId); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

const U = (t: string) => `/v1/finance/${t}`;
describe('suppliers and payables', () => {
  it('a bill and its payments are approved by a second person; the payables account is always by supplier; ageing and the supplier ledger agree', async () => {
    at('2026-11-10', '10:00');
    const OM = as(T.tenantId, T.ownerUserId, { mfa: true });
    const mkProp = async () => (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `SP${++n}`, name: `Branch ${n}` })).json().id as string;
    const p1 = await mkProp(), p2 = await mkProp();
    const mk = async (role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@supp.test`); await assignRole(T.tenantId, id, role, 'TENANT', null); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };
    const prep = await mk('accountant'), fd = await mk('front_desk_agent');
    await ok(call('POST', U('accounts/starter'), OM)); await ok(call('PUT', U('settings'), OM, { selfApproveLimit: '0' }));
    const approve = async (vid: string) => { await ok(call('POST', U(`vouchers/${vid}/submit`), prep.h)); await ok(call('POST', U(`vouchers/${vid}/approve`), OM)); };
    await code(call('POST', U('suppliers'), fd.h, { name: 'Pipes Ltd' }), 403, 'PERMISSION_DENIED');
    const s1 = (await ok(call('POST', U('suppliers'), prep.h, { name: 'Pipes Ltd', ntn: '1234567-8', paymentTermsDays: 30 }), 201)).id as string;
    await code(call('POST', U('suppliers'), prep.h, { name: 'pipes ltd' }), 409, 'SUPPLIER_EXISTS');
    // the payables account on its own, or a supplier on another account, is refused
    await code(call('POST', U('vouchers'), prep.h, { type: 'JV', date: '2026-10-10', narration: 'No supplier', lines: [{ account: '5100', debit: '10' }, { account: '2010', credit: '10' }] }), 400, 'SUPPLIER_REQUIRED');
    await code(call('POST', U('vouchers'), prep.h, { type: 'JV', date: '2026-10-10', narration: 'Wrong line', lines: [{ account: '5100', supplierId: s1, debit: '10' }, { account: '2010', supplierId: s1, credit: '10' }] }), 400, 'SUPPLIER_REQUIRED');
    // a bill: 15,000 for branch 1 (repairs 10,000, electricity 5,000), due 20 Oct
    const bill = { supplierId: s1, branchId: p1, billNo: 'INV-77', billDate: '2026-10-10', dueDate: '2026-10-20', narration: 'Plumbing and wiring', lines: [{ account: '5100', amount: '10000' }, { account: '5020', amount: '5000' }] };
    await code(call('POST', U('supplier-bills'), prep.h, { ...bill, lines: [{ account: '4010', amount: '10' }] }), 400, 'ACCOUNT_KIND');
    const b = await ok(call('POST', U('supplier-bills'), prep.h, bill), 201); await code(call('POST', U('supplier-bills'), prep.h, bill), 409, 'DUPLICATE_BILL');
    let bills = (await ok(call('GET', U(`supplier-bills?supplierId=${s1}`), prep.h))).items; expect(bills[0]).toMatchObject({ status: 'DRAFT', total: '15000.00', outstanding: '15000.00' });
    await ok(call('POST', U(`vouchers/${b.voucherId}/submit`), prep.h)); await code(call('POST', U(`vouchers/${b.voucherId}/approve`), prep.hm), 403, 'FINANCE_SELF_APPROVAL');
    await code(call('POST', U('supplier-payments'), prep.h, { supplierId: s1, branchId: p1, date: '2026-11-10', money: { kind: 'CASH' }, allocations: [{ billId: b.id, amount: '1000' }] }), 409, 'BILL_NOT_PAYABLE');       // not approved yet
    await ok(call('POST', U(`vouchers/${b.voucherId}/approve`), OM));
    bills = (await ok(call('GET', U(`supplier-bills?supplierId=${s1}`), prep.h))).items; expect(bills[0]).toMatchObject({ status: 'OPEN', available: '15000.00' });
    // the books: each expense in its branch, the supplier owed 15,000
    const tb = async (extra = '') => (await ok(call('GET', U(`reports/trial-balance?from=2026-10-01&to=2026-11-30${extra}`), O))).rows as any[];
    expect((await tb()).find((r) => r.code === '2010')).toMatchObject({ closingCr: '15000.00' }); expect((await tb(`&branchId=${p1}`)).find((r) => r.code === '5100')).toMatchObject({ closingDr: '10000.00' });
    // ageing: 21 days overdue is in the 1-30 days column
    const ag = await ok(call('GET', U('reports/payables-ageing?asAt=2026-11-10'), prep.h)); expect(ag.rows[0]).toMatchObject({ supplier: 'Pipes Ltd', current: '0.00', d30: '15000.00', total: '15000.00' }); expect((await ok(call('GET', U('reports/payables-ageing?asAt=2026-12-31'), prep.h))).rows[0]).toMatchObject({ d90: '15000.00' });
    // paying: only what is owed, from the same branch, and a second person approves
    const pay = (amt: string, branch = p1, kind = 'CASH') => call('POST', U('supplier-payments'), prep.h, { supplierId: s1, branchId: branch, date: '2026-11-10', reference: 'CHQ-5', money: { kind }, allocations: [{ billId: b.id, amount: amt }] });
    await code(pay('20000'), 409, 'OVERPAYMENT'); await code(pay('1000', p2), 409, 'USE_INTERBRANCH');
    const cash = await ok(call('POST', U('vouchers/quick'), prep.h, { type: 'CRV', date: '2026-11-01', narration: 'Cash float', amount: '50000', money: { kind: 'CASH', branchId: p1 }, other: '3010' }), 201); await approve(cash.id);
    const p = await ok(pay('6000'), 201); await code(pay('10000'), 409, 'OVERPAYMENT');              // 6,000 is already promised in an unapproved payment: 9,000 is left to promise
    await ok(pay('9000'), 201).then(async (q: any) => { await ok(call('POST', U(`vouchers/${q.voucherId}/cancel`), prep.h)); });              // cancelling frees it again
    await approve(p.voucherId);
    bills = (await ok(call('GET', U(`supplier-bills?supplierId=${s1}`), prep.h))).items; expect(bills[0]).toMatchObject({ status: 'PART_PAID', paid: '6000.00', outstanding: '9000.00' });
    expect((await tb()).find((r) => r.code === '2010')).toMatchObject({ closingCr: '9000.00' });
    const led = await ok(call('GET', U(`reports/supplier-ledger?supplierId=${s1}&from=2026-10-01&to=2026-11-30`), prep.h)); expect(led.rows.map((r: any) => [r.billed, r.paid, r.balance])).toEqual([['15000.00', '0.00', '15000.00'], ['0.00', '6000.00', '9000.00']]); expect(led.closing).toBe('9000.00');
    expect((await ok(call('GET', U('suppliers'), prep.h))).items[0].owed).toBe('9000.00');
    // a bill with payments cannot be reversed until the payments are; reversing the payment gives the amount back
    await code(call('POST', U(`vouchers/${b.voucherId}/reverse`), prep.h, { date: '2026-11-11', reason: 'Wrong supplier' }), 409, 'SUPPLIER_BILL_HAS_PAYMENTS');
    const rv = await ok(call('POST', U(`vouchers/${p.voucherId}/reverse`), prep.h, { date: '2026-11-11', reason: 'Cheque bounced' }), 201); await approve(rv.id);
    expect((await ok(call('GET', U(`supplier-bills?supplierId=${s1}`), prep.h))).items[0]).toMatchObject({ status: 'OPEN', paid: '0.00', outstanding: '15000.00' });
    const rb = await ok(call('POST', U(`vouchers/${b.voucherId}/reverse`), prep.h, { date: '2026-11-12', reason: 'Wrong supplier' }), 201); await approve(rb.id);
    expect((await ok(call('GET', U(`supplier-bills?supplierId=${s1}`), prep.h))).items[0].status).toBe('REVERSED'); expect((await tb()).find((r) => r.code === '2010')).toMatchObject({ closingCr: '0.00', closingDr: '0.00' });
    // bank details are hidden unless you may see them
    await code(call('PUT', U(`suppliers/${s1}/bank`), prep.h, { iban: 'PK36SCBL0000001123456702' }), 403, 'MFA_REQUIRED');
    await ok(call('PUT', U(`suppliers/${s1}/bank`), prep.hm, { bankName: 'Test Bank', iban: 'PK36SCBL0000001123456702', accountNumber: '0123456789' }));
    expect((await ok(call('GET', U('suppliers'), prep.h))).items[0]).toMatchObject({ iban: '•••• 6702', accountNumber: '•••• 6789' }); expect(JSON.stringify(await ok(call('GET', U('suppliers'), prep.h)))).not.toContain('PK36SCBL');
    expect(await ok(call('GET', U(`suppliers/${s1}/reveal`), prep.hm))).toMatchObject({ iban: 'PK36SCBL0000001123456702' }); await code(call('GET', U(`suppliers/${s1}/reveal`), fd.hm), 403, 'PERMISSION_DENIED');
  });
});
