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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'recon'); O = as(T.tenantId, T.ownerUserId); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

const U = (t: string) => `/v1/finance/${t}`;
const csvOf = (rows: string[][]) => ['Date,Description,Reference,Debit,Credit,Balance', ...rows.map((r) => r.join(','))].join('\n');
describe('bank reconciliation', () => {
  it('imports a statement without double counting, matches only what fits, books the rest, and signs off with a lock', async () => {
    at('2026-11-10', '10:00');
    const OM = as(T.tenantId, T.ownerUserId, { mfa: true });
    const p1 = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `RC${++n}`, name: `Branch ${n}` })).json().id as string;
    const mk = async (role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@recon.test`); await assignRole(T.tenantId, id, role, 'TENANT', null); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };
    const prep = await mk('accountant'), fd = await mk('front_desk_agent');
    await ok(call('POST', U('accounts/starter'), OM)); await ok(call('PUT', U('settings'), OM, { selfApproveLimit: '1000000' }));
    const bank = await ok(call('POST', '/v1/payment-accounts', OM, { kind: 'BANK', name: 'Company bank', bankName: 'Test Bank', accountTitle: 'Sunset BNB' }), 201);
    await code(call('POST', U('bank/statements'), prep.h, { bankId: bank.id, csv: csvOf([['2026-11-10', 'x', '', '', '5', '']]) }), 409, 'BANK_NO_LEDGER');
    await ok(call('POST', U(`banks/${bank.id}/ledger-account`), OM)); await ok(call('PUT', U(`banks/${bank.id}`), OM, { accountType: 'CURRENT', purpose: 'BOTH', branchIds: [p1] }));
    const post = async (body: object) => { const v = await ok(call('POST', U('vouchers/quick'), prep.h, body), 201); await ok(call('POST', U(`vouchers/${v.id}/submit`), prep.h)); await ok(call('POST', U(`vouchers/${v.id}/approve`), OM)); return v.id as string; };
    const rcv = (d: string, amt: string, ref: string) => post({ type: 'BRV', date: d, narration: `Guest transfer ${ref}`, amount: amt, money: { kind: 'BANK', bankId: bank.id, branchId: p1 }, other: '4010' });
    await rcv('2026-11-10', '12000', 'BDC-1'); await rcv('2026-11-11', '8000', 'A'); await rcv('2026-11-11', '8000', 'B');      // two receipts of 8,000: the statement cannot tell them apart
    await post({ type: 'BPV', date: '2026-11-12', narration: 'Supplier payment', amount: '3000', money: { kind: 'BANK', bankId: bank.id, branchId: p1 }, other: '5100' });
    // the statement: 12,000 in (matches), 8,000 in (ambiguous), 3,000 out (matches), 500 charge, 4,000 in nobody knows about
    const file = csvOf([['2026-11-10', 'IBFT from guest', 'BDC-1', '', '12000.00', '12000.00'], ['2026-11-11', 'IBFT 8000', '', '', '8000.00', '20000.00'], ['2026-11-12', 'Cheque 001', '', '3000.00', '', '17000.00'], ['2026-11-13', 'SMS charges', '', '500.00', '', '16500.00'], ['2026-11-13', 'IBFT unknown sender', 'XYZ', '', '"4,000.00"', '20500.00']]);
    await code(call('POST', U('bank/statements'), fd.h, { bankId: bank.id, csv: file }), 403, 'PERMISSION_DENIED');
    await code(call('POST', U('bank/statements'), prep.h, { bankId: bank.id, csv: 'Foo,Bar\n1,2' }), 400, 'STATEMENT_COLUMNS');
    await code(call('POST', U('bank/statements'), prep.h, { bankId: bank.id, csv: 'Date,Debit,Credit\nnot-a-date,,5' }), 400, 'STATEMENT_ROW');
    const imp = await ok(call('POST', U('bank/statements'), prep.h, { bankId: bank.id, filename: 'nov.csv', csv: file }), 201); expect(imp).toMatchObject({ rows: 5, added: 5, duplicates: 0, autoMatched: 2 });
    const again = await ok(call('POST', U('bank/statements'), prep.h, { bankId: bank.id, csv: file }), 201); expect(again).toMatchObject({ added: 0, duplicates: 5, autoMatched: 0 });     // importing the same file again changes nothing
    let lines = (await ok(call('GET', U(`bank/lines?bankId=${bank.id}`), prep.h))).items as any[];
    const by = (nar: string) => lines.find((l) => l.narration === nar);
    expect(by('IBFT from guest')).toMatchObject({ status: 'MATCHED' }); expect(by('Cheque 001')).toMatchObject({ status: 'MATCHED' }); expect(by('IBFT 8000')).toMatchObject({ status: 'UNMATCHED' });     // two equal candidates: not guessed
    // a person chooses; amounts must add up
    const led = (await ok(call('GET', U(`bank/ledger?bankId=${bank.id}&to=2026-11-30`), prep.h))).items as any[]; const cands = led.filter((e) => e.in === '8000.00'); expect(cands).toHaveLength(2);
    await code(call('POST', U(`bank/lines/${by('IBFT 8000').id}/match`), prep.h, { entryIds: [cands[0].id, cands[1].id] }), 409, 'AMOUNT_MISMATCH');
    await ok(call('POST', U(`bank/lines/${by('IBFT 8000').id}/match`), prep.h, { entryIds: [cands[0].id] }));
    await code(call('POST', U(`bank/lines/${by('IBFT 8000').id}/match`), prep.h, { entryIds: [cands[1].id] }), 409, 'NOT_UNMATCHED');
    // the books do not know the charge or the 4,000: charge to bank charges, unknown money to the unallocated queue; both need the approver permission
    await code(call('POST', U(`bank/lines/${by('SMS charges').id}/book`), fd.hm, { kind: 'CHARGE' }), 403, 'PERMISSION_DENIED');
    await code(call('POST', U(`bank/lines/${by('SMS charges').id}/book`), OM, { kind: 'SUSPENSE' }), 400, 'VALIDATION_FAILED');
    await ok(call('POST', U(`bank/lines/${by('SMS charges').id}/book`), OM, { kind: 'CHARGE' })); await ok(call('POST', U(`bank/lines/${by('IBFT unknown sender').id}/book`), OM, { kind: 'SUSPENSE', note: 'Asked the guest desk' }));
    // one 8,000 receipt is in the books but not on the statement: the reconciliation shows it and does not balance until explained
    const sum = await ok(call('GET', U(`bank/summary?bankId=${bank.id}&to=2026-11-30&statementBalance=20500`), prep.h));
    expect(sum).toMatchObject({ reconciled: true, booksOnlyReceipts: '8000.00', statementOnlyCredits: '0.00', booksOnlyCount: 1 });
    expect((await ok(call('GET', U(`bank/summary?bankId=${bank.id}&to=2026-11-30&statementBalance=20400`), prep.h))).reconciled).toBe(false);
    await code(call('POST', U('bank/reconciliations'), prep.h, { bankId: bank.id, to: '2026-11-30', statementBalance: '20400' }), 409, 'NOT_RECONCILED');
    // unallocated queue
    const q = (await ok(call('GET', U('bank/suspense'), prep.h))).items; expect(q).toHaveLength(1); expect(q[0]).toMatchObject({ amount: '4000.00', reference: 'XYZ', status: 'OPEN', bank: 'Company bank' });
    const tb = (await ok(call('GET', U('reports/trial-balance?from=2026-11-01&to=2026-11-30'), O))).rows as any[]; expect(tb.find((r) => r.code === '1800')).toMatchObject({ closingCr: '4000.00' }); expect(tb.find((r) => r.code === '5130')).toMatchObject({ closingDr: '500.00' });
    const al = await ok(call('POST', U(`bank/suspense/${q[0].id}/allocate`), prep.h, { account: '4010', branchId: p1, reason: 'Guest confirmed by phone: booking BDC-9' }), 201);
    expect((await ok(call('GET', U('bank/suspense'), prep.h))).items[0].status).toBe('ALLOCATING');
    await code(call('POST', U(`bank/suspense/${q[0].id}/allocate`), prep.h, { account: '4010', reason: 'Second attempt here' }), 409, 'NOT_OPEN');
    await ok(call('POST', U(`vouchers/${al.voucherId}/submit`), prep.h)); await ok(call('POST', U(`vouchers/${al.voucherId}/approve`), OM));
    expect((await ok(call('GET', U('bank/suspense'), prep.h))).items).toHaveLength(0);
    expect(((await ok(call('GET', U('reports/trial-balance?from=2026-11-01&to=2026-11-30'), O))).rows as any[]).find((r) => r.code === '1800')).toMatchObject({ closingDr: '0.00', closingCr: '0.00' });
    // sign-off: a second person, then the period is locked
    const rec = await ok(call('POST', U('bank/reconciliations'), prep.h, { bankId: bank.id, to: '2026-11-30', statementBalance: '20500' }), 201);
    await code(call('POST', U(`bank/reconciliations/${rec.id}/approve`), prep.hm), 403, 'FINANCE_SELF_APPROVAL');
    await ok(call('POST', U(`bank/reconciliations/${rec.id}/approve`), OM));
    await code(call('POST', U(`bank/lines/${by('IBFT from guest').id}/unmatch`), prep.h, { reason: 'checking the lock' }), 409, 'RECON_LOCKED');
    const bb = await ok(call('GET', U(`reports/bank-book?bankId=${bank.id}&from=2026-11-01&to=2026-11-30`), prep.h)); expect(bb.rows.at(-1).cells[5]).toBe('28500.00'); expect(bb.rows.filter((r: any) => r.cells[6] === 'not on a statement')).toHaveLength(1);
  });
});
