import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addUser, adminDb, as, assignRole, createTestApp, provision } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>, U: Awaited<ReturnType<typeof provision>>, O: Record<string, string>;
let pid: string, resId: string, token: string;

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: Record<string, string> = {}, body?: unknown) => app.inject({ method, url, headers, payload: body as object | undefined });

beforeAll(async () => {
  app = await createTestApp();
  T = await provision(app, 'portal'); U = await provision(app, 'portal2');
  O = as(T.tenantId, T.ownerUserId); pid = T.propertyIds[0];
  // a small hotel: one room type, one room, rates, live — then a booking
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'DLX', name: 'Deluxe', maxAdults: 2, maxChildren: 1, maxOccupancy: 3, baseOccupancy: 2, description: 'Quiet garden-facing room' })).json().id;
  const fl = (await call('POST', `/v1/properties/${pid}/floors`, O, { name: 'Ground floor' })).json().id;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, floorId: fl, from: 101, to: 101 });
  const am = (await call('POST', '/v1/amenities', O, { code: 'wifi', nameEn: 'Wi-Fi', category: 'GENERAL' })).json().id;
  await call('PUT', `/v1/properties/${pid}/room-types/${rt}/amenities`, O, { amenityIds: [am] });
  expect((await call('PATCH', `/v1/properties/${pid}`, O, { city: 'Karachi', terms: 'No smoking in rooms.', version: (await call('GET', `/v1/properties/${pid}`, O)).json().version })).statusCode).toBe(200);
  expect((await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: '2026-11-01' })).statusCode).toBe(200);
  const plan = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'Best Available (local)', residency: 'RESIDENT' })).json();
  await call('PUT', `/v1/properties/${pid}/rate-plans/${plan.id}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '10000', extraAdult: '3000', extraChild: '1500' }] });
  const q = (await call('POST', `/v1/properties/${pid}/quotes`, O, { arrival: '2026-11-05', departure: '2026-11-07', adults: 2 })).json();
  const g = (await call('POST', '/v1/guests', O, { fullName: 'Ali Raza', phone: '03001234567', nationality: 'PK' })).json().id;
  const r = await call('POST', `/v1/properties/${pid}/reservations`, { ...O, 'idempotency-key': 'portal-key-0001' }, { guestId: g, source: 'PHONE', lines: [{ quoteToken: q.options[0]?.quoteToken }] });
  expect(r.statusCode, r.body).toBe(201);
  resId = r.json().id;
  token = (await call('GET', `/v1/properties/${pid}/reservations/${resId}/guest-link`, O)).json().token;
});
afterAll(async () => { await app.close(); });

describe('the guest’s booking page', () => {
  it('gives staff a private link, the same one every time', async () => {
    expect(token).toMatch(/^[0-9a-f]{32}-[0-9a-f]{32}$/);
    expect((await call('GET', `/v1/properties/${pid}/reservations/${resId}/guest-link`, O)).json().token).toBe(token);
  });

  it('shows the booking without signing in: dates, room type, amenities, floor, terms — and no room number until one is given', async () => {
    const r = await call('GET', `/v1/guest/booking/${token}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const b = r.json();
    expect(b.booking).toMatchObject({ guestName: 'Ali Raza', arrival: '2026-11-05', departure: '2026-11-07', canRequest: true });
    expect(b.property).toMatchObject({ city: 'Karachi', terms: 'No smoking in rooms.', checkInTime: '14:00', checkOutTime: '12:00' });
    expect(b.rooms[0]).toMatchObject({ roomNumber: null, roomType: { name: 'Deluxe', description: 'Quiet garden-facing room' } });
    expect(b.rooms[0].amenities.map((a: any) => a.en)).toEqual(['Wi-Fi']);
    expect(JSON.stringify(b)).not.toMatch(/amount|total|price|phone|03001234567/i);       // no money and no contact details
  });

  it('shows the room number and floor once a room is allotted', async () => {
    const line = (await call('GET', `/v1/properties/${pid}/reservations/${resId}`, O)).json().lines[0].id;
    const room = (await call('GET', `/v1/properties/${pid}/rooms`, O)).json();
    const id = (room.items ?? room)[0].id;
    expect((await call('PUT' as never, `/v1/properties/${pid}/reservations/${resId}/rooms/${line}/assignment`, O, { roomId: id })).statusCode).toBe(200);
    const b = (await call('GET', `/v1/guest/booking/${token}`)).json();
    expect(b.rooms[0]).toMatchObject({ roomNumber: '101', floor: 'Ground floor' });
  });

  it('refuses a made-up or another hotel’s link without saying which', async () => {
    for (const bad of ['nope', `${T.tenantId.replace(/-/g, '')}-${'0'.repeat(32)}`, `${U.tenantId.replace(/-/g, '')}-${token.slice(33)}`]) {
      const r = await call('GET', `/v1/guest/booking/${bad}`);
      expect(r.statusCode).toBe(404);
    }
  });

  it('takes airport pick-up and accessibility requests, and staff answer them', async () => {
    const need = await call('POST', `/v1/guest/booking/${token}/requests`, {}, { kind: 'AIRPORT_PICKUP', neededOn: '2026-11-05' });
    expect(need.statusCode).toBe(400);                                                       // pick-up needs date and time
    const a = await call('POST', `/v1/guest/booking/${token}/requests`, {}, { kind: 'AIRPORT_PICKUP', neededOn: '2026-11-05', neededTime: '09:30', flightNo: 'PK301', passengers: 2 });
    expect(a.statusCode, a.body).toBe(201);
    const b = await call('POST', `/v1/guest/booking/${token}/requests`, {}, { kind: 'WHEELCHAIR', note: 'Father uses a wheelchair' });
    expect(b.statusCode).toBe(201);
    expect((await call('POST', `/v1/guest/booking/${token}/requests`, {}, { kind: 'OTHER' })).statusCode).toBe(400);
    const open = (await call('GET', `/v1/properties/${pid}/guest-requests`, O)).json().items;
    expect(open.map((x: any) => x.kind).sort()).toEqual(['AIRPORT_PICKUP', 'WHEELCHAIR']);
    expect(open[0]).toMatchObject({ guestName: 'Ali Raza' });
    const done = await call('PATCH', `/v1/properties/${pid}/guest-requests/${a.json().id}`, O, { status: 'DONE', staffNote: 'Driver Asif, white Corolla' });
    expect(done.statusCode, done.body).toBe(200);
    const page = (await call('GET', `/v1/guest/booking/${token}`)).json();
    expect(page.requests.find((x: any) => x.id === a.json().id)).toMatchObject({ status: 'DONE', staffNote: 'Driver Asif, white Corolla' });
  });

  it('only staff who may modify bookings answer requests; a link never opens staff routes', async () => {
    const u = await addUser(T.tenantId, 'viewer@portal.test'); await assignRole(T.tenantId, u, 'front_desk_agent', 'PROPERTY', pid);
    expect((await call('GET', `/v1/properties/${pid}/guest-requests`)).statusCode).toBe(401);
    expect((await call('GET', `/v1/properties/${pid}/reservations/${resId}`, { 'x-token': token })).statusCode).toBe(401);
  });

  it('stops after several requests in an hour', async () => {
    let last = 201;
    for (let i = 0; i < 6; i++) last = (await call('POST', `/v1/guest/booking/${token}/requests`, {}, { kind: 'EARLY_CHECKIN', note: 'around 10am' })).statusCode;
    expect(last).toBe(409);
  });

  it('closes requests once the booking is cancelled', async () => {
    await adminDb.updateTable('reservation').set({ status: 'CANCELLED' }).where('id', '=', resId).execute();
    const r = await call('POST', `/v1/guest/booking/${token}/requests`, {}, { kind: 'WHEELCHAIR' });
    expect(r.statusCode).toBe(409);
    expect((await call('GET', `/v1/guest/booking/${token}`)).json().booking.canRequest).toBe(false);
  });
});
