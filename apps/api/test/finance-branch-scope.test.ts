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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'bscope'); O = as(T.tenantId, T.ownerUserId); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

const U = (t: string) => `/v1/finance/${t}`;
describe('finance permissions limited to a branch', () => {
  it('a branch role sees and acts on its own branch only; company-wide things stay company-wide', async () => {
    at('2026-11-10', '10:00');
    const OM = as(T.tenantId, T.ownerUserId, { mfa: true });
    const mkProp = async () => (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `BS${++n}`, name: `Branch ${n}` })).json().id as string;
    const p1 = await mkProp(), p2 = await mkProp();
    const mk = async (role: string, scope: 'TENANT' | 'PROPERTY' = 'TENANT', pid: string | null = null) => { const id = await addUser(T.tenantId, `${role}${++n}@bscope.test`); await assignRole(T.tenantId, id, role, scope, pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };
    const co = await mk('accountant'), ba = await mk('branch_accountant', 'PROPERTY', p1), bm = await mk('branch_finance_manager', 'PROPERTY', p1);
    await ok(call('POST', U('accounts/starter'), OM));
    const post = async (d: string, lines: object[], by = co) => { const v = await ok(call('POST', U('vouchers'), by.h, { type: 'JV', date: d, narration: 'Entry', lines }), 201); await ok(call('POST', U(`vouchers/${v.id}/submit`), by.h)); await ok(call('POST', U(`vouchers/${v.id}/approve`), OM)); return v.id as string; };
    const v1 = await post('2026-11-02', [{ account: '1010', branchId: p1, debit: '1000' }, { account: '4010', branchId: p1, credit: '1000' }]);
    const v2 = await post('2026-11-03', [{ account: '1010', branchId: p2, debit: '5000' }, { account: '4010', branchId: p2, credit: '5000' }]);
    const vho = await post('2026-11-04', [{ account: '1010', debit: '70' }, { account: '3010', credit: '70' }]);
    // reading: only your own branch's books
    const list = (await ok(call('GET', U('vouchers'), ba.h))).items as any[]; expect(list.map((x) => x.id)).toEqual([v1]);
    expect((await ok(call('GET', U('vouchers'), co.h))).items).toHaveLength(3);
    await ok(call('GET', U(`vouchers/${v1}`), ba.h)); await code(call('GET', U(`vouchers/${v2}`), ba.h), 404, 'NOT_FOUND'); await code(call('GET', U(`vouchers/${vho}`), ba.h), 404, 'NOT_FOUND');
    const tb = await ok(call('GET', U('reports/trial-balance?from=2026-11-01&to=2026-11-30'), ba.h)); expect(tb.totals.debit).toBe('1000.00'); expect(tb.balanced).toBe(true);
    await code(call('GET', U(`reports/trial-balance?from=2026-11-01&to=2026-11-30&branchId=${p2}`), ba.h), 403, 'BRANCH_NOT_ALLOWED');
    expect((await ok(call('GET', U('reports/trial-balance?from=2026-11-01&to=2026-11-30'), co.h))).totals.debit).toBe('6070.00');
    const pl = await ok(call('GET', U('reports/profit-loss?from=2026-11-01&to=2026-11-30'), ba.h)); expect(pl.columns).toHaveLength(3); expect(pl.rows.find((r: any) => r.cells[0] === 'Total revenue').cells[2]).toBe('1000.00');
    await code(call('GET', U(`reports/profit-loss?from=2026-11-01&to=2026-11-30&branchId=${p2}`), ba.h), 403, 'BRANCH_NOT_ALLOWED');
    const dash = await ok(call('GET', U('reports/dashboard?period=month&date=2026-11-30'), ba.h)); expect(dash.total.revenue).toBe('1000.00'); expect(dash.branches).toHaveLength(1);
    expect((await ok(call('GET', U('reports/dashboard?period=month&date=2026-11-30'), co.h))).total.revenue).toBe('6000.00');
    expect((await ok(call('GET', U('reports/voucher-register?from=2026-11-01&to=2026-11-30'), ba.h))).rows).toHaveLength(1);
    // writing: own branch only, never head office or inter-branch
    const mine = { type: 'JV', date: '2026-11-05', narration: 'Own branch', lines: [{ account: '5100', branchId: p1, debit: '10' }, { account: '1010', branchId: p1, credit: '10' }] };
    const vm = await ok(call('POST', U('vouchers'), ba.h, mine), 201);
    await code(call('POST', U('vouchers'), ba.h, { ...mine, lines: [{ account: '5100', branchId: p2, debit: '10' }, { account: '1010', branchId: p2, credit: '10' }] }), 403, 'BRANCH_NOT_ALLOWED');
    await code(call('POST', U('vouchers'), ba.h, { ...mine, lines: [{ account: '5100', debit: '10' }, { account: '1010', credit: '10' }] }), 403, 'BRANCH_NOT_ALLOWED');
    await code(call('POST', U('interbranch/transfer'), ba.h, { date: '2026-11-05', narration: 'Float', amount: '5', fromBranchId: p1, from: { kind: 'CASH' }, toBranchId: p2, to: { kind: 'CASH' } }), 403, 'COMPANY_WIDE_ONLY');
    await ok(call('POST', U(`vouchers/${vm.id}/submit`), ba.h));
    await code(call('POST', U(`vouchers/${vm.id}/approve`), ba.hm), 403, 'PERMISSION_DENIED');                 // a preparer cannot approve
    await code(call('POST', U(`vouchers/${v2}/reverse`), ba.h, { date: '2026-11-06', reason: 'Not mine to reverse' }), 403, 'BRANCH_NOT_ALLOWED');
    await ok(call('POST', U(`vouchers/${vm.id}/approve`), bm.hm));                                           // the branch finance manager approves a branch voucher
    const other = await ok(call('POST', U('vouchers'), co.h, { type: 'JV', date: '2026-11-05', narration: 'Branch 2', lines: [{ account: '5100', branchId: p2, debit: '10' }, { account: '1010', branchId: p2, credit: '10' }] }), 201); await ok(call('POST', U(`vouchers/${other.id}/submit`), co.h));
    await code(call('POST', U(`vouchers/${other.id}/approve`), bm.hm), 403, 'BRANCH_NOT_ALLOWED');             // but not another branch's
    // company-wide things are company-wide
    await code(call('POST', U('suppliers'), ba.h, { name: 'Pipes' }), 403, 'PERMISSION_DENIED'); await code(call('GET', U('pms'), ba.h), 403, 'PERMISSION_DENIED'); await code(call('GET', U('year-end'), ba.h), 403, 'PERMISSION_DENIED'); await code(call('GET', U('bank/suspense'), ba.h), 403, 'PERMISSION_DENIED');
    await code(call('POST', U('accounts'), ba.hm, { code: '5999', name: 'No', type: 'expense' }), 403, 'PERMISSION_DENIED');
    // cash: only your own branch's drawer
    await ok(call('POST', U('cash/drawers'), OM, { propertyId: p1, kind: 'CASH', name: 'Cash 1' }), 201); await ok(call('POST', U('cash/drawers'), OM, { propertyId: p2, kind: 'CASH', name: 'Cash 2' }), 201);
    const drawers = (await ok(call('GET', U('cash/drawers'), ba.h))).items as any[]; expect(drawers).toHaveLength(1); expect(drawers[0].propertyId).toBe(p1);
    const d2 = (await ok(call('GET', U('cash/drawers'), co.h))).items.find((d: any) => d.propertyId === p2);
    await code(call('POST', U(`cash/drawers/${d2.id}/close`), ba.h, { date: '2026-11-10', counted: '5000' }), 403, 'BRANCH_NOT_ALLOWED');
    // banks: a bank for another branch is not shown
    const bank = await ok(call('POST', '/v1/payment-accounts', OM, { kind: 'BANK', name: 'Branch 2 bank' }), 201); await ok(call('PUT', U(`banks/${bank.id}`), OM, { accountType: 'CURRENT', purpose: 'BOTH', branchIds: [p2] }));
    expect((await ok(call('GET', U('banks'), ba.h))).items).toHaveLength(0); expect((await ok(call('GET', U('banks'), co.h))).items).toHaveLength(1);
  });
});
