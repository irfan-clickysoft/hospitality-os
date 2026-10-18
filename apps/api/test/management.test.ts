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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'mgmt'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@mgmt.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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


describe('the management overview', () => {
  it('rolls the closed days up into occupancy, ADR, RevPAR and revenue per property and for the group; shows today live, what is coming and what is at risk; and sells by source and company', async () => {
    const a = await sunset(); const b = await sunset();
    at('2026-11-05', '10:00');
    const g1 = await book(a, { departure: '2026-11-07' }), g2 = await book(a, { departure: '2026-11-06' }), g3 = await book(a);
    await setBd(a, '2026-11-05'); await setBd(b, '2026-11-05');
    await checkIn(a, g1, '101'); await checkIn(a, g2, '102');
    at('2026-11-05', '23:40');
    await ok(audit(a));                                                                                    // g3 is charged as a no-show
    const ota = await ok(call('POST', u(a, 'reservations'), O, { guestId: (await ok(call('POST', '/v1/guests', O, { fullName: 'OTA Guest', phone: '03005550101', nationality: 'PK' }), 201)).id, source: 'OTA_BOOKING_COM', externalRef: 'BKG-1',
      lines: [{ quoteToken: (await call('POST', u(a, 'quotes'), O, { arrival: '2026-11-10', departure: '2026-11-11', adults: 1, channel: 'OTA' })).json().options[0].quoteToken }] }, key()), 201);
    expect(ota.guarantee.atRisk).toBe(true);

    const m = await ok(call('GET', '/v1/management/overview?from=2026-11-05&to=2026-11-05', O));
    expect(m).toMatchObject({ from: '2026-11-05', to: '2026-11-05', scope: 'ALL_PROPERTIES' });
    const pa = m.properties.find((p: any) => p.id === a.pid), pb = m.properties.find((p: any) => p.id === b.pid);
    expect(pa.period).toMatchObject({ occupancyPct: 50, roomsSold: 2, roomsAvailable: 4, roomRevenue: { amount: '24000.00' }, adr: { amount: '12000.00' }, revPar: { amount: '6000.00' }, fees: { amount: '12000.00' }, noShows: 1, tax: { amount: '0.00' } });
    expect(pa.trend).toEqual([{ date: '2026-11-05', occupancyPct: 50, roomRevenue: { amount: '24000.00', currency: 'PKR' } }]);
    expect(pb.period).toMatchObject({ roomsSold: 0, roomsAvailable: 0, roomRevenue: { amount: '0.00' }, adr: { amount: '0.00' } });   // property B has no closed days: zeros, not errors
    expect(m.totals).toMatchObject({ occupancyPct: 50, roomRevenue: { amount: '24000.00' }, adr: { amount: '12000.00' }, inHouse: 2 });
    expect(pa.today).toMatchObject({ inHouse: 2, rooms: 4, outOfOrder: 0, occupancyPct: 50 });
    expect(pa.businessDate).toBe('2026-11-06');
    expect(pa.upcoming).toMatchObject({ reservations: 1, atRisk: 1 });
    expect(pa.revenueProtection).toMatchObject({ otaConfirmed: 1, otaGuaranteed: 0, otaAtRisk: 1, feesNet: { amount: '12000.00' } });
    expect(m.salesBySource.find((x: any) => x.source === 'PHONE')).toBeTruthy();
    expect(m.receivables).toMatchObject({ totalOpen: { amount: '0.00' } });
    expect(m.approvals).toMatchObject({ taxRatesAwaitingApproval: 0, companyReceiptsToVerify: 0 });
  });

  it('shows each person only the properties they may manage; front-desk and read-only staff see nothing', async () => {
    const a = await sunset(); const b = await sunset();
    const gm = await addUser(T.tenantId, `gm${++n}@mgmt.test`); await assignRole(T.tenantId, gm, 'general_manager', 'PROPERTY', b.pid);
    const only = await ok(call('GET', '/v1/management/overview', as(T.tenantId, gm)));
    expect(only.scope).toBe('SOME_PROPERTIES'); expect(only.properties.map((p: any) => p.id)).toEqual([b.pid]);
    expect(only.receivables).toBeNull(); expect(only.approvals.companyReceiptsToVerify).toBe(0);
    void a;
    for (const role of ['front_desk_agent', 'read_only', 'cashier']) {
      const x = await addUser(T.tenantId, `${role}${++n}@mgmt.test`); await assignRole(T.tenantId, x, role, 'TENANT', null);
      await code(call('GET', '/v1/management/overview', as(T.tenantId, x)), 403, 'PERMISSION_DENIED');
    }
    await code(call('GET', '/v1/management/overview?from=2026-11-09&to=2026-11-01', O), 400, 'VALIDATION_FAILED');
  });
});
