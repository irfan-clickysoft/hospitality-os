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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'fin'); O = as(T.tenantId, T.ownerUserId); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

const U = (t: string) => `/v1/finance/${t}`;
describe('finance core', () => {
  it('accounts, vouchers with a second approver, an immutable ledger, reversals and period locks', async () => {
    at('2026-11-10', '10:00');
    const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `FN${++n}`, name: 'Branch One' })).json().id as string;
    const OM = as(T.tenantId, T.ownerUserId, { mfa: true });
    const mk = async (role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@fin.test`); await assignRole(T.tenantId, id, role, 'TENANT', null); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };
    const fd = await mk('front_desk_agent'), prep = await mk('accountant'), gm = await mk('general_manager');
    await code(call('GET', U('accounts'), fd.h), 403, 'PERMISSION_DENIED');
    await ok(call('GET', U('accounts'), gm.h)); await code(call('POST', U('vouchers'), gm.h, { type: 'JV', date: '2026-11-10', narration: 'x y z', lines: [] }), 403, 'PERMISSION_DENIED');
    // chart of accounts
    await code(call('POST', U('accounts/starter'), O), 403, 'MFA_REQUIRED');
    const st = await ok(call('POST', U('accounts/starter'), OM)); expect(st.loaded).toBeGreaterThan(50);
    await code(call('POST', U('accounts/starter'), OM), 409, 'CHART_EXISTS');
    await code(call('POST', U('accounts'), OM, { code: '1010', name: 'Dup', type: 'asset' }), 409, 'ACCOUNT_EXISTS');
    await code(call('POST', U('accounts'), OM, { code: '1011', name: 'Wrong parent', type: 'liability', parentCode: '1000' }), 409, 'PARENT_TYPE');
    await ok(call('POST', U('accounts'), OM, { code: '1101', name: 'Bank test account', type: 'asset', parentCode: '1100', control: 'BANK' }), 201);
    const accts = (await ok(call('GET', U('accounts'), prep.h))).items; expect(accts.find((a: any) => a.code === '4010')).toMatchObject({ normalBalance: 'CREDIT', isGroup: false }); expect(accts.find((a: any) => a.code === '1000').isGroup).toBe(true);
    // a voucher
    const body = (amt = '15000') => ({ type: 'JV', date: '2026-11-10', narration: 'Repair paid in cash', lines: [{ account: '5100', branchId: pid, debit: amt }, { account: '1010', branchId: pid, credit: amt }] });
    await code(call('POST', U('vouchers'), prep.h, { ...body(), lines: [{ account: '1000', debit: '5' }, { account: '1010', credit: '5' }] }), 400, 'ACCOUNT_IS_HEADING');
    await code(call('POST', U('vouchers'), prep.h, { ...body(), lines: [{ account: '9999', debit: '5' }, { account: '1010', credit: '5' }] }), 400, 'ACCOUNT_UNKNOWN');
    await code(call('POST', U('vouchers'), prep.h, { ...body(), lines: [{ account: '5100', debit: '5', credit: '5' }, { account: '1010', credit: '5' }] }), 400, 'VALIDATION_FAILED');
    const unbal = await ok(call('POST', U('vouchers'), prep.h, { ...body(), lines: [{ account: '5100', debit: '100' }, { account: '1010', credit: '90' }] }), 201); expect(unbal.balanced).toBe(false); expect(unbal.difference).toBe('10.00');
    await code(call('POST', `/v1/finance/vouchers/${unbal.id}/submit`, prep.h), 409, 'NOT_BALANCED');
    const v = await ok(call('POST', U('vouchers'), prep.h, body()), 201); expect(v.balanced).toBe(true);
    const sub = await ok(call('POST', U(`vouchers/${v.id}/submit`), prep.h)); expect(sub.voucherNo).toBe('JV-2026-000001');
    await code(call('PUT', U(`vouchers/${v.id}`), prep.h, body('20000')), 409, 'VOUCHER_LOCKED');
    await code(call('POST', U(`vouchers/${v.id}/approve`), prep.hm), 403, 'FINANCE_SELF_APPROVAL');
    await code(call('POST', U(`vouchers/${v.id}/approve`), gm.hm), 403, 'PERMISSION_DENIED');
    const rej = await ok(call('POST', U('vouchers'), prep.h, body('700')), 201); await ok(call('POST', U(`vouchers/${rej.id}/submit`), prep.h));
    await ok(call('POST', U(`vouchers/${rej.id}/reject`), OM, { reason: 'No receipt attached' })); expect((await ok(call('GET', U(`vouchers/${rej.id}`), prep.h))).status).toBe('REJECTED');
    await ok(call('POST', U(`vouchers/${rej.id}/cancel`), prep.h));
    const posted = await ok(call('POST', U(`vouchers/${v.id}/approve`), OM)); expect(posted.status).toBe('POSTED');
    await code(call('POST', U(`vouchers/${v.id}/approve`), OM), 409, 'VOUCHER_NOT_SUBMITTED');
    // the ledger cannot be changed, even by a direct database write
    await expect(adminDb.updateTable('voucher_line').set({ debit_minor: '1' } as never).where('voucher_id', '=', v.id).execute()).rejects.toThrow(/cannot be changed/);
    await expect(adminDb.updateTable('voucher').set({ narration: 'sneaky edit' } as never).where('id', '=', v.id).execute()).rejects.toThrow(/posted voucher cannot be changed/);
    await expect(adminDb.deleteFrom('gl_entry').where('voucher_id', '=', v.id).execute()).rejects.toThrow();
    // reports
    const tb = await ok(call('GET', U('reports/trial-balance?from=2026-11-01&to=2026-11-30'), prep.h)); expect(tb.balanced).toBe(true); expect(tb.rows).toHaveLength(2);
    expect(tb.rows.find((r: any) => r.code === '5100')).toMatchObject({ debit: '15000.00', closingDr: '15000.00' }); expect(tb.rows.find((r: any) => r.code === '1010')).toMatchObject({ credit: '15000.00', closingCr: '15000.00' });
    const gl = await ok(call('GET', U('reports/general-ledger?account=1010&from=2026-11-01&to=2026-11-30'), prep.h)); expect(gl.rows).toHaveLength(1); expect(gl.rows[0]).toMatchObject({ voucherNo: 'JV-2026-000001', credit: '15000.00', balance: '-15000.00', branch: 'Branch One' }); expect(gl.closing).toBe('-15000.00');
    // reversal
    await code(call('POST', U(`vouchers/${v.id}/reverse`), prep.h, { date: '2026-11-11', reason: 'x' }), 400, 'VALIDATION_FAILED');
    const rv = await ok(call('POST', U(`vouchers/${v.id}/reverse`), prep.h, { date: '2026-11-11', reason: 'Posted to the wrong branch' }), 201);
    await code(call('POST', U(`vouchers/${v.id}/reverse`), prep.h, { date: '2026-11-11', reason: 'Again please' }), 409, 'ALREADY_REVERSED');
    await ok(call('POST', U(`vouchers/${rv.id}/submit`), prep.h)); await ok(call('POST', U(`vouchers/${rv.id}/approve`), OM));
    const tb2 = await ok(call('GET', U('reports/trial-balance?from=2026-11-01&to=2026-11-30'), prep.h)); expect(tb2.balanced).toBe(true); expect(tb2.rows.every((r: any) => r.closingDr === '0.00' && r.closingCr === '0.00')).toBe(true);
    expect((await ok(call('GET', U(`vouchers/${v.id}`), prep.h))).reversal).toMatchObject({ id: rv.id, status: 'POSTED' });
    // maker-checker limit
    await ok(call('PUT', U('settings'), OM, { selfApproveLimit: '20000' }));
    const own = await ok(call('POST', U('vouchers'), prep.h, body('9000')), 201); await ok(call('POST', U(`vouchers/${own.id}/submit`), prep.h)); expect((await ok(call('POST', U(`vouchers/${own.id}/approve`), prep.hm))).status).toBe('POSTED');
    const big = await ok(call('POST', U('vouchers'), prep.h, body('25000')), 201); await ok(call('POST', U(`vouchers/${big.id}/submit`), prep.h)); await code(call('POST', U(`vouchers/${big.id}/approve`), prep.hm), 403, 'FINANCE_SELF_APPROVAL');
    await code(call('POST', U('periods/2026-11/close'), OM), 409, 'PENDING_VOUCHERS'); await ok(call('POST', U(`vouchers/${big.id}/reject`), OM, { reason: 'Over the limit, resend' }));
    // period lock
    await code(call('POST', U('periods/2026-11/close'), prep.h), 403, 'MFA_REQUIRED'); await ok(call('POST', U('periods/2026-11/close'), OM));
    await code(call('POST', U('vouchers'), prep.h, body()), 409, 'PERIOD_CLOSED');
    await code(call('POST', U(`vouchers/${big.id}/submit`), prep.h), 409, 'PERIOD_CLOSED');
    await code(call('POST', U('periods/2026-11/reopen'), OM, {}), 400, 'VALIDATION_FAILED');
    await ok(call('POST', U('periods/2026-11/reopen'), OM, { reason: 'Late bill from supplier' })); await ok(call('POST', U('vouchers'), prep.h, body()), 201);
    expect((await ok(call('GET', U('periods'), prep.h))).items[0]).toMatchObject({ month: '2026-11', status: 'OPEN' });
    expect((await ok(call('GET', U('vouchers?status=POSTED'), prep.h))).items).toHaveLength(3);
  });
});
