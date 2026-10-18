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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'ota'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@ota.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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


async function otaNoShow(w: W, extRef = `BKG-${++n}`) {
  at('2026-11-05', '10:00');
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: '2026-11-05', departure: '2026-11-06', adults: 2, channel: 'OTA' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `OTA Guest ${++n}`, phone: `0300${String(5000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'OTA_BOOKING_COM', externalRef: extRef, lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
  await setBd(w, '2026-11-05');
  await ok(call('POST', u(w, `reservations/${r.id}/no-show`), O, {}));                                 // the no-show fee: one night, 12,000
  return r.id as string;
}
const claim = (w: W, id: string, body: Record<string, unknown> = { kind: 'NO_SHOW' }, h: Record<string, string> = O) => call('POST', u(w, `reservations/${id}/ota-claim`), h, body, key());
const bal = async (w: W, id: string) => (await ok(call('GET', u(w, `reservations/${id}/folio`), O))).folio.balance.amount as string;

describe('OTA receivables', () => {
  it('moves a fee the OTA owes off the guest’s bill; chased, partly paid, disputed, resolved and received, with every step on record and the ageing following it', async () => {
    const w = await sunset(); const id = await otaNoShow(w);
    expect(await bal(w, id)).toBe('12000.00');
    const k = key();
    const first = await ok(call('POST', u(w, `reservations/${id}/ota-claim`), O, { kind: 'NO_SHOW' }, k), 201);
    expect(first.claim).toMatchObject({ status: 'CLAIMABLE', kind: 'NO_SHOW', amount: { amount: '12000.00' }, remaining: { amount: '12000.00' }, source: 'OTA_BOOKING_COM', otaRef: expect.stringMatching(/^BKG-/), incurredOn: '2026-11-05' });
    expect(first.balance.amount).toBe('0.00'); expect(await bal(w, id)).toBe('0.00');
    expect((await ok(call('POST', u(w, `reservations/${id}/ota-claim`), O, { kind: 'NO_SHOW' }, k), 200)).replayed).toBe(true);
    await code(claim(w, id), 422, 'NOTHING_TO_CLAIM');
    const rid = first.claim.id as string;
    const R = (tail: string, body: unknown, h = O) => call('POST', u(w, `ota-receivables/${rid}/${tail}`), h, body);
    await code(R('receive', { amount: '1000', reference: 'BDC-1' }), 409, 'WRONG_STATE');           // not sent to the OTA yet
    expect(await ok(R('claimed', { claimRef: 'EXTRANET-77' }))).toMatchObject({ status: 'CLAIMED', claimRef: 'EXTRANET-77', claimedOn: '2026-11-05' });
    await code(R('claimed', {}), 409, 'WRONG_STATE');
    expect(await ok(R('receive', { amount: '5000', reference: 'BDC-PAY-1' }))).toMatchObject({ status: 'CLAIMED', received: { amount: '5000.00' }, remaining: { amount: '7000.00' } });
    await code(R('receive', { amount: '9000', reference: 'BDC-PAY-2' }), 422, 'AMOUNT_TOO_LARGE');
    await ok(R('dispute', { reason: 'OTA says the guest cancelled in time' }));
    await code(R('dispute', { reason: 'again please' }), 409, 'WRONG_STATE');
    await ok(R('resolve', { note: 'OTA accepted our proof' }));
    expect(await ok(R('receive', { amount: '7000', reference: 'BDC-PAY-3' }))).toMatchObject({ status: 'RECEIVED', remaining: { amount: '0.00' }, received: { amount: '12000.00' } });
    const h = await ok(call('GET', u(w, `ota-receivables/${rid}`), O));
    expect(h.events.map((e: any) => e.action)).toEqual(['CREATE', 'CLAIM', 'RECEIVE', 'DISPUTE', 'RESOLVE', 'RECEIVE']);
    const list = await ok(call('GET', u(w, 'ota-receivables?status=OPEN'), O)); expect(list.items).toHaveLength(0); expect(list.openTotal.amount).toBe('0.00');
  });

  it('ageing counts what is still owed by how long ago it was moved off the guest’s bill; a write-off needs a manager, a reason and the second factor, and takes the rest off', async () => {
    const w = await sunset(); const id = await otaNoShow(w);
    const rid = (await ok(claim(w, id), 201)).claim.id as string;
    const R = (tail: string, body: unknown, h = O) => call('POST', u(w, `ota-receivables/${rid}/${tail}`), h, body);
    await ok(R('claimed', {})); await ok(R('receive', { amount: '2000', reference: 'BDC-A' }));
    await setBd(w, '2026-12-20');                                                                       // 45 days later
    expect((await ok(call('GET', u(w, 'ota-receivables/ageing'), O)))).toMatchObject({ asOf: '2026-12-20', buckets: { d0_30: { amount: '0.00' }, d31_60: { amount: '10000.00' } }, total: { amount: '10000.00' } });
    await code(R('write-off', { reason: 'OTA refuses to pay' }), 403, 'MFA_REQUIRED');
    const clerk = await staff(w, 'front_desk_agent');
    await code(R('write-off', { reason: 'OTA refuses to pay' }, clerk.hm), 403, 'PERMISSION_DENIED');
    await code(R('write-off', { amount: '99999', reason: 'too much' }, OM), 422, 'AMOUNT_INVALID');
    expect(await ok(R('write-off', { reason: 'OTA refuses to pay' }, OM))).toMatchObject({ status: 'WRITTEN_OFF', writtenOff: { amount: '10000.00' }, received: { amount: '2000.00' }, remaining: { amount: '0.00' } });
    expect((await ok(call('GET', u(w, 'ota-receivables/ageing'), O))).total.amount).toBe('0.00');
    await code(R('receive', { amount: '1', reference: 'X-123' }), 409, 'WRONG_STATE');
    const mg = await ok(call('GET', '/v1/management/overview?from=2026-11-01&to=2026-12-31', O));
    expect(mg.properties.find((p: any) => p.id === w.pid).revenueProtection).toMatchObject({ otaReceivable: { amount: '0.00' }, otaWrittenOff: { amount: '10000.00' } });
  });

  it('can be taken back before it is sent to the OTA (the amount returns to the guest’s bill); only OTA bookings can be claimed; who may do what', async () => {
    const w = await sunset(); const id = await otaNoShow(w);
    const clerk = await staff(w, 'front_desk_agent');
    await code(claim(w, id, { kind: 'NO_SHOW' }, clerk.h), 403, 'PERMISSION_DENIED');
    const c = (await ok(claim(w, id, { kind: 'LATE_CANCELLATION', amount: '4000', note: 'Part only' }), 201)).claim;
    expect(await bal(w, id)).toBe('8000.00');
    await code(call('POST', u(w, `ota-receivables/${c.id}/void`), O, { reason: 'Wrong booking' }), 403, 'MFA_REQUIRED');
    expect(await ok(call('POST', u(w, `ota-receivables/${c.id}/void`), OM, { reason: 'Wrong booking' }))).toMatchObject({ status: 'VOID', remaining: { amount: '0.00' } });
    expect(await bal(w, id)).toBe('12000.00');
    expect((await ok(call('GET', u(w, 'folio-check'), O))).ok).toBe(true);
    // claimed claims cannot be taken back
    const c2 = (await ok(claim(w, id), 201)).claim; await ok(call('POST', u(w, `ota-receivables/${c2.id}/claimed`), O, {}));
    await code(call('POST', u(w, `ota-receivables/${c2.id}/void`), OM, { reason: 'too late' }), 409, 'WRONG_STATE');
    // a phone booking is not an OTA booking
    at('2026-11-05', '11:00');
    const q = (await call('POST', u(w, 'quotes'), O, { arrival: '2026-11-05', departure: '2026-11-06', adults: 1, channel: 'PHONE' })).json();
    const g = await ok(call('POST', '/v1/guests', O, { fullName: `Phone ${++n}`, phone: `0300${String(4000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
    const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
    await code(claim(w, r.id), 422, 'NOT_AN_OTA_BOOKING');
  });
});
