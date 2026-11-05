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
const key = () => ({ 'idempotency-key': `na-${++n}-${Date.now()}` });
const at = (date: string, time: string) => testClock.set(zonedToUtcMs(date, time, 'Asia/Karachi'));

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'fin2'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

async function sunset() {
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `NA${++n}`, name: `Audit ${n}` })).json().id as string;
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'STD', name: 'Standard', maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id as string;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, from: 101, to: 104 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'BAR', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '12000', extraAdult: '3000', extraChild: '1500' }] });
  const rooms = (await call('GET', `/v1/properties/${pid}/rooms`, O)).json().items as Array<{ id: string; number: string }>;
  return { pid, rt, room: Object.fromEntries(rooms.map((r) => [r.number, r.id])) as Record<string, string> };
}
type W = Awaited<ReturnType<typeof sunset>>;
const u = (w: W, tail: string) => `/v1/properties/${w.pid}/${tail}`;
const setBd = (w: W, d: string) => adminDb.updateTable('property').set({ business_date: d }).where('id', '=', w.pid).execute();
const bdOf = async (w: W) => (await adminDb.selectFrom('property').select('business_date').where('id', '=', w.pid).executeTakeFirstOrThrow()).business_date;
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@fin2.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };


async function book(w: W, o: { arrival?: string; departure?: string } = {}) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival ?? '2026-11-05', departure: o.departure ?? '2026-11-07', adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(7000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string };
}
const checkIn = (w: W, b: { id: string; line: string }, room: string) => ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-in`), O, { roomId: w.room[room], occupants: [{ fullName: 'Guest', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671', nationality: 'PK' }] }));

describe('finance ledgers', () => {
  it('payments by receipt and method, refunds and voids, revenue by charge type, tax, and exceptions', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const b = await book(w); await checkIn(w, b, '101');
    const sess = await ok(call('POST', u(w, 'cashier/sessions'), O, { openingFloat: '1000' }), 201);
    const cash = await ok(call('POST', u(w, `reservations/${b.id}/payments`), O, { method: 'CASH', amount: '5000' }, key()), 201);
    await ok(call('POST', u(w, `reservations/${b.id}/payments`), O, { method: 'CARD_SLIP', amount: '3000', cardLast4: '4242', approvalCode: 'A1B2C3', reference: 'RRN123456' }, key()), 201);
    await ok(call('POST', u(w, `payments/${cash.payment.id}/refund`), OM, { amount: '1000', reason: 'Overpaid' }, key()), 201);
    await ok(call('POST', u(w, `cashier/sessions/${sess.id}/close`), O, { counted: '5000' }));

    const all = await ok(call('GET', u(w, 'insights/payments?from=2026-11-05&to=2026-11-05'), O));
    expect(all.rows).toHaveLength(3);
    expect(all.kpis.find((k: any) => k.key === 'rec').value).toBe('8000.00'); expect(all.kpis.find((k: any) => k.key === 'ref').value).toBe('1000.00'); expect(all.kpis.find((k: any) => k.key === 'net').value).toBe('7000.00');
    const m = await ok(call('GET', u(w, 'insights/payments?from=2026-11-05&to=2026-11-05&group=method'), O));
    expect(m.rows.find((x: any) => x.what === 'Cash')).toMatchObject({ received: '500000', refunded: '100000', net: '400000' }); expect(m.rows.find((x: any) => x.what === 'Card (slip)')).toMatchObject({ received: '300000', net: '300000' });
    const rf = await ok(call('GET', u(w, 'insights/payments?from=2026-11-05&to=2026-11-05&view=refunds'), O)); expect(rf.rows).toHaveLength(1);

    const adj = await ok(call('GET', u(w, 'insights/refunds-adjustments?from=2026-11-01&to=2026-11-30'), O));
    expect(adj.rows.find((x: any) => x.kind === 'Refund')).toMatchObject({ amount: '100000', reason: 'Overpaid' });

    at('2026-11-05', '23:30'); await ok(call('POST', u(w, 'night-audit/runs'), O, {}));
    const rev = await ok(call('GET', u(w, 'insights/revenue-summary?from=2026-11-05&to=2026-11-05'), O));
    expect(rev.rows.length).toBeGreaterThan(0); expect(rev.rows[0].what).toBe('Room'); expect(Number(rev.rows[0].net)).toBeGreaterThan(0);
    const day = await ok(call('GET', u(w, 'insights/revenue-summary?from=2026-11-05&to=2026-11-05&group=day'), O)); expect(day.rows[0].what).toBe('2026-11-05');
    const tx = await ok(call('GET', u(w, 'insights/taxes?from=2026-11-05&to=2026-11-05'), O)); expect(Array.isArray(tx.rows)).toBe(true);
    const ex = await ok(call('GET', u(w, 'insights/financial-exceptions?from=2026-11-01&to=2026-11-30'), O));
    expect(ex.rows.filter((x: any) => x.kind === 'Bill does not add up')).toHaveLength(0);
  });
});
