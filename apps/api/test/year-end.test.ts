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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'yrend'); O = as(T.tenantId, T.ownerUserId); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

const U = (t: string) => `/v1/finance/${t}`;
describe('year-end close', () => {
  it('needs every month closed, moves the result to retained earnings branch by branch, locks the year, and can be reopened by reversing it', async () => {
    at('2026-11-10', '10:00');
    const OM = as(T.tenantId, T.ownerUserId, { mfa: true });
    const mkProp = async () => (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `YE${++n}`, name: `Branch ${n}` })).json().id as string;
    const p1 = await mkProp(), p2 = await mkProp();
    const id = await addUser(T.tenantId, `acc${++n}@yrend.test`); await assignRole(T.tenantId, id, 'accountant', 'TENANT', null); const prep = { h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) };
    await ok(call('POST', U('accounts/starter'), OM));
    const jv = async (d: string, lines: object[]) => { const v = await ok(call('POST', U('vouchers'), prep.h, { type: 'JV', date: d, narration: 'Entry', lines }), 201); await ok(call('POST', U(`vouchers/${v.id}/submit`), prep.h)); await ok(call('POST', U(`vouchers/${v.id}/approve`), OM)); };
    await jv('2025-03-10', [{ account: '1010', branchId: p1, debit: '100000' }, { account: '4010', branchId: p1, credit: '100000' }]);
    await jv('2025-04-10', [{ account: '5100', branchId: p1, debit: '30000' }, { account: '1010', branchId: p1, credit: '30000' }]);
    await jv('2025-05-10', [{ account: '1010', branchId: p2, debit: '20000' }, { account: '4010', branchId: p2, credit: '20000' }]);
    const tb = async (from: string, to: string) => (await ok(call('GET', U(`reports/trial-balance?from=${from}&to=${to}`), O))).rows as any[];
    const cell = (t: any, label: string, col = -1) => { const r = t.rows.find((x: any) => x.cells[0] === label || x.cells[0].endsWith(label)); return r?.cells[col < 0 ? r.cells.length + col : col]; };
    // not yet: not a year end, not finished, months open
    await code(call('GET', U('year-end/preview?end=2025-11-30'), prep.h), 400, 'NOT_YEAR_END');
    expect((await ok(call('GET', U('year-end/preview?end=2026-12-31'), prep.h))).blockers.map((b: any) => b.code)).toContain('FY_NOT_ENDED');
    const pv0 = await ok(call('GET', U('year-end/preview?end=2025-12-31'), prep.h)); expect(pv0.canClose).toBe(false); expect(pv0.blockers[0].code).toBe('MONTHS_OPEN');
    await code(call('POST', U('year-end/close'), prep.hm, { end: '2025-12-31' }), 409, 'MONTHS_OPEN');
    for (let m = 1; m <= 12; m++) await ok(call('POST', U(`periods/2025-${String(m).padStart(2, '0')}/close`), OM));
    const pv = await ok(call('GET', U('year-end/preview?end=2025-12-31'), prep.h)); expect(pv).toMatchObject({ canClose: true, result: '90000.00' }); expect(pv.byBranch.map((b: any) => b.result).sort()).toEqual(['20000.00', '70000.00']);
    await code(call('POST', U('year-end/close'), prep.h, { end: '2025-12-31' }), 403, 'MFA_REQUIRED');
    const c = await ok(call('POST', U('year-end/close'), prep.hm, { end: '2025-12-31' }), 201);
    expect((await ok(call('GET', U('year-end'), prep.h))).items.find((y: any) => y.end === '2025-12-31')).toMatchObject({ status: 'PENDING', monthsClosed: 12 });
    await code(call('POST', U('year-end/close'), prep.hm, { end: '2025-12-31' }), 409, 'ALREADY_CLOSED');
    await ok(call('POST', U(`vouchers/${c.voucherId}/submit`), prep.h)); await code(call('POST', U(`vouchers/${c.voucherId}/approve`), prep.hm), 403, 'FINANCE_SELF_APPROVAL');
    await ok(call('POST', U(`vouchers/${c.voucherId}/approve`), OM));
    expect((await ok(call('GET', U('year-end'), prep.h))).items.find((y: any) => y.end === '2025-12-31').status).toBe('CLOSED');
    // the books: revenue and expense accounts are empty at year end, retained earnings holds the result, each branch balances
    const t = await tb('2025-01-01', '2025-12-31'); expect(t.find((r) => r.code === '4010')).toMatchObject({ closingDr: '0.00', closingCr: '0.00' }); expect(t.find((r) => r.code === '3040')).toMatchObject({ closingCr: '90000.00' });
    for (const p of [p1, p2]) expect((await ok(call('GET', U(`reports/trial-balance?from=2025-01-01&to=2025-12-31&branchId=${p}`), O))).balanced).toBe(true);
    // reports still show the year's trading, without the closing entries
    const pl = await ok(call('GET', U('reports/profit-loss?from=2025-01-01&to=2025-12-31'), prep.h)); expect(cell(pl, 'Total revenue')).toBe('120000.00'); expect(cell(pl, 'Net result')).toBe('90000.00');
    const bs = await ok(call('GET', U('reports/balance-sheet?to=2025-12-31'), prep.h)); expect(bs.ok).toBe(true); expect(cell(bs, 'Result of the year so far')).toBe('0.00'); expect(cell(bs, '3040 Retained Earnings')).toBe('90000.00');
    // the year is locked
    await code(call('POST', U('vouchers'), prep.h, { type: 'JV', date: '2025-06-01', narration: 'Late entry', lines: [{ account: '5100', debit: '5' }, { account: '1010', credit: '5' }] }), 409, 'YEAR_CLOSED');
    await code(call('POST', U('periods/2025-06/reopen'), OM, { reason: 'A late bill turned up' }), 409, 'YEAR_CLOSED');
    await code(call('PUT', U('settings'), OM, { fiscalYearStartMonth: 7 }), 409, 'YEAR_CLOSED');
    await jv('2026-02-01', [{ account: '5100', branchId: p1, debit: '1000' }, { account: '1010', branchId: p1, credit: '1000' }]);          // the next year is open
    // reopening: reverse the closing voucher
    const rv = await ok(call('POST', U(`vouchers/${c.voucherId}/reverse`), prep.h, { date: '2025-12-31', reason: 'A late supplier bill must go into 2025' }), 201);
    await ok(call('POST', U(`vouchers/${rv.id}/submit`), prep.h)); await ok(call('POST', U(`vouchers/${rv.id}/approve`), OM));
    expect((await ok(call('GET', U('year-end'), prep.h))).items.find((y: any) => y.end === '2025-12-31').status).toBe('OPEN');
    expect((await tb('2025-01-01', '2025-12-31')).find((r) => r.code === '4010')).toMatchObject({ closingCr: '120000.00' });
    await ok(call('POST', U('periods/2025-06/reopen'), OM, { reason: 'A late bill turned up' }));
    // and the year can be closed again
    await ok(call('POST', U('periods/2025-06/close'), OM)); expect((await ok(call('GET', U('year-end/preview?end=2025-12-31'), prep.h))).canClose).toBe(true);
  });
});
