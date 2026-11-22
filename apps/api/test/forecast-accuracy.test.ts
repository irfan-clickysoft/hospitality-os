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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'fca'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@fca.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

async function book(w: W, o: { arrival?: string; departure?: string; hold?: number } = {}) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival ?? '2026-11-05', departure: o.departure ?? '2026-11-07', adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(6000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }], ...(o.hold ? { hold: { minutes: o.hold } } : {}) }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string };
}
const checkIn = (w: W, b: { id: string; line: string }, room: string) => ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-in`), O, { roomId: w.room[room], occupants: [{ fullName: 'Guest', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671' }] }));
const checkOut = (w: W, b: { id: string; line: string }) => ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-out`), OM, { balanceReason: 'test: settled elsewhere' }));
const audit = (w: W, body: Record<string, unknown> = {}, h = O) => call('POST', u(w, 'night-audit/runs'), h, body);
const folioOf = (w: W, b: { id: string }) => ok(call('GET', u(w, `reservations/${b.id}/folio`), O));


const csv = async (url: string, h = O, status = 200) => { const r = await call('GET', url, h); expect(r.statusCode, r.body).toBe(status); return r; };
const lines = (body: string) => body.replace(/^﻿/, '').trim().split('\r\n');

describe('forecast accuracy', () => {
  it('saves the forecast when the books are saved, and scores it once the stay date has passed', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const rt = (await adminDb.selectFrom('room_type').select('id').where('property_id', '=', w.pid).executeTakeFirstOrThrow()).id;
    const owner = (await adminDb.selectFrom('staff_user').select('id').where('tenant_id', '=', T.tenantId).executeTakeFirstOrThrow()).id;
    const runId = (await adminDb.insertInto('night_audit_run').values({ tenant_id: T.tenantId, property_id: w.pid, business_date: '2026-10-19', status: 'COMPLETED', started_by: owner } as never).returning('id').executeTakeFirstOrThrow()).id;
    const stats = (d: string, sold: number) => adminDb.insertInto('daily_property_stats').values({ tenant_id: T.tenantId, property_id: w.pid, business_date: d, run_id: runId, currency: 'PKR', rooms_total: 4, rooms_out_of_order: 0, rooms_available: 4, rooms_sold: sold, occupancy_bp: 10000, room_revenue_minor: '4800000', fees_minor: '0', other_revenue_minor: '0', adr_minor: '1200000', revpar_minor: '1200000', arrivals: 0, departures: 0, in_house: 0, no_shows: 0, cancellations: 0, guest_ledger_minor: '0', advance_deposits_minor: '0', payments: '{}', cashier_variance_minor: '0', details: '{}' } as never).execute();
    for (let n = 0; n < 12; n++) {                                            // twelve past dates: 2 nights on the books a week before, 4 finally sold
      const d = new Date(Date.UTC(2026, 9, 20 + n)).toISOString().slice(0, 10); const sd = new Date(Date.parse(`${d}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
      await adminDb.insertInto('booking_snapshot').values({ tenant_id: T.tenantId, property_id: w.pid, snapshot_date: sd, stay_date: d, room_type_id: rt, channel: 'PHONE', rooms: 2, revenue_minor: '2400000' } as never).execute();
      await stats(d, 4);
    }
    await book(w, { arrival: '2026-11-12', departure: '2026-11-13' });
    const empty = await ok(call('GET', u(w, 'insights/forecast-accuracy?from=2026-11-01&to=2026-11-30'), O)); expect(empty.warnings[0]).toContain('No forecasts to score');
    await ok(call('POST', u(w, 'insights/snapshots'), O));
    const saved = await adminDb.selectFrom('forecast_saved').selectAll().where('property_id', '=', w.pid).where('stay_date', '=', '2026-11-12').execute();
    expect(saved).toHaveLength(1); expect(saved[0]).toMatchObject({ lead: 7, on_books: 1, forecast_nights: 3, sellable: 4, samples: 12 });
    await ok(call('POST', u(w, 'insights/snapshots'), O)); expect(await adminDb.selectFrom('forecast_saved').select('stay_date').where('property_id', '=', w.pid).where('stay_date', '=', '2026-11-12').execute()).toHaveLength(1);   // saving again replaces
    await setBd(w, '2026-11-20'); at('2026-11-20', '10:00');
    const pending = await ok(call('GET', u(w, 'insights/forecast-accuracy?from=2026-11-12&to=2026-11-12'), O)); expect(pending.rows).toHaveLength(0);     // no actual yet
    await stats('2026-11-12', 4);
    const r = await ok(call('GET', u(w, 'insights/forecast-accuracy?from=2026-11-12&to=2026-11-12&lead=7'), O));
    expect(r.rows).toEqual([{ d: '2026-11-12', ob: 1, fc: 3, actual: 4, err: -1, obErr: -3 }]);
    expect(r.kpis.find((k: any) => k.key === 'acc').value).toBe(75); expect(r.kpis.find((k: any) => k.key === 'ob').value).toBe(25); expect(r.kpis.find((k: any) => k.key === 'bias').value).toBe(-25);
    const by = await ok(call('GET', u(w, 'insights/forecast-accuracy?from=2026-11-12&to=2026-11-12&group=lead'), O)); expect(by.rows[0]).toMatchObject({ what: '7 days before', n: 1, acc: 75 });
  });
});
