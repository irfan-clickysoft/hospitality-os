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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'hov'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@hov.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };


describe('handover, workload and SLA', () => {
  it('a handover is written, read by someone else and ticked off; the reports count them', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const a = await staff(w, 'front_desk_agent'); const b = await staff(w, 'front_desk_agent');
    await code(call('POST', u(w, 'handovers'), a.h, { shift: 'MORNING', notes: 'x' }), 400, 'VALIDATION_FAILED');
    const h = await ok(call('POST', u(w, 'handovers'), a.h, { shift: 'MORNING', notes: 'Room 101 waiting for a plumber. VIP arrives at 18:00.', items: ['Call the plumber back', 'Prepare the VIP welcome'] }), 201);
    const l1 = await ok(call('GET', u(w, 'handovers'), b.h)); expect(l1.items).toHaveLength(1); expect(l1.items[0]).toMatchObject({ shift: 'MORNING', openItems: 2, acknowledgedBy: null, mine: false });
    await code(call('POST', u(w, `handovers/${h.id}/acknowledge`), a.h, {}), 422, 'OWN_HANDOVER');
    await ok(call('POST', u(w, `handovers/${h.id}/acknowledge`), b.h, {}));
    expect((await ok(call('POST', u(w, `handovers/${h.id}/acknowledge`), b.h, {}))).alreadyRead).toBe(true);
    await ok(call('PUT', u(w, `handovers/${h.id}/items/0`), b.h, { done: true })); await code(call('PUT', u(w, `handovers/${h.id}/items/9`), b.h, { done: true }), 404, 'NOT_FOUND');
    const l2 = await ok(call('GET', u(w, 'handovers'), a.h)); expect(l2.items[0]).toMatchObject({ openItems: 1, mine: true }); expect(l2.items[0].acknowledgedBy).toBeTruthy(); expect(l2.items[0].items[0]).toMatchObject({ done: true });
    const hr = await ok(call('GET', u(w, 'insights/shift-handover?from=2026-11-01&to=2026-11-30'), O)); expect(hr.rows).toHaveLength(1); expect(hr.rows[0]).toMatchObject({ shift: 'Morning', open: 1, items: 2 }); expect(hr.rows[0].reader).toBeTruthy(); expect(hr.kpis.find((k: any) => k.key === 'un').value).toBe(0);
    const un = await ok(call('GET', u(w, 'insights/shift-handover?from=2026-11-01&to=2026-11-30&view=unread'), O)); expect(un.rows).toEqual([]);
    await ok(call('POST', u(w, 'cases'), O, { type: 'GUEST_COMPLAINT', severity: 'LOW', description: 'Slow service at breakfast' }), 201);
    await ok(call('POST', u(w, 'work-orders'), O, { title: 'Tap leaks', category: 'PLUMBING', priority: 2, roomId: w.room['103'], dueDate: '2026-11-03' }), 201);
    const sl = await ok(call('GET', u(w, 'insights/sla-performance?from=2026-11-01&to=2027-06-30'), O)); expect(sl.rows.find((x: any) => x.kind === 'Maintenance jobs')).toMatchObject({ grp: 'High', n: 1, overdue: 1 }); expect(sl.rows.find((x: any) => x.kind === 'Complaints and incidents').n).toBe(1);
    const q = (await call('POST', u(w, 'quotes'), O, { arrival: '2026-11-10', departure: '2026-11-11', adults: 2, channel: 'PHONE' })).json(); const g = await ok(call('POST', '/v1/guests', O, { fullName: 'Workload Guest', phone: '03005550101', nationality: 'PK' }), 201);
    await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
    const wl = await ok(call('GET', u(w, 'insights/front-desk-workload?from=2026-11-01&to=2027-06-30'), O)); expect(wl.rows.find((x: any) => x.what === 'hov owner')).toMatchObject({ reservation_create: 1 }); expect(wl.columns.map((c: any) => c.label)).toContain('Check-ins');
  });
});
