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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'comm'); O = as(T.tenantId, T.ownerUserId); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

async function sunset() {
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `CM${++n}`, name: `Comm ${n}` })).json().id as string;
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'STD', name: 'Standard', maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id as string;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, from: 101, to: 104 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'BAR', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '12000', extraAdult: '3000', extraChild: '1500' }] });
  return { pid };
}
const book = async (pid: string, source: string, arrival: string, departure: string) => {
  const q = (await call('POST', `/v1/properties/${pid}/quotes`, O, { arrival, departure, adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(9300000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  await ok(call('POST', `/v1/properties/${pid}/reservations`, O, { guestId: g.id, source, lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
};

describe('commission and net revenue', () => {
  it('rates are saved by a manager, and the report takes the commission off each source', async () => {
    const { pid } = await sunset(); at('2026-11-01', '10:00');
    await book(pid, 'PHONE', '2026-11-03', '2026-11-05'); await book(pid, 'OTA_BOOKING_COM', '2026-11-10', '2026-11-12');
    const fd = as(T.tenantId, await addUser(T.tenantId, `fd${++n}@comm.test`)); await assignRole(T.tenantId, (await adminDb.selectFrom('staff_user').select('id').where('email', '=', `fd${n}@comm.test`).executeTakeFirstOrThrow()).id, 'front_desk_agent', 'PROPERTY', pid);
    await code(call('PUT', `/v1/properties/${pid}/commissions/OTA_BOOKING_COM`, fd, { pct: 15 }), 403, 'PERMISSION_DENIED');
    await code(call('PUT', `/v1/properties/${pid}/commissions/NOPE`, O, { pct: 15 }), 400, 'VALIDATION_FAILED');
    await code(call('PUT', `/v1/properties/${pid}/commissions/OTA_BOOKING_COM`, O, { pct: 120 }), 400, 'VALIDATION_FAILED');
    const q = '?from=2026-11-01&to=2026-11-30';
    const before = await ok(call('GET', `/v1/properties/${pid}/insights/commission-net${q}`, O)); expect(before.warnings.join(' ')).toContain('Booking.com'); expect(before.kpis.find((k: any) => k.key === 'com').value).toBe('0.00');
    await ok(call('PUT', `/v1/properties/${pid}/commissions/OTA_BOOKING_COM`, O, { pct: 15 }));
    const list = await ok(call('GET', `/v1/properties/${pid}/commissions`, O)); expect(list.items.find((x: any) => x.source === 'OTA_BOOKING_COM')).toMatchObject({ pct: 15, set: true });
    const r = await ok(call('GET', `/v1/properties/${pid}/insights/commission-net${q}`, O));
    const ota = r.rows.find((x: any) => x.what === 'Booking.com'); const ph = r.rows.find((x: any) => x.what === 'Phone');
    expect(BigInt(ota.rev)).toBeGreaterThan(0n); expect(BigInt(ota.com)).toBe((BigInt(ota.rev) * 15n + 50n) / 100n); expect(BigInt(ota.net)).toBe(BigInt(ota.rev) - BigInt(ota.com)); expect(ph.com).toBe('0');
    expect(r.kpis.find((k: any) => k.key === 'net').value).not.toBe(r.kpis.find((k: any) => k.key === 'rev').value);
    const m = await ok(call('GET', `/v1/properties/${pid}/insights/commission-net${q}&group=month`, O)); expect(m.rows).toHaveLength(1);
  });
});
