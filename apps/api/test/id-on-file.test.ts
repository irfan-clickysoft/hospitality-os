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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'idf'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@idf.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };


async function book(w: W, o: { arrival: string; departure: string; guestId?: string }) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival, departure: o.departure, adults: 2, channel: 'PHONE' })).json();
  const g = o.guestId ? { id: o.guestId } : await ok(call('POST', '/v1/guests', O, { fullName: 'Imran Returning', phone: '03007770101', nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string, guestId: g.id as string };
}
const checkIn = (w: W, b: { id: string; line: string }, room: string, occupants: unknown[]) => call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-in`), O, { roomId: w.room[room], occupants });
describe('ID on file for a returning guest', () => {
  it('is offered masked, used without typing it again, and not once it has expired or for another name', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const a = await book(w, { arrival: '2026-11-05', departure: '2026-11-06' });
    expect((await ok(call('GET', u(w, `guests/${a.guestId}/id-on-file`), O))).found).toBe(false);
    await ok(checkIn(w, a, '101', [{ fullName: 'Imran Returning', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671', nationality: 'PK' }]));
    at('2026-11-06', '10:00'); await setBd(w, '2026-11-06');
    await ok(call('POST', u(w, `reservations/${a.id}/rooms/${a.line}/check-out`), OM, { balanceReason: 'test: settled elsewhere' }));
    at('2026-11-07', '10:00'); await setBd(w, '2026-11-07');
    const b = await book(w, { arrival: '2026-11-07', departure: '2026-11-08', guestId: a.guestId });
    const f = await ok(call('GET', u(w, `guests/${a.guestId}/id-on-file`), O)); expect(f).toMatchObject({ found: true, fullName: 'Imran Returning', idType: 'CNIC', masked: '*****-*******-1' }); expect(JSON.stringify(f)).not.toContain('35202');
    await code(checkIn(w, b, '102', [{ fullName: 'Someone Else', isPrimary: true, useIdOnFile: true, nationality: 'PK' }]), 422, 'ID_ON_FILE_NAME');
    await code(checkIn(w, b, '102', [{ fullName: 'Imran Returning', isPrimary: false, ageGroup: 'ADULT', useIdOnFile: true }, { fullName: 'Imran Returning', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671', nationality: 'PK' }]), 422, 'ID_ON_FILE_MAIN_ONLY');
    await ok(checkIn(w, b, '102', [{ fullName: 'imran returning', isPrimary: true, useIdOnFile: true }]));
    const occ = await ok(call('GET', u(w, `reservations/${b.id}/rooms/${b.line}/guests?reveal=true`), OM)); expect(occ.items[0].idNumber).toBe('35202-1234567-1');           // the stored number was copied to the new stay
    await adminDb.updateTable('stay_guest').set({ id_expiry: '2026-11-06' } as never).where('property_id', '=', w.pid).execute();
    expect((await ok(call('GET', u(w, `guests/${a.guestId}/id-on-file`), O))).found).toBe(false);          // expired: not offered
    const c = await book(w, { arrival: '2026-11-07', departure: '2026-11-08', guestId: a.guestId });
    await code(checkIn(w, c, '103', [{ fullName: 'Imran Returning', isPrimary: true, useIdOnFile: true, nationality: 'PK' }]), 422, 'ID_ON_FILE_NOT_FOUND');
  });
});
