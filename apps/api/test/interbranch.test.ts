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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'ibranch'); O = as(T.tenantId, T.ownerUserId); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

const U = (t: string) => `/v1/finance/${t}`;
describe('inter-branch accounting', () => {
  it('transfers and expenses paid for another branch keep every branch balanced and agree between the pair; settling clears the balance', async () => {
    at('2026-11-10', '10:00');
    const OM = as(T.tenantId, T.ownerUserId, { mfa: true });
    const mkProp = async () => (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `IB${++n}`, name: `Branch ${n}` })).json().id as string;
    const p1 = await mkProp(), p2 = await mkProp(), p3 = await mkProp();
    const id = await addUser(T.tenantId, `acc${++n}@ibranch.test`); await assignRole(T.tenantId, id, 'accountant', 'TENANT', null); const prep = { h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) };
    await ok(call('POST', U('accounts/starter'), OM)); await ok(call('PUT', U('settings'), OM, { selfApproveLimit: '1000000' }));
    const post = async (path: string, body: object) => { const v = await ok(call('POST', U(path), prep.h, body), 201); await ok(call('POST', U(`vouchers/${v.id}/submit`), prep.h)); await ok(call('POST', U(`vouchers/${v.id}/approve`), OM)); return v.id as string; };
    const tb = async (extra = '') => (await ok(call('GET', U(`reports/trial-balance?from=2026-11-01&to=2026-11-30${extra}`), O)));
    const row = (t: any, code: string) => t.rows.find((r: any) => r.code === code);
    const mx = async () => (await ok(call('GET', U('interbranch/matrix?to=2026-11-30'), O)));
    // branch 1 sends 50,000 cash to branch 2
    await code(call('POST', U('interbranch/transfer'), prep.h, { date: '2026-11-10', narration: 'Float', amount: '50000', fromBranchId: p1, from: { kind: 'CASH' }, toBranchId: p1, to: { kind: 'CASH' } }), 400, 'SAME_BRANCH');
    const t1 = await ok(call('POST', U('interbranch/transfer'), prep.h, { date: '2026-11-10', narration: 'Float to the Creek branch', amount: '50000', fromBranchId: p1, from: { kind: 'CASH' }, toBranchId: p2, to: { kind: 'CASH' } }), 201);
    await ok(call('POST', U(`vouchers/${t1.id}/submit`), prep.h)); await code(call('POST', U(`vouchers/${t1.id}/approve`), prep.hm), 403, 'FINANCE_SELF_APPROVAL');   // inter-branch always needs a second person
    await ok(call('POST', U(`vouchers/${t1.id}/approve`), OM));
    for (const [p, dr, cr] of [[p1, '50000.00', '50000.00'], [p2, '50000.00', '50000.00']] as const) { const t = await tb(`&branchId=${p}`); expect(t.balanced, `branch ${p}`).toBe(true); expect(t.totals.debit).toBe(dr); void cr; }
    expect(row(await tb(`&branchId=${p1}`), '1700')).toMatchObject({ closingDr: '50000.00' }); expect(row(await tb(`&branchId=${p1}`), '1010')).toMatchObject({ closingCr: '50000.00' });
    expect(row(await tb(`&branchId=${p2}`), '2200')).toMatchObject({ closingCr: '50000.00' }); expect(row(await tb(`&branchId=${p2}`), '1010')).toMatchObject({ closingDr: '50000.00' });
    let m = await mx(); expect(m.rows).toHaveLength(1); expect(m.rows[0]).toMatchObject({ status: 'AGREE', difference: '0.00' }); expect(m.agree).toBe(true);
    // branch 2 settles 20,000 back; branch 2 pays a 15,000 repair for branch 1
    await post('interbranch/transfer', { date: '2026-11-12', narration: 'Part repayment', amount: '20000', fromBranchId: p2, from: { kind: 'CASH' }, toBranchId: p1, to: { kind: 'CASH' } });
    await code(call('POST', U('interbranch/expense'), prep.h, { date: '2026-11-13', narration: 'Repair', amount: '15000', paidByBranchId: p2, paidWith: { kind: 'CASH' }, expenseBranchId: p2, expenseAccount: '5100', vendor: 'Plumber' }), 400, 'SAME_BRANCH');
    await post('interbranch/expense', { date: '2026-11-13', narration: 'Geyser repair at the Ramna branch', amount: '15000', paidByBranchId: p2, paidWith: { kind: 'CASH' }, expenseBranchId: p1, expenseAccount: '5100', vendor: 'Plumber', invoiceNo: 'INV-77' });
    expect(row(await tb(`&branchId=${p1}`), '5100')).toMatchObject({ closingDr: '15000.00' }); expect(row(await tb(`&branchId=${p2}`), '5100')).toBeUndefined();   // the expense belongs to the branch it was for
    for (const p of [p1, p2]) expect((await tb(`&branchId=${p}`)).balanced).toBe(true);
    m = await mx(); const pair = m.rows[0]; expect(pair.status).toBe('AGREE'); const a1 = pair.aId === p1 ? pair.aBooks : pair.bBooks; expect(a1).toBe('15000.00');   // branch 1 is owed 50,000 − 20,000 − 15,000
    const items = await ok(call('GET', U(`interbranch/items?branchId=${p1}&counterpartyId=${p2}`), O)); expect(items.balance).toBe('15000.00'); expect(items.items).toHaveLength(3);
    // consolidated: the two sides cancel out
    const all = await tb(); expect(Number(row(all, '1700').closingDr) - Number(row(all, '2200').closingCr)).toBe(0);
    // an ordinary journal that leaves one side out is caught by the pair check
    await code(call('POST', U('vouchers'), prep.h, { type: 'JV', date: '2026-11-14', narration: 'No other branch', lines: [{ account: '1700', branchId: p1, debit: '10' }, { account: '1010', branchId: p1, credit: '10' }] }), 400, 'INTERBRANCH_BRANCHES');
    const jv = await ok(call('POST', U('vouchers'), prep.h, { type: 'JV', date: '2026-11-14', narration: 'One-sided entry by mistake', lines: [{ account: '1700', branchId: p1, counterpartyBranchId: p3, debit: '1000' }, { account: '1010', branchId: p1, credit: '1000' }] }), 201);
    await ok(call('POST', U(`vouchers/${jv.id}/submit`), prep.h)); await ok(call('POST', U(`vouchers/${jv.id}/approve`), OM));
    m = await mx(); expect(m.agree).toBe(false); expect(m.rows.find((r: any) => r.status === 'DIFFERENCE')).toMatchObject({ difference: '1000.00' });
    await code(call('POST', U('interbranch/transfer'), prep.h, { date: '2026-11-10', narration: 'Wrong', amount: '5', fromBranchId: p1, from: { kind: 'BANK' }, toBranchId: p2, to: { kind: 'CASH' } }), 400, 'VALIDATION_FAILED');
  });
});
