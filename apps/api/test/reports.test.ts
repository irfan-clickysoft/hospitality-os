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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'rep'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@rep.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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

describe('report downloads', () => {
  it('give the accountant the day’s figures as spreadsheets: right headers, plain decimals, safe cells, attachment headers', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' });
    await adminDb.updateTable('guest').set({ full_name: '=HYPERLINK("http://evil.example","click")' }).where('id', 'in', adminDb.selectFrom('reservation').select('guest_id').where('id', '=', b.id)).execute();
    await checkIn(w, b, '101');
    const sess = await ok(call('POST', u(w, 'cashier/sessions'), O, { openingFloat: '0' }), 201);
    await ok(call('POST', u(w, `reservations/${b.id}/payments`), O, { method: 'CASH', amount: '5000' }, key()), 201);
    const wallet = await ok(call('POST', '/v1/payment-accounts', OM, { kind: 'WALLET', name: 'Easypaisa' }), 201);
    await ok(call('POST', u(w, `reservations/${b.id}/payments`), O, { method: 'WALLET', amount: '1500', reference: 'EP-1', paymentAccountId: wallet.id }, key()), 201);
    await ok(call('POST', u(w, `cashier/sessions/${sess.id}/close`), O, { counted: '5000' }));
    at('2026-11-05', '23:30'); await ok(audit(w));

    const daily = await csv(u(w, 'reports/daily-summary?from=2026-11-01&to=2026-11-30'));
    expect(daily.headers['content-type']).toContain('text/csv'); expect(daily.headers['content-disposition']).toMatch(/^attachment; filename="[A-Za-z0-9._-]+daily-summary-2026-11-01_2026-11-30\.csv"$/); expect(daily.headers['cache-control']).toBe('no-store');
    const d = lines(daily.body); expect(d[0]).toContain('Room revenue'); expect(d[1]).toMatch(/^2026-11-05,4,1,25,12000\.00,/);
    const rev = lines((await csv(u(w, 'reports/revenue-by-code?from=2026-11-01&to=2026-11-30'))).body); expect(rev[1]).toMatch(/^2026-11-05,ROOM,.*,12000\.00$/);
    const pay = lines((await csv(u(w, 'reports/payments?from=2026-11-01&to=2026-11-30'))).body);
    expect(pay).toHaveLength(3); expect(pay.join('\n')).toContain('WALLET,CAPTURED,1500.00,EP-1,,Easypaisa,COMPANY');
    const folios = (await csv(u(w, 'reports/open-folios'))).body; expect(folios).toContain("'=HYPERLINK(");           // the guest's name cannot run as a formula
    expect(folios).not.toMatch(/(^|,)=HYPERLINK/m);
    const inh = lines((await csv(u(w, 'reports/in-house'))).body); expect(inh[0]).toBe('Room,Guest,Booking,Arrival,Departure,Nationality,Company,Bill balance'); expect(inh[1]).toMatch(/^101,/);
    expect(lines((await csv(u(w, 'reports/invoices?from=2026-11-01&to=2026-11-30'))).body)).toHaveLength(1);                      // headers only: nothing invoiced yet
    expect(lines((await csv(u(w, 'reports/tax-liability?from=2026-11-01&to=2026-11-30'))).body)[0]).toBe('Tax,Name,Rate %,Postings,Taxable amount,Tax');
    const pa = lines((await csv('/v1/reports/payment-accounts?from=2026-11-01&to=2026-11-30', OM)).body);
    expect(pa.join('\n')).toContain('Easypaisa,WALLET,,,Company,,1,1500.00,0.00,1500.00');
    const ar = lines((await csv('/v1/reports/ar-aging', O)).body); expect(ar[0]).toContain('Company,Not yet due');
  });

  it('need the permission; the period is limited; unknown reports are not found', async () => {
    const w = await sunset();
    const cashier = await staff(w, 'cashier'); const readonly = await staff(w, 'read_only');
    await code(call('GET', u(w, 'reports/payments'), cashier.h), 403, 'PERMISSION_DENIED');                         // a cashier does not hold report.view
    expect((await call('GET', u(w, 'reports/in-house'), readonly.h)).statusCode).toBe(200);
    await code(call('GET', '/v1/reports/payment-accounts', readonly.h), 403, 'PERMISSION_DENIED');
    await code(call('GET', '/v1/reports/ar-aging', readonly.h), 403, 'PERMISSION_DENIED');
    await code(call('GET', u(w, 'reports/payments?from=2024-01-01&to=2026-11-30'), O), 400, 'RANGE_TOO_LONG');
    await code(call('GET', u(w, 'reports/payments?from=2026-11-30&to=2026-11-01'), O), 400, 'VALIDATION_FAILED');
    await code(call('GET', u(w, 'reports/nonesuch'), O), 404, 'NOT_FOUND');
    await code(call('GET', '/v1/reports/nonesuch', O), 404, 'NOT_FOUND');
    const other = await provision(app, 'rep-other');
    await code(call('GET', u(w, 'reports/payments'), as(other.tenantId, other.ownerUserId)), 404, 'NOT_FOUND');          // another business's property does not exist here
  });
});
