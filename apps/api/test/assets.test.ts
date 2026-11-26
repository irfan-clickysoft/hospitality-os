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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'assets'); O = as(T.tenantId, T.ownerUserId); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

const U = (t: string) => `/v1/finance/${t}`;
describe('fixed assets and depreciation', () => {
  it('registers assets, depreciates them monthly through an approved voucher, disposes of them and keeps the register equal to the books', async () => {
    at('2026-11-10', '10:00');
    const OM = as(T.tenantId, T.ownerUserId, { mfa: true });
    const mkProp = async () => (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `FA${++n}`, name: `Branch ${n}` })).json().id as string;
    const p1 = await mkProp(), p2 = await mkProp();
    const mk = async (role: string, scope: 'TENANT' | 'PROPERTY' = 'TENANT', pid: string | null = null) => { const id = await addUser(T.tenantId, `${role}${++n}@assets.test`); await assignRole(T.tenantId, id, role, scope, pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };
    const prep = await mk('accountant'), ba = await mk('branch_accountant', 'PROPERTY', p1);
    await ok(call('POST', U('accounts/starter'), OM)); await ok(call('PUT', U('settings'), OM, { capitalisationThreshold: '10000' }));
    const approve = async (vid: string) => { await ok(call('POST', U(`vouchers/${vid}/submit`), prep.h)); await ok(call('POST', U(`vouchers/${vid}/approve`), OM)); };
    const jv = async (d: string, lines: object[]) => { const v = await ok(call('POST', U('vouchers'), prep.h, { type: 'JV', date: d, narration: 'Entry', lines }), 201); await approve(v.id); };
    const base = { category: 'EQUIPMENT', branchId: p1, acquiredOn: '2026-09-15', cost: '120000', lifeMonths: 12, name: 'Geyser' };
    await code(call('POST', U('assets'), prep.hm, { ...base, cost: '5000' }), 409, 'ASSET_BELOW_THRESHOLD');
    await code(call('POST', U('assets'), prep.hm, { ...base, salvage: '120000' }), 400, 'VALIDATION_FAILED');
    await code(call('POST', U('assets'), ba.hm, base), 403, 'PERMISSION_DENIED');
    const A = await ok(call('POST', U('assets'), prep.hm, base), 201); expect(A.assetNo).toBe('FA-0001');
    const B = await ok(call('POST', U('assets'), prep.hm, { name: 'Air conditioner', category: 'ELECTRONICS', branchId: p2, acquiredOn: '2026-09-20', cost: '60000', salvage: '6000', lifeMonths: 36, depreciateFrom: '2026-10', openingAccumulated: '3000' }), 201); expect(B.assetNo).toBe('FA-0002');
    // bought with cash earlier (cost on the books); the register and the books are compared
    await jv('2026-09-15', [{ account: '1500', branchId: p1, debit: '120000' }, { account: '3010', credit: '180000' }, { account: '1500', branchId: p2, debit: '60000' }]);
    let sm = await ok(call('GET', U('assets/summary'), prep.h)); expect(sm.agrees).toBe(false); expect(sm.difference).toEqual({ cost: '0.00', accumulated: '-3000.00' });
    await jv('2026-09-30', [{ account: '3010', debit: '3000' }, { account: '1590', branchId: p2, credit: '3000' }]);
    sm = await ok(call('GET', U('assets/summary'), prep.h)); expect(sm.agrees).toBe(true);
    // the monthly run
    await code(call('POST', U('assets/depreciation'), prep.h, { month: '2026-12' }), 409, 'FUTURE_MONTH');
    const r9 = await ok(call('POST', U('assets/depreciation'), prep.h, { month: '2026-09' }), 201); expect(r9).toMatchObject({ assets: 1, total: '10000.00' });          // the second asset starts in October
    await code(call('POST', U('assets/depreciation'), prep.h, { month: '2026-09' }), 409, 'RUN_EXISTS');
    await approve(r9.voucherId);
    const r10 = await ok(call('POST', U('assets/depreciation'), prep.h, { month: '2026-10' }), 201); expect(r10).toMatchObject({ assets: 2, total: '11500.00' });
    await ok(call('POST', U(`vouchers/${r10.voucherId}/cancel`), prep.h));                              // cancelling frees the month
    const r10b = await ok(call('POST', U('assets/depreciation'), prep.h, { month: '2026-10' }), 201); await approve(r10b.voucherId);
    const list = (await ok(call('GET', U('assets'), prep.h))).items as any[]; const a = list.find((x) => x.assetNo === 'FA-0001'), b = list.find((x) => x.assetNo === 'FA-0002');
    expect(a).toMatchObject({ accumulated: '20000.00', netBookValue: '100000.00', monthly: '10000.00', status: 'IN_SERVICE' }); expect(b).toMatchObject({ accumulated: '4500.00', netBookValue: '55500.00', monthly: '1500.00' });
    const tb = async () => (await ok(call('GET', U('reports/trial-balance?from=2026-09-01&to=2026-12-31'), O))).rows as any[];
    expect((await tb()).find((r) => r.code === '5180')).toMatchObject({ closingDr: '21500.00' }); expect((await tb()).find((r) => r.code === '1590')).toMatchObject({ closingCr: '24500.00' });
    expect((await ok(call('GET', U('assets/summary'), prep.h))).agrees).toBe(true);
    // a branch role sees only its own branch's assets
    expect(((await ok(call('GET', U('assets'), ba.h))).items as any[]).map((x) => x.assetNo)).toEqual(['FA-0001']);
    // disposal waits for pending depreciation, then books the gain
    const r11 = await ok(call('POST', U('assets/depreciation'), prep.h, { month: '2026-11' }), 201);
    const disp = { date: '2026-11-26', proceeds: '100000', money: { kind: 'CASH' }, reason: 'Sold to a neighbour' };
    await code(call('POST', U(`assets/${a.id}/dispose`), prep.h, disp), 409, 'DEPRECIATION_PENDING'); await approve(r11.voucherId);
    await code(call('POST', U(`assets/${a.id}/dispose`), prep.h, { ...disp, money: undefined }), 400, 'VALIDATION_FAILED');
    const d = await ok(call('POST', U(`assets/${a.id}/dispose`), prep.h, disp), 201); expect(d.gainOrLoss).toBe('10000.00');                  // worth 90,000 in the books, sold for 100,000
    await code(call('POST', U(`assets/${a.id}/dispose`), prep.h, disp), 409, 'DISPOSAL_PENDING'); await approve(d.voucherId);
    expect(((await ok(call('GET', U('assets'), prep.h))).items as any[]).find((x) => x.id === a.id)).toMatchObject({ status: 'DISPOSED', disposedOn: '2026-11-26' });
    const t = await tb(); expect(t.find((r) => r.code === '1500')).toMatchObject({ closingDr: '60000.00' }); expect(t.find((r) => r.code === '4110')).toMatchObject({ closingCr: '10000.00' }); expect(t.find((r) => r.code === '1590')).toMatchObject({ closingCr: '6000.00' });
    expect((await ok(call('GET', U('assets/summary'), prep.h))).agrees).toBe(true);
    await code(call('POST', U('assets/depreciation'), prep.h, { month: '2026-11' }), 409, 'RUN_EXISTS');
    // no further depreciation on a disposed asset; reversing the disposal puts it back
    const rv = await ok(call('POST', U(`vouchers/${d.voucherId}/reverse`), prep.h, { date: '2026-11-26', reason: 'Sale fell through' }), 201); await approve(rv.id);
    expect(((await ok(call('GET', U('assets'), prep.h))).items as any[]).find((x) => x.id === a.id)).toMatchObject({ status: 'IN_SERVICE', accumulated: '30000.00' });
  });
});
