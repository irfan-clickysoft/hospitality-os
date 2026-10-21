import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { withTenant } from '@hos/db';
import { addDays } from '@hos/domain-types';
import { InventoryService } from '../src/inventory/inventory.service.js';
import { runWithTenant } from '../src/tenancy/tenant-context.js';
import { addUser, adminDb, appDb, as, assignRole, createTestApp, provision } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
let O: Record<string, string>, OM: Record<string, string>;     // owner headers, owner headers with fresh MFA
const OPEN = '2026-11-01';

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown) =>
  app.inject({ method, url, headers, payload: body as object | undefined });

beforeAll(async () => {
  app = await createTestApp();
  T = await provision(app, 'setup');
  O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true });
});
afterAll(async () => { await app.close(); });

/** Creates a SETUP property through the API with three room types and some rooms; returns ids. */
async function newProperty(code: string, opts: { goLive?: boolean; rooms?: Record<string, [number, number]> } = {}) {
  const p = await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code, name: `Sunset ${code}` });
  expect(p.statusCode, p.body).toBe(201);
  const propertyId = p.json().id as string;
  const rt: Record<string, string> = {};
  for (const [c, name, occ] of [['EXE', 'Executive', 3], ['DLX', 'Deluxe', 3], ['STD', 'Standard', 2]] as const) {
    const r = await call('POST', `/v1/properties/${propertyId}/room-types`, O, { code: c, name, maxAdults: 2, maxChildren: 1, maxOccupancy: occ, baseOccupancy: 2 });
    expect(r.statusCode, r.body).toBe(201);
    rt[c] = r.json().id;
  }
  const rooms = opts.rooms ?? { EXE: [301, 303], DLX: [201, 204], STD: [101, 103] };
  for (const [c, [from, to]] of Object.entries(rooms)) {
    const r = await call('POST', `/v1/properties/${propertyId}/rooms/bulk`, O, { roomTypeId: rt[c], from, to });
    expect(r.statusCode, r.body).toBe(201);
  }
  if (opts.goLive !== false) {
    const g = await call('POST', `/v1/properties/${propertyId}/go-live`, O, { openingBusinessDate: OPEN });
    expect(g.statusCode, g.body).toBe(200);
  }
  return { propertyId, rt };
}

describe('setup wizard → go-live', () => {
  it('walks the Sunset Boulevard shape: 3 room types, 9 rooms, floors, amenities → ready → live with 2 years of inventory', async () => {
    const p = await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: 'BLVD', name: 'Sunset Boulevard' });
    expect(p.statusCode).toBe(201);
    expect(p.json()).toMatchObject({ code: 'BLVD', status: 'SETUP', timezone: 'Asia/Karachi', currency: 'PKR' });
    const id = p.json().id as string;
    const todayKhi = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
    expect(p.json().businessDate).toBe(todayKhi);                              // business date comes from the property's own time zone

    let st = (await call('GET', `/v1/properties/${id}/setup-status`, O)).json();
    expect(st.readyToGoLive).toBe(false);
    expect(st.blockers).toEqual(['Add at least one room type', 'Add at least one room']);
    expect((await call('POST', `/v1/properties/${id}/go-live`, O, {})).statusCode).toBe(422);

    const f1 = (await call('POST', `/v1/properties/${id}/floors`, O, { name: 'Ground', sortOrder: 0 })).json();
    const f2 = (await call('POST', `/v1/properties/${id}/floors`, O, { name: 'First', sortOrder: 1 })).json();
    expect(f1.id && f2.id).toBeTruthy();
    const wifi = (await call('POST', '/v1/amenities', O, { code: 'wifi', nameEn: 'Wi-Fi', nameUr: 'وائی فائی', category: 'CONNECTIVITY' })).json();
    const ac = (await call('POST', '/v1/amenities', O, { code: 'ac', nameEn: 'Air conditioning' })).json();

    const rt: Record<string, string> = {};
    for (const [c, n] of [['EXE', 'Executive'], ['DLX', 'Deluxe'], ['STD', 'Standard']] as const) {
      rt[c] = (await call('POST', `/v1/properties/${id}/room-types`, O, { code: c, name: n, maxAdults: 2, maxOccupancy: 3 })).json().id;
    }
    expect((await call('PUT', `/v1/properties/${id}/room-types/${rt.EXE}/amenities`, O, { amenityIds: [wifi.id, ac.id] })).statusCode).toBe(200);
    for (const [c, from, to, floor] of [['STD', 101, 103, f1.id], ['DLX', 201, 203, f2.id], ['EXE', 204, 206, f2.id]] as const) {
      const r = await call('POST', `/v1/properties/${id}/rooms/bulk`, O, { roomTypeId: rt[c], floorId: floor, from, to });
      expect(r.json().created).toBe(3);
    }
    st = (await call('GET', `/v1/properties/${id}/setup-status`, O)).json();
    expect(st).toMatchObject({ readyToGoLive: true, counts: { floors: 2, roomTypes: 3, rooms: 9 } });

    const live = await call('POST', `/v1/properties/${id}/go-live`, O, { openingBusinessDate: OPEN });
    expect(live.json()).toMatchObject({ status: 'LIVE', businessDate: OPEN, inventoryRows: 3 * 730 });
    expect((await call('POST', `/v1/properties/${id}/go-live`, O, {})).statusCode).toBe(409);

    const av = (await call('GET', `/v1/properties/${id}/availability?from=${OPEN}&to=${addDays(OPEN, 3)}`, O)).json();
    expect(av.roomTypes.map((r: any) => r.code).sort()).toEqual(['DLX', 'EXE', 'STD']);
    for (const r of av.roomTypes) { expect(r.nights).toHaveLength(3); expect(r.nights[0]).toMatchObject({ physical: 3, available: 3, reserved: 0 }); }
    expect((await call('GET', `/v1/properties/${id}/inventory-check`, O)).json().issues).toEqual([]);
    const types = (await call('GET', `/v1/properties/${id}/room-types`, O)).json().items;
    expect(types.find((t: any) => t.code === 'EXE').amenityIds).toHaveLength(2);
  });

  it('rejects bad input with clear 4xx errors, never 500', async () => {
    const { propertyId, rt } = await newProperty('VAL', { goLive: false, rooms: { STD: [101, 102] } });
    const bad = async (url: string, body: unknown, status: number, code?: string, method: 'POST' | 'PATCH' = 'POST') => {
      const r = await call(method, url, O, body); expect(r.statusCode, `${url} ${JSON.stringify(body)} → ${r.body}`).toBe(status); if (code) expect(r.json().code).toBe(code);
    };
    await bad(`/v1/properties/${propertyId}/rooms/bulk`, { roomTypeId: rt.STD, from: 101, to: 103 }, 409, 'DUPLICATE');          // 101,102 exist
    await bad(`/v1/properties/${propertyId}/rooms/bulk`, { roomTypeId: rt.STD, from: 1, to: 500 }, 400, 'VALIDATION_FAILED');       // > 200
    await bad(`/v1/properties/${propertyId}/rooms/bulk`, { roomTypeId: rt.STD, from: 9, to: 3 }, 400, 'VALIDATION_FAILED');
    await bad(`/v1/properties/${propertyId}/room-types`, { code: 'BAD CODE!', name: 'x', maxAdults: 2, maxOccupancy: 2 }, 400, 'VALIDATION_FAILED');
    await bad(`/v1/properties/${propertyId}/room-types`, { code: 'X', name: 'Xx', maxAdults: 2, maxOccupancy: 2, baseOccupancy: 5 }, 400, 'VALIDATION_FAILED');
    await bad(`/v1/properties/${propertyId}/room-types`, { code: 'STD', name: 'Again', maxAdults: 2, maxOccupancy: 2 }, 409, 'DUPLICATE');
    await bad(`/v1/properties/${propertyId}/rooms`, { roomTypeId: rt.STD, number: 'bad/number' }, 400, 'VALIDATION_FAILED');
    await bad('/v1/properties', { legalEntityId: T.legalEntityId, code: 'X', name: 'Hotel' }, 400, 'VALIDATION_FAILED');
    await bad('/v1/properties', { legalEntityId: T.legalEntityId, code: 'TZ1', name: 'Hotel', timezone: 'Mars/Base' }, 400, 'VALIDATION_FAILED');
    await bad('/v1/properties', { legalEntityId: crypto.randomUUID(), code: 'NOLE', name: 'Hotel' }, 422, 'REFERENCE_INVALID');   // unknown legal entity
    await bad(`/v1/properties/${propertyId}`, { name: 'Renamed', version: 999 }, 412, 'VERSION_CONFLICT', 'PATCH');
  });

  it('optimistic locking: a stale edit is refused, a current one wins', async () => {
    const { propertyId } = await newProperty('LCK', { goLive: false, rooms: { STD: [1, 1] } });
    const cur = (await call('GET', `/v1/properties/${propertyId}`, O)).json();
    const ok = await call('PATCH', `/v1/properties/${propertyId}`, O, { name: 'First edit', version: cur.version });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().version).toBe(cur.version + 1);
    expect((await call('PATCH', `/v1/properties/${propertyId}`, O, { name: 'Second edit', version: cur.version })).statusCode).toBe(412);
  });

  it('the time zone is locked once the property is live', async () => {
    const { propertyId } = await newProperty('TZL');
    const cur = (await call('GET', `/v1/properties/${propertyId}`, O)).json();
    const r = await call('PATCH', `/v1/properties/${propertyId}`, O, { timezone: 'Asia/Dubai', version: cur.version });
    expect(r.statusCode).toBe(409); expect(r.json().code).toBe('TIMEZONE_LOCKED');
  });

  it('connecting rooms are symmetric and cannot be double-booked into two links', async () => {
    const { propertyId, rt } = await newProperty('CON', { goLive: false, rooms: { STD: [101, 103] } });
    const rooms = (await call('GET', `/v1/properties/${propertyId}/rooms`, O)).json().items;
    const [a, b, c] = rooms;
    const r = await call('PATCH', `/v1/properties/${propertyId}/rooms/${a.id}`, O, { connectingRoomId: b.id, version: a.version });
    expect(r.statusCode, r.body).toBe(200);
    const after = (await call('GET', `/v1/properties/${propertyId}/rooms`, O)).json().items;
    expect(after.find((x: any) => x.id === b.id).connectingRoomId).toBe(a.id);
    const clash = await call('PATCH', `/v1/properties/${propertyId}/rooms/${c.id}`, O, { connectingRoomId: b.id, version: c.version });
    expect(clash.statusCode).toBe(409);
    const clear = await call('PATCH', `/v1/properties/${propertyId}/rooms/${a.id}`, O, { connectingRoomId: null, version: after.find((x: any) => x.id === a.id).version });
    expect(clear.statusCode).toBe(200);
    expect((await call('GET', `/v1/properties/${propertyId}/rooms`, O)).json().items.find((x: any) => x.id === b.id).connectingRoomId).toBeNull();
    void rt;
  });
});

describe('who may set up what (scoped roles)', () => {
  it('a property manager runs their own property but cannot create properties or touch another', async () => {
    const a = await newProperty('SC1', { goLive: false, rooms: { STD: [1, 2] } });
    const b = await newProperty('SC2', { goLive: false, rooms: { STD: [1, 2] } });
    const u = await addUser(T.tenantId, 'gm-sc1@setup.test');
    await assignRole(T.tenantId, u, 'general_manager', 'PROPERTY', a.propertyId);
    const gm = as(T.tenantId, u);
    expect((await call('POST', '/v1/properties', gm, { legalEntityId: T.legalEntityId, code: 'NEW', name: 'New hotel' })).statusCode).toBe(403);
    expect((await call('POST', `/v1/properties/${a.propertyId}/rooms`, gm, { roomTypeId: a.rt.STD, number: '77' })).statusCode).toBe(201);
    expect((await call('POST', `/v1/properties/${b.propertyId}/rooms`, gm, { roomTypeId: b.rt.STD, number: '77' })).statusCode).toBe(403);
    const mine = (await call('GET', '/v1/properties', gm)).json().items.map((p: any) => p.code);
    expect(mine).toEqual(['SC1']);                                                     // the list shows only what they may see
  });
  it('front desk can view but not change setup; gate security sees nothing', async () => {
    const a = await newProperty('SC3', { goLive: false, rooms: { STD: [1, 1] } });
    const fd = await addUser(T.tenantId, 'fd-sc3@setup.test'); await assignRole(T.tenantId, fd, 'front_desk_agent', 'PROPERTY', a.propertyId);
    const gs = await addUser(T.tenantId, 'gs-sc3@setup.test'); await assignRole(T.tenantId, gs, 'gate_security', 'PROPERTY', a.propertyId);
    expect((await call('GET', `/v1/properties/${a.propertyId}/rooms`, as(T.tenantId, fd))).statusCode).toBe(200);
    expect((await call('POST', `/v1/properties/${a.propertyId}/rooms`, as(T.tenantId, fd), { roomTypeId: a.rt.STD, number: '9' })).statusCode).toBe(403);
    expect((await call('GET', `/v1/properties/${a.propertyId}/rooms`, as(T.tenantId, gs))).statusCode).toBe(403);
    expect((await call('GET', '/v1/properties', as(T.tenantId, gs))).json().items).toEqual([]);
  });
  it("tenant B cannot see or use tenant A's property, rooms or room types", async () => {
    const a = await newProperty('ISO');
    const B = await provision(app, 'setup-b');
    const ob = as(B.tenantId, B.ownerUserId);
    expect((await call('GET', `/v1/properties/${a.propertyId}/rooms`, ob)).statusCode).toBe(404);
    expect((await call('GET', `/v1/properties/${a.propertyId}/availability?from=${OPEN}&to=${addDays(OPEN, 2)}`, ob)).statusCode).toBe(404);
    const own = await call('POST', '/v1/properties', ob, { legalEntityId: B.legalEntityId, code: 'B1', name: 'B hotel' });
    const res = await call('POST', `/v1/properties/${own.json().id}/rooms`, ob, { roomTypeId: a.rt.STD, number: '1' });   // A's room type in B's property
    expect(res.statusCode).toBe(422);
    const mine = (await call('GET', '/v1/properties', ob)).json().items;
    expect(mine.map((p: any) => p.code).sort()).toEqual(['B1', 'P1', 'P2']);               // B's own (P1/P2 are the harness's sample properties)
    expect(mine.every((p: any) => p.id !== a.propertyId)).toBe(true);
    expect(mine.some((p: any) => p.code === 'ISO')).toBe(false);
  });
});

describe('live operations: blocks, capacity, overbooking', () => {
  const avail = async (propertyId: string, code: string, d: string) => {
    const r = (await call('GET', `/v1/properties/${propertyId}/availability?from=${d}&to=${addDays(d, 1)}`, O)).json();
    return r.roomTypes.find((x: any) => x.code === code).nights[0];
  };

  it('an out-of-order block removes the room from sale; overlap is refused; ending early restores it', async () => {
    const { propertyId } = await newProperty('BLK');
    const room = (await call('GET', `/v1/properties/${propertyId}/rooms`, O)).json().items.find((r: any) => r.number === '101');
    const b = await call('POST', `/v1/properties/${propertyId}/room-blocks`, O, { roomId: room.id, type: 'OUT_OF_ORDER', startDate: '2026-11-03', endDate: '2026-11-08', reason: 'AC compressor replacement', ticketRef: 'MT-12' });
    expect(b.statusCode, b.body).toBe(201);
    expect((await avail(propertyId, 'STD', '2026-11-02')).available).toBe(3);
    expect(await avail(propertyId, 'STD', '2026-11-03')).toMatchObject({ outOfOrder: 1, sellable: 2, available: 2 });
    expect((await avail(propertyId, 'STD', '2026-11-07')).available).toBe(2);
    expect((await avail(propertyId, 'STD', '2026-11-08')).available).toBe(3);                   // end date is exclusive

    const overlap = await call('POST', `/v1/properties/${propertyId}/room-blocks`, O, { roomId: room.id, type: 'OUT_OF_SERVICE', startDate: '2026-11-05', endDate: '2026-11-06', reason: 'Deep clean' });
    expect(overlap.statusCode).toBe(409); expect(overlap.json().code).toBe('OVERLAP');

    const ended = await call('POST', `/v1/properties/${propertyId}/room-blocks/${b.json().id}/end`, O, { endDate: '2026-11-05' });
    expect(ended.statusCode).toBe(200);
    expect((await avail(propertyId, 'STD', '2026-11-04')).available).toBe(2);
    expect((await avail(propertyId, 'STD', '2026-11-05')).available).toBe(3);
    expect((await call('DELETE', `/v1/properties/${propertyId}/room-blocks/${b.json().id}`, O)).statusCode).toBe(200);
    expect((await avail(propertyId, 'STD', '2026-11-03')).available).toBe(3);
    expect((await call('GET', `/v1/properties/${propertyId}/inventory-check`, O)).json().issues).toEqual([]);
  });

  it('a block that would oversell existing bookings is refused; acknowledging needs the overbooking permission', async () => {
    const { propertyId, rt } = await newProperty('OVS', { rooms: { STD: [101, 101] } });  // one room
    const inv = app.get(InventoryService);
    await runWithTenant({ tenantId: T.tenantId, actorId: T.ownerUserId }, () => withTenant(appDb, T.tenantId, (trx) =>
      inv.reserve(trx, { propertyId, roomTypeId: rt.STD!, arrival: '2026-11-04', departure: '2026-11-06' })));
    const room = (await call('GET', `/v1/properties/${propertyId}/rooms`, O)).json().items[0];
    const body = { roomId: room.id, type: 'OUT_OF_ORDER', startDate: '2026-11-03', endDate: '2026-11-07', reason: 'Water leak' };
    const refused = await call('POST', `/v1/properties/${propertyId}/room-blocks`, O, body);
    expect(refused.statusCode).toBe(409); expect(refused.json().code).toBe('BLOCK_CAUSES_OVERSELL');
    expect((await avail(propertyId, 'STD', '2026-11-04')).outOfOrder).toBe(0);                  // nothing half-applied

    const fd = await addUser(T.tenantId, 'fd-ovs@setup.test'); await assignRole(T.tenantId, fd, 'general_manager', 'PROPERTY', propertyId);
    const noMfa = await call('POST', `/v1/properties/${propertyId}/room-blocks`, as(T.tenantId, fd), { ...body, acknowledgeOversell: true });
    expect(noMfa.statusCode).toBe(201);                                                          // GM holds inventory.overbook; block endpoint itself is not step-up gated
    const dup = await call('POST', `/v1/properties/${propertyId}/room-blocks`, O, { ...body, acknowledgeOversell: true });
    expect(dup.statusCode).toBe(409);                                                            // already blocked → overlap
    const ack = noMfa.json();
    expect(ack.oversoldDates).toEqual(['2026-11-04', '2026-11-05']);
    const issues = (await call('GET', `/v1/properties/${propertyId}/inventory-check`, O)).json().issues;
    expect(issues.map((i: any) => i.kind)).toContain('OVERSOLD');                                // the checker surfaces it for the walk workflow
  });

  it('a user without the overbooking permission cannot acknowledge an oversell', async () => {
    const { propertyId, rt } = await newProperty('OV2', { rooms: { STD: [101, 101] } });
    const inv = app.get(InventoryService);
    await runWithTenant({ tenantId: T.tenantId, actorId: T.ownerUserId }, () => withTenant(appDb, T.tenantId, (trx) =>
      inv.reserve(trx, { propertyId, roomTypeId: rt.STD!, arrival: '2026-11-04', departure: '2026-11-05' })));
    const room = (await call('GET', `/v1/properties/${propertyId}/rooms`, O)).json().items[0];
    const u = await addUser(T.tenantId, 'sup-ov2@setup.test');
    await adminDb.insertInto('role').values({ tenant_id: T.tenantId, key: 'blocker', name: 'Blocker-only', is_system: false }).onConflict((oc) => oc.doNothing()).execute();
    const role = await adminDb.selectFrom('role').select('id').where('tenant_id', '=', T.tenantId).where('key', '=', 'blocker').executeTakeFirstOrThrow();
    await adminDb.insertInto('role_permission').values([{ tenant_id: T.tenantId, role_id: role.id, permission_key: 'inventory.block' }]).onConflict((oc) => oc.doNothing()).execute();
    await adminDb.insertInto('role_assignment').values({ tenant_id: T.tenantId, user_id: u, role_id: role.id, scope_type: 'PROPERTY', scope_id: propertyId, valid_to: null }).execute();
    const r = await call('POST', `/v1/properties/${propertyId}/room-blocks`, as(T.tenantId, u), { roomId: room.id, type: 'OUT_OF_ORDER', startDate: '2026-11-04', endDate: '2026-11-05', reason: 'Leak', acknowledgeOversell: true });
    expect(r.statusCode).toBe(403);
  });

  it('blocks cannot start before the business date', async () => {
    const { propertyId } = await newProperty('PST');
    const room = (await call('GET', `/v1/properties/${propertyId}/rooms`, O)).json().items[0];
    const r = await call('POST', `/v1/properties/${propertyId}/room-blocks`, O, { roomId: room.id, type: 'OUT_OF_ORDER', startDate: '2026-10-30', endDate: '2026-11-03', reason: 'Backdated' });
    expect(r.statusCode).toBe(422); expect(r.json().code).toBe('DATE_IN_PAST');
  });

  it('adding a room after go-live raises availability; retiring one is refused while it would strand a booking', async () => {
    const { propertyId, rt } = await newProperty('CAP', { rooms: { STD: [101, 102] } });
    expect((await avail(propertyId, 'STD', '2026-12-01')).physical).toBe(2);
    const add = await call('POST', `/v1/properties/${propertyId}/rooms`, O, { roomTypeId: rt.STD, number: '103' });
    expect(add.statusCode).toBe(201);
    expect((await avail(propertyId, 'STD', '2026-12-01')).physical).toBe(3);
    expect((await avail(propertyId, 'STD', '2027-10-15')).physical).toBe(3);                    // whole horizon

    const inv = app.get(InventoryService);
    await runWithTenant({ tenantId: T.tenantId, actorId: T.ownerUserId }, () => withTenant(appDb, T.tenantId, (trx) =>
      inv.reserve(trx, { propertyId, roomTypeId: rt.STD!, arrival: '2026-11-10', departure: '2026-11-11', rooms: 3 })));
    const rooms = (await call('GET', `/v1/properties/${propertyId}/rooms`, O)).json().items;
    const r103 = rooms.find((r: any) => r.number === '103');
    const retire = await call('PATCH', `/v1/properties/${propertyId}/rooms/${r103.id}`, O, { status: 'INACTIVE', version: r103.version });
    expect(retire.statusCode).toBe(409); expect(retire.json().code).toBe('CAPACITY_BELOW_RESERVED');
    expect((await avail(propertyId, 'STD', '2026-12-01')).physical).toBe(3);                    // rolled back, not half-applied
  });

  it('a room type added after go-live gets its own inventory', async () => {
    const { propertyId } = await newProperty('LTE');
    const rt = (await call('POST', `/v1/properties/${propertyId}/room-types`, O, { code: 'SUI', name: 'Suite', maxAdults: 3, maxOccupancy: 4 })).json().id;
    await call('POST', `/v1/properties/${propertyId}/rooms`, O, { roomTypeId: rt, number: '401' });
    expect((await avail(propertyId, 'SUI', '2026-11-20')).physical).toBe(1);
  });

  it('overbooking limits need the (step-up protected) overbooking permission and show up in availability', async () => {
    const { propertyId, rt } = await newProperty('OBK', { rooms: { STD: [101, 102] } });
    const body = { from: '2026-12-24', to: '2026-12-27', limit: 1 };
    const noMfa = await call('PUT', `/v1/properties/${propertyId}/room-types/${rt.STD}/overbook`, O, body);
    expect(noMfa.statusCode).toBe(403); expect(noMfa.json().code).toBe('MFA_REQUIRED');
    const ok = await call('PUT', `/v1/properties/${propertyId}/room-types/${rt.STD}/overbook`, OM, body);
    expect(ok.statusCode, ok.body).toBe(200); expect(ok.json().nightsUpdated).toBe(3);
    expect(await avail(propertyId, 'STD', '2026-12-25')).toMatchObject({ overbookLimit: 1, available: 3 });
    expect((await avail(propertyId, 'STD', '2026-12-27')).overbookLimit).toBe(0);
    expect((await call('PUT', `/v1/properties/${propertyId}/room-types/${rt.STD}/overbook`, OM, { ...body, limit: 99 })).statusCode).toBe(400);
  });
});

describe('audit & events', () => {
  it('every setup change leaves an audit row and inventory changes emit InventoryChanged', async () => {
    const { propertyId } = await newProperty('AUD');
    const room = (await call('GET', `/v1/properties/${propertyId}/rooms`, O)).json().items[0];
    await call('POST', `/v1/properties/${propertyId}/room-blocks`, O, { roomId: room.id, type: 'OUT_OF_SERVICE', startDate: '2026-11-05', endDate: '2026-11-06', reason: 'Deep clean' });
    const actions = (await adminDb.selectFrom('audit_log').select('action').where('tenant_id', '=', T.tenantId).where('property_id', '=', propertyId).execute()).map((a) => a.action);
    for (const a of ['property.create', 'room_type.create', 'room.bulk_create', 'property.go_live', 'room_block.create']) expect(actions, a).toContain(a);
    const events = (await adminDb.selectFrom('outbox_event').select(['event_type', 'payload']).where('tenant_id', '=', T.tenantId).where('property_id', '=', propertyId).execute()).map((e) => e.event_type);
    expect(events).toEqual(expect.arrayContaining(['PropertyCreated', 'PropertyWentLive', 'InventoryChanged']));
    const actor = await adminDb.selectFrom('audit_log').select('actor_id').where('tenant_id', '=', T.tenantId).where('action', '=', 'room_block.create').where('property_id', '=', propertyId).executeTakeFirstOrThrow();
    expect(actor.actor_id).toBe(T.ownerUserId);
  });

  it('keeps the city, the Google Maps link and the check-in and check-out times for the guest message', async () => {
    const { propertyId } = await newProperty('MSG');
    const cur = (await call('GET', `/v1/properties/${propertyId}`, O)).json();
    expect(cur).toMatchObject({ city: null, mapsUrl: null, checkInTime: '14:00', checkOutTime: '12:00' });
    const bad = await call('PATCH', `/v1/properties/${propertyId}`, O, { mapsUrl: 'javascript:alert(1)', version: cur.version });
    expect(bad.statusCode).toBe(400);
    const r = await call('PATCH', `/v1/properties/${propertyId}`, O, { city: 'Karachi', mapsUrl: 'https://maps.app.goo.gl/abc', checkInTime: '15:30', checkOutTime: '11:00', version: cur.version });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ city: 'Karachi', mapsUrl: 'https://maps.app.goo.gl/abc', checkInTime: '15:30', checkOutTime: '11:00' });
    const mine = (await call('GET', '/v1/me/properties', O)).json().items.find((x: any) => x.id === propertyId);
    expect(mine).toMatchObject({ city: 'Karachi', mapsUrl: 'https://maps.app.goo.gl/abc', checkInTime: '15:30' });
  });
});
