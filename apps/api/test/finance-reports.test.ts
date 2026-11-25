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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'finrep'); O = as(T.tenantId, T.ownerUserId); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

const U = (t: string) => `/v1/finance/${t}`;
const cell = (t: any, label: string, col = -1) => { const r = t.rows.find((x: any) => x.cells[0] === label || x.cells[0].endsWith(label)); return r ? r.cells[col < 0 ? r.cells.length + col : col] : undefined; };
describe('finance reports', () => {
  it('profit and loss, balance sheet and cash flow agree with each other and with the ledger; dashboard and registers read the same books', async () => {
    at('2026-11-10', '10:00');
    const OM = as(T.tenantId, T.ownerUserId, { mfa: true });
    const mkProp = async () => (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `FR${++n}`, name: `Branch ${n}` })).json().id as string;
    const p1 = await mkProp(), p2 = await mkProp();
    const id = await addUser(T.tenantId, `acc${++n}@finrep.test`); await assignRole(T.tenantId, id, 'accountant', 'TENANT', null); const prep = { h: as(T.tenantId, id) }; const hk = as(T.tenantId, await (async () => { const u = await addUser(T.tenantId, `hk${++n}@finrep.test`); await assignRole(T.tenantId, u, 'housekeeper', 'TENANT', null); return u; })());
    await ok(call('POST', U('accounts/starter'), OM)); await ok(call('PUT', U('settings'), OM, { selfApproveLimit: '1000000' }));
    const post = async (path: string, body: object) => { const v = await ok(call('POST', U(path), prep.h, body), 201); await ok(call('POST', U(`vouchers/${v.id}/submit`), prep.h)); await ok(call('POST', U(`vouchers/${v.id}/approve`), OM)); return v.id as string; };
    const jv = (d: string, lines: object[]) => post('vouchers', { type: 'JV', date: d, narration: 'Entry', lines });
    await code(call('GET', U('reports/profit-loss?from=2026-11-01&to=2026-11-30'), hk), 403, 'PERMISSION_DENIED');
    // owner puts 500,000 into the bank and the cash drawer of branch 1; branch 1 earns 80,000 cash and 40,000 on account; both branches spend; branch 1 buys a fixture; branch 1 sends 10,000 to branch 2
    await jv('2026-11-01', [{ account: '1010', branchId: p1, debit: '100000' }, { account: '1010', branchId: p2, debit: '50000' }, { account: '3010', credit: '150000' }]);
    await post('vouchers/quick', { type: 'CRV', date: '2026-11-05', narration: 'Room sales', amount: '80000', money: { kind: 'CASH', branchId: p1 }, other: '4010' });
    await jv('2026-11-06', [{ account: '1200', branchId: p1, debit: '40000' }, { account: '4010', branchId: p1, credit: '40000' }]);
    await post('vouchers/quick', { type: 'CPV', date: '2026-11-07', narration: 'Electricity', amount: '12000', money: { kind: 'CASH', branchId: p1 }, other: '5020' });
    await post('vouchers/quick', { type: 'CPV', date: '2026-11-08', narration: 'Cleaning', amount: '5000', money: { kind: 'CASH', branchId: p2 }, other: '5070' });
    await post('vouchers/quick', { type: 'CPV', date: '2026-11-09', narration: 'Furniture', amount: '20000', money: { kind: 'CASH', branchId: p1 }, other: '1500' });
    await post('interbranch/transfer', { date: '2026-11-10', narration: 'Float', amount: '10000', fromBranchId: p1, from: { kind: 'CASH' }, toBranchId: p2, to: { kind: 'CASH' } });
    // profit and loss: revenue 120,000; expenses 17,000; by branch and in total
    const pl = await ok(call('GET', U('reports/profit-loss?from=2026-11-01&to=2026-11-30'), prep.h));
    expect(cell(pl, 'Total revenue')).toBe('120000.00'); expect(cell(pl, 'Total expenses')).toBe('17000.00'); expect(cell(pl, 'Net result')).toBe('103000.00');
    expect(pl.columns).toHaveLength(4);                                                  // account, two branches, total
    const pl1 = await ok(call('GET', U(`reports/profit-loss?from=2026-11-01&to=2026-11-30&branchId=${p1}`), prep.h));
    // balance sheet balances; inter-branch is eliminated in the company total
    const bs = await ok(call('GET', U('reports/balance-sheet?to=2026-11-30'), prep.h)); expect(bs.ok).toBe(true); expect(cell(bs, 'Total assets')).toBe(cell(bs, 'Total liabilities and equity')); expect(cell(bs, '1700 Due From Other Branches')).toBe('eliminated');
    expect(cell(bs, 'Result of the year so far')).toBe('103000.00');
    // cash flow: opening 0, closing = cash on hand; every movement is placed
    const cf = await ok(call('GET', U('reports/cash-flow?from=2026-11-01&to=2026-11-30'), prep.h));
    expect(cell(cf, 'Cash and bank at the start')).toBe('0.00'); expect(cell(cf, 'Net cash from operating')).toBe('63000.00'); expect(cell(cf, 'Net cash from investing')).toBe('-20000.00'); expect(cell(cf, 'Net cash from financing')).toBe('150000.00'); expect(cell(cf, 'Cash and bank at the end')).toBe('193000.00');
    const cf1 = await ok(call('GET', U(`reports/cash-flow?from=2026-11-01&to=2026-11-30&branchId=${p1}`), prep.h)); expect(cf1.ok).toBe(true);
    // registers
    const exr = await ok(call('GET', U('reports/expenses?from=2026-11-01&to=2026-11-30'), prep.h)); expect(exr.rows.find((x: any) => x.cells[4] === 'All expenses').cells[6]).toBe('17000.00');
    const vr = await ok(call('GET', U('reports/voucher-register?from=2026-11-01&to=2026-11-30&type=CPV'), prep.h)); expect(vr.rows).toHaveLength(3); expect(vr.rows[0].cells[6]).toBe('posted');
    // daily cash
    await ok(call('POST', U('cash/drawers'), OM, { propertyId: p1, kind: 'CASH', name: 'Cash' }), 201);
    const dc = await ok(call('GET', U(`reports/daily-cash?date=2026-11-10&branchId=${p1}`), prep.h)); expect(dc.rows[0].cells.slice(1, 5)).toEqual(['148000.00', '0.00', '10000.00', '138000.00']);
    // budget against actual
    await code(call('PUT', U('reports/budget'), prep.h, { branchId: p1, account: '5020', month: '2026-11', amount: '10000' }), 403, 'MFA_REQUIRED');
    await ok(call('PUT', U('reports/budget'), OM, { branchId: p1, account: '5020', month: '2026-11', amount: '10000' })); await ok(call('PUT', U('reports/budget'), OM, { branchId: p1, account: '5020', month: '2026-11', amount: '9000' }));
    const bva = await ok(call('GET', U(`reports/budget-vs-actual?from=2026-11&to=2026-11&branchId=${p1}`), prep.h)); const row = bva.rows.find((x: any) => x.cells[0].startsWith('5020')); expect(row.cells.slice(2, 5)).toEqual(['9000.00', '12000.00', '3000.00']); expect(row.cells[5]).toBe('33.3%');
    // dashboard
    const dash = await ok(call('GET', U('reports/dashboard?period=month&date=2026-11-30'), prep.h));
    expect(dash.total).toMatchObject({ revenue: '120000.00', expenses: '17000.00', profit: '103000.00', cash: '193000.00', receivables: '40000.00' }); expect(dash.branches).toHaveLength(2); expect(dash.trend.at(-1)).toMatchObject({ month: '2026-11', revenue: '120000.00' });
    expect(dash.alerts).toMatchObject({ vouchersWaiting: 0, interBranchDifferences: 0 });
    expect((await ok(call('GET', U('reports/dashboard?period=day&date=2026-11-05'), prep.h))).total.revenue).toBe('80000.00');
  });
});
