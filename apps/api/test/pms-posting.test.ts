import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { zonedToUtcMs } from '@hos/domain-types';
import { addUser, adminDb, as, assignRole, createTestApp, provision, testClock } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
let O: Record<string, string>, OM: Record<string, string>;
const OPEN = '2026-11-01';
let n = 0;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...headers, ...extra }, payload: body as object | undefined });
const ok = async (r: Promise<any>, status = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json(); };
const code = async (r: Promise<any>, status: number, c: string) => { const x = await r; expect(x.statusCode, x.body).toBe(status); expect(x.json().code).toBe(c); return x.json(); };
const key = () => ({ 'idempotency-key': `fo-${++n}-${Date.now()}` });

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'pmsfin'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

async function sunset() {
  const pcode = `FO${++n}`;
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: pcode, name: `Folio ${pcode}` })).json().id as string;
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'STD', name: 'Standard', maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id as string;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, from: 101, to: 104 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'Best Available', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '12000', extraAdult: '3000', extraChild: '1500' }] });
  const rooms = (await call('GET', `/v1/properties/${pid}/rooms`, O)).json().items as Array<{ id: string; number: string }>;
  const room = Object.fromEntries(rooms.map((r) => [r.number, r.id])) as Record<string, string>;
  return { pid, rt, bar, room };
}
type W = Awaited<ReturnType<typeof sunset>>;
const setBd = (w: W, d: string) => adminDb.updateTable('property').set({ business_date: d }).where('id', '=', w.pid).execute();
const u = (w: W, tail: string) => `/v1/properties/${w.pid}/${tail}`;
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@folio.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

async function book(w: W, o: { arrival?: string; departure?: string; channel?: string; source?: string } = {}) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival ?? '2026-11-05', departure: o.departure ?? '2026-11-07', adults: 2, channel: o.channel ?? 'PHONE' })).json();
  const opt = q.options.find((x: any) => x.plan.code === 'BAR');
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Payer ${++n}`, phone: `0300${String(4000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: o.source ?? 'PHONE', lines: [{ quoteToken: opt.quoteToken }] }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string, res: r };
}
const checkIn = (w: W, b: { id: string; line: string }, room: string) => ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-in`), O, { roomId: w.room[room], occupants: [{ fullName: 'Payer', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671' }] }));
const checkOut = (w: W, b: { id: string; line: string }, body: Record<string, unknown> = {}, h = OM) => call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-out`), h, body);
const folio = (w: W, b: { id: string }, h = O) => ok(call('GET', u(w, `reservations/${b.id}/folio`), h));
const pay = (w: W, b: { id: string }, body: Record<string, unknown>, h = O) => call('POST', u(w, `reservations/${b.id}/payments`), h, body, key());
const openCash = (w: W, h = O, float = '5000') => ok(call('POST', u(w, 'cashier/sessions'), h, { openingFloat: float }), 201);
const check = async (w: W) => (await ok(call('GET', u(w, 'folio-check'), O))).issues as unknown[];
const amt = (x: { amount: string }) => x.amount;

const F = (t: string) => `/v1/finance/${t}`;
const tb = async (extra = '') => ok(call('GET', F(`reports/trial-balance?from=2026-11-01&to=2026-12-31${extra}`), O));
const bal = (t: any, code: string) => { const r = t.rows.find((x: any) => x.code === code); return r ? { dr: r.closingDr, cr: r.closingCr } : { dr: '0.00', cr: '0.00' }; };

describe('automatic posting of PMS money to the ledger', () => {
  it('payments, advances, charges, voids and company receipts post once, balanced, tagged to the branch; failures never block the hotel', async () => {
    const w = await sunset(); await setBd(w, '2026-11-05');
    await code(call('POST', F('pms/enable'), OM, { from: '2026-11-01' }), 409, 'NO_CHART');
    await ok(call('POST', F('accounts/starter'), OM));
    await code(call('POST', F('pms/enable'), O, { from: '2026-11-01' }), 403, 'MFA_REQUIRED');
    const en = await ok(call('POST', F('pms/enable'), OM, { from: '2026-11-01' })); expect(en.mappingsFilled).toBeGreaterThan(15);
    const st = await ok(call('GET', F('pms'), O)); expect(st.enabledFrom).toBe('2026-11-01'); expect(st.mappings.find((m: any) => m.key === 'CASH').account).toBe('1010'); expect(st.mappings.find((m: any) => m.key === 'GUEST_LEDGER').account).toBe('1250');
    const b = await book(w); await checkIn(w, b, '101'); await openCash(w);
    const fid = (await folio(w, b)).folio.id as string;
    // 5000 paid before anything is owed: an advance. 3000 charged: taken from the advance. 4000 more: the rest of the advance, then what the guest owes. 3000 paid: clears the debt, 1000 left as advance.
    await ok(pay(w, b, { method: 'CASH', amount: '5000' }), 201);
    await ok(call('POST', u(w, `folios/${fid}/charges`), O, { txnCode: 'FNB', amount: '1500', quantity: 2, description: 'Dinner' }), 201);
    await ok(call('POST', u(w, `folios/${fid}/charges`), O, { txnCode: 'MISC', amount: '4000', description: 'Item' }), 201);
    const p3 = await ok(pay(w, b, { method: 'CASH', amount: '3000' }), 201);
    let t = await tb(); expect(t.balanced).toBe(true);
    expect(bal(t, '1010')).toEqual({ dr: '8000.00', cr: '0.00' }); expect(bal(t, '2100')).toEqual({ dr: '0.00', cr: '1000.00' }); expect(bal(t, '1250')).toEqual({ dr: '0.00', cr: '0.00' });
    expect(bal(t, '4060')).toEqual({ dr: '0.00', cr: '3000.00' }); expect(bal(t, '4080')).toEqual({ dr: '0.00', cr: '4000.00' });
    expect((await folio(w, b)).folio.balance.amount).toBe('-1000.00');
    expect(bal(await tb(`&branchId=${w.pid}`), '1010')).toEqual({ dr: '8000.00', cr: '0.00' });     // every line is tagged to the branch
    const rec = await ok(call('GET', F('pms/reconciliation?from=2026-11-01&to=2026-11-30'), O)); expect(rec.agrees).toBe(true); expect(rec.difference).toBe('0.00'); expect(rec.pmsEntries).toBe(4);
    // a void is posted the other way round
    await ok(call('POST', u(w, `payments/${p3.payment.id}/void`), OM, { reason: 'Mistake' }));
    t = await tb(); expect(t.balanced).toBe(true); expect(bal(t, '1010')).toEqual({ dr: '5000.00', cr: '0.00' }); expect(bal(t, '1250')).toEqual({ dr: '2000.00', cr: '0.00' }); expect(bal(t, '2100')).toEqual({ dr: '0.00', cr: '0.00' });
    expect((await ok(call('GET', F('pms/reconciliation?from=2026-11-01&to=2026-11-30'), O))).agrees).toBe(true);
    // nothing double posts, and the ledger is the posted vouchers
    const v = await ok(call('GET', F('vouchers?status=POSTED'), O)); expect(v.items).toHaveLength(5); expect(v.items.every((x: any) => x.type === 'PMS' && /^PMS-2026-/.test(x.voucherNo))).toBe(true);
    // a missing account does not stop the payment; it waits in the exceptions list until the account is set
    await ok(call('PUT', F('pms/map/CASH'), OM, { account: null }));
    await ok(pay(w, b, { method: 'CASH', amount: '1000' }), 201);
    expect((await ok(call('GET', F('pms/exceptions'), O))).items).toHaveLength(1);
    expect((await ok(call('GET', F('pms/reconciliation?from=2026-11-01&to=2026-11-30'), O))).agrees).toBe(false);
    await code(call('PUT', F('pms/map/CASH'), OM, { account: '1000' }), 400, 'ACCOUNT_IS_HEADING');
    await ok(call('PUT', F('pms/map/CASH'), OM, { account: '1010' }));
    expect(await ok(call('POST', F('pms/retry'), OM))).toMatchObject({ tried: 1, fixed: 1 });
    expect((await ok(call('GET', F('pms/exceptions'), O))).items).toHaveLength(0); expect((await ok(call('GET', F('pms/reconciliation?from=2026-11-01&to=2026-11-30'), O))).agrees).toBe(true);
    // a closed month never blocks the hotel: the entry lands on the first day of the next open month
    await ok(call('POST', F('periods/2026-11/close'), OM));
    await ok(call('POST', u(w, `folios/${fid}/charges`), O, { txnCode: 'LAUNDRY', amount: '700', description: 'Laundry' }), 201);
    const last = (await ok(call('GET', F('vouchers?status=POSTED'), O))).items[0]; expect(last.postingDate).toBe('2026-12-01'); expect(last.date).toBe('2026-11-05');
    expect((await ok(call('GET', F('pms/reconciliation?from=2026-11-01&to=2026-11-30'), O))).agrees).toBe(true);
    // switched off: nothing more is posted
    await ok(call('POST', F('pms/disable'), OM)); const n = (await ok(call('GET', F('vouchers?status=POSTED'), O))).items.length;
    await ok(call('POST', u(w, `folios/${fid}/charges`), O, { txnCode: 'MISC', amount: '100', description: 'Item' }), 201); expect((await ok(call('GET', F('vouchers?status=POSTED'), O))).items).toHaveLength(n);
    expect(await check(w)).toEqual([]);
  });
});
