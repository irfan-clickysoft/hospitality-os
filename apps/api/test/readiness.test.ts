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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'ready'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@ready.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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


const R = '/v1/readiness';
const find = (r: any, code: string, pid?: string) => r.items.find((x: any) => x.code === code && (pid === undefined || x.propertyId === pid));

describe('readiness: what is still missing', () => {
  it('a new property needs rates, tax and a payment account; each item turns green once it is set up; nothing changes data', async () => {
    const w = await sunset();
    const r0 = await ok(call('GET', R, O));
    expect(find(r0, 'RATES', w.pid)).toMatchObject({ status: 'OK' });                                      // the helper sets a BAR plan with a price for the one room type
    expect(find(r0, 'TAX_JURISDICTION', w.pid)).toMatchObject({ status: 'ACTION' });                       // no tax setup: charges would go untaxed
    expect(find(r0, 'PAYMENT_ACCOUNTS', w.pid)).toMatchObject({ status: 'ACTION' });
    expect(find(r0, 'ENTITY_NTN')).toMatchObject({ status: 'ACTION' });
    expect(find(r0, 'EXTRAS', w.pid)).toMatchObject({ status: 'OK' });                                     // the helper's extras are not zero
    expect(r0.summary.action).toBeGreaterThanOrEqual(3);
    expect(r0.items[0].status).toBe('ACTION');                                                             // what needs doing comes first
    // tax: a jurisdiction on the property and an active rate for it
    await adminDb.updateTable('property').set({ tax_jurisdiction: `RDY${++n}` }).where('id', '=', w.pid).execute();
    const jur = (await adminDb.selectFrom('property').select('tax_jurisdiction').where('id', '=', w.pid).executeTakeFirstOrThrow()).tax_jurisdiction!;
    expect(find(await ok(call('GET', R, O)), 'TAX_RATES', w.pid)).toMatchObject({ status: 'ACTION' });     // named, but no approved rate yet
    const acc = await addUser(T.tenantId, `acc${++n}@ready.test`); await assignRole(T.tenantId, acc, 'accountant', 'TENANT', null);
    const c = await ok(call('POST', '/v1/tax/codes', as(T.tenantId, acc, { mfa: true }), { code: `RDY-${n}`, name: 'Test', jurisdiction: jur, version: { rateBp: 500, appliesTo: ['ROOM'], effectiveFrom: '2026-01-01' } }), 201);
    await ok(call('POST', `/v1/tax/versions/${c.version.id}/approve`, OM, { advisorRef: 'T-1', legalBasis: 'Test fixture, not law' }));
    expect(find(await ok(call('GET', R, O)), 'TAX_RATES', w.pid)).toMatchObject({ status: 'OK' });
    // a payment account turns that item green; business registration numbers turn the entity items green
    await ok(call('POST', '/v1/payment-accounts', OM, { kind: 'BANK', name: `Operating ${++n}`, ownerType: 'COMPANY', propertyId: w.pid }), 201);
    expect(find(await ok(call('GET', R, O)), 'PAYMENT_ACCOUNTS', w.pid)).toMatchObject({ status: 'OK' });
    await adminDb.updateTable('legal_entity').set({ ntn: '1234567-8', strn: '1234567890123' }).where('tenant_id', '=', T.tenantId).execute();
    const r1 = await ok(call('GET', R, O));
    expect(find(r1, 'ENTITY_NTN')).toMatchObject({ status: 'OK' }); expect(find(r1, 'ENTITY_STRN')).toMatchObject({ status: 'OK' });
    // an unpriced room type is an action
    await ok(call('POST', u(w, 'room-types'), O, { code: 'NEW', name: 'New type', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, baseOccupancy: 2 }), 201);
    expect(find(await ok(call('GET', R, O)), 'RATES', w.pid)).toMatchObject({ status: 'ACTION', count: 1 });
  });

  it('only people with the management view see it; a property manager sees only theirs and not the business-wide items', async () => {
    const w1 = await sunset(); const w2 = await sunset();
    const desk = await staff(w1, 'front_desk_agent'); const admin = await staff(w1, 'property_admin');
    await code(call('GET', R, desk.h), 403, 'PERMISSION_DENIED');
    const r = await ok(call('GET', R, admin.h));
    expect(r.items.every((x: any) => x.propertyId === w1.pid)).toBe(true);
    expect(r.items.some((x: any) => x.propertyId === w2.pid)).toBe(false);
    expect(find(r, 'ENTITY_NTN')).toBeUndefined();
    const all = await ok(call('GET', R, O));
    expect(all.items.some((x: any) => x.propertyId === w2.pid)).toBe(true);
  });
});
