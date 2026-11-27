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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'recur'); O = as(T.tenantId, T.ownerUserId); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

const U = (t: string) => `/v1/finance/${t}`;
describe('recurring expenses', () => {
  it('prepare each period\'s bill as a draft, once, for review and approval by a second person', async () => {
    at('2026-11-10', '10:00');
    const OM = as(T.tenantId, T.ownerUserId, { mfa: true });
    const mkProp = async () => (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `RC${++n}`, name: `Branch ${n}` })).json().id as string;
    const p1 = await mkProp(), p2 = await mkProp();
    const mk = async (role: string, scope: 'TENANT' | 'PROPERTY' = 'TENANT', pid: string | null = null) => { const id = await addUser(T.tenantId, `${role}${++n}@recur.test`); await assignRole(T.tenantId, id, role, scope, pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };
    const prep = await mk('accountant'), ba = await mk('branch_accountant', 'PROPERTY', p1);
    await ok(call('POST', U('accounts/starter'), OM));
    const sup = (await ok(call('POST', U('suppliers'), prep.h, { name: 'Landlord Ltd', paymentTermsDays: 10 }), 201)).id as string;
    const rent = { code: 'rent-p1', name: 'Rent', supplierId: sup, branchId: p1, frequency: 'MONTHLY', dayOfMonth: 5, startMonth: '2026-09', narration: 'Monthly rent', lines: [{ account: '5060', amount: '150000' }] };
    const net = { code: 'NET-P1', name: 'Internet', supplierId: sup, branchId: p1, frequency: 'QUARTERLY', dayOfMonth: 1, startMonth: '2026-09', narration: 'Internet for the quarter', lines: [{ account: '5050', amount: '8000' }] };
    await code(call('POST', U('recurring'), prep.h, { ...rent, lines: [{ account: '4010', amount: '1' }] }), 400, 'ACCOUNT_KIND');
    const r = (await ok(call('POST', U('recurring'), prep.h, rent), 201)).id as string; await code(call('POST', U('recurring'), prep.h, rent), 409, 'TEMPLATE_EXISTS'); const nId = (await ok(call('POST', U('recurring'), prep.h, net), 201)).id as string;
    await code(call('POST', U('recurring'), ba.h, { ...net, code: 'NET-P2', branchId: p2 }), 403, 'BRANCH_NOT_ALLOWED');
    const own = await ok(call('POST', U('recurring'), ba.h, { ...net, code: 'NET-OWN' }), 201); void own;
    const other = (await ok(call('POST', U('recurring'), prep.h, { ...net, code: 'NET-P2', branchId: p2 }), 201)).id as string; void other;
    // what falls due: rent every month, internet every third month
    const codes = async (m: string, h = prep.h) => ((await ok(call('GET', U(`recurring/due?month=${m}`), h))).items as any[]).map((x) => x.code).sort();
    expect(await codes('2026-09')).toEqual(['NET-OWN', 'NET-P1', 'NET-P2', 'RENT-P1']); expect(await codes('2026-10')).toEqual(['RENT-P1']); expect(await codes('2026-12')).toEqual(['NET-OWN', 'NET-P1', 'NET-P2', 'RENT-P1']); expect(await codes('2026-08')).toEqual([]);
    expect(await codes('2026-09', ba.h)).toEqual(['NET-OWN', 'NET-P1', 'RENT-P1']);                          // a branch role sees its own branch's
    // preparing: a draft bill, once
    await code(call('POST', U(`recurring/${nId}/prepare`), prep.h, { month: '2026-10' }), 409, 'NOT_DUE');
    const all = await ok(call('POST', U('recurring/prepare-due'), prep.h, { month: '2026-09' }), 201); expect(all.prepared.sort()).toEqual(['NET-OWN', 'NET-P1', 'NET-P2', 'RENT-P1']); expect(all.skipped).toEqual([]);
    expect(await codes('2026-09')).toEqual([]); await code(call('POST', U(`recurring/${r}/prepare`), prep.h, { month: '2026-09' }), 409, 'ALREADY_PREPARED');
    expect((await ok(call('POST', U('recurring/prepare-due'), prep.h, { month: '2026-09' }), 201)).prepared).toEqual([]);
    let bills = (await ok(call('GET', U(`supplier-bills?supplierId=${sup}`), prep.h))).items as any[]; const b9 = bills.find((b) => b.billNo === 'RENT-P1-2026-09'); expect(b9).toMatchObject({ status: 'DRAFT', total: '150000.00', billDate: '2026-09-05', dueDate: '2026-09-15' });
    // this month's bill is different: change it when preparing
    const o = await ok(call('POST', U(`recurring/${r}/prepare`), prep.h, { month: '2026-10', lines: [{ account: '5060', amount: '155000' }] }), 201); expect(o.billNo).toBe('RENT-P1-2026-10');
    bills = (await ok(call('GET', U(`supplier-bills?supplierId=${sup}`), prep.h))).items as any[]; expect(bills.find((b) => b.billNo === 'RENT-P1-2026-10').total).toBe('155000.00');
    // a second person approves; then it is owed like any bill
    await ok(call('POST', U(`vouchers/${b9.voucherId}/submit`), prep.h)); await code(call('POST', U(`vouchers/${b9.voucherId}/approve`), prep.hm), 403, 'FINANCE_SELF_APPROVAL'); await ok(call('POST', U(`vouchers/${b9.voucherId}/approve`), OM));
    expect((await ok(call('GET', U('suppliers'), prep.h))).items[0].owed).toBe('150000.00');
    // switched off: no longer due, cannot be prepared
    await ok(call('PUT', U(`recurring/${r}`), prep.h, { active: false })); expect(await codes('2026-11')).toEqual([]); await code(call('POST', U(`recurring/${r}/prepare`), prep.h, { month: '2026-11' }), 409, 'TEMPLATE_OFF');
    expect(((await ok(call('GET', U('recurring'), ba.h))).items as any[]).map((x) => x.code).sort()).toEqual(['NET-OWN', 'NET-P1', 'RENT-P1']); expect((await ok(call('GET', U('recurring'), prep.h))).items.find((x: any) => x.code === 'RENT-P1')).toMatchObject({ lastPrepared: '2026-10', total: '150000.00', active: false });
  });
});
