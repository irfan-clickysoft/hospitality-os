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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'otafin'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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

const F = (t: string) => `/v1/finance/${t}`;
const net = async (code: string) => { const r = (await ok(call('GET', F('reports/trial-balance?from=2026-11-01&to=2026-12-31'), O))).rows.find((x: any) => x.code === code); return r ? { dr: r.closingDr, cr: r.closingCr } : { dr: '0.00', cr: '0.00' }; };
describe('OTA receivables in the ledger', () => {
  it('a no-show fee moved to the OTA is a receivable; money received from the OTA clears it', async () => {
    const OM = as(T.tenantId, T.ownerUserId, { mfa: true });
    await ok(call('POST', F('accounts/starter'), OM)); await ok(call('POST', F('pms/enable'), OM, { from: '2026-11-01' }));
    const w = await sunset(); const id = await otaNoShow(w);
    expect(await net('4090')).toEqual({ dr: '0.00', cr: '12000.00' }); expect(await net('1250')).toEqual({ dr: '12000.00', cr: '0.00' });
    const first = await ok(call('POST', u(w, `reservations/${id}/ota-claim`), O, { kind: 'NO_SHOW' }, key()), 201);
    expect(await net('1250')).toEqual({ dr: '0.00', cr: '0.00' }); expect(await net('1210')).toEqual({ dr: '12000.00', cr: '0.00' });
    const R = (tail: string, body: unknown) => call('POST', u(w, `ota-receivables/${first.claim.id}/${tail}`), O, body);
    await ok(R('claimed', { claimRef: 'EXTRANET-1' })); await ok(R('receive', { amount: '5000', reference: 'BDC-PAY-1' }));
    expect(await net('1210')).toEqual({ dr: '7000.00', cr: '0.00' }); expect(await net('1800')).toEqual({ dr: '5000.00', cr: '0.00' });   // a bank transfer to an account not yet mapped waits in the suspense account
  });
});
