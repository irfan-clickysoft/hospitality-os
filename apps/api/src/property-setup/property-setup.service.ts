import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import type { DB } from '@hos/db';
import { addDays, nightsOf } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { HORIZON_DAYS, InventoryService } from '../inventory/inventory.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { mediaUrl } from '../media/media.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

type Trx = Transaction<DB>;
const todayIn = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const stale = () => new HttpException({ code: 'VERSION_CONFLICT', message: 'This record was changed by someone else. Reload and try again.' }, 412);

@Injectable()
export class PropertySetupService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(InventoryService) private readonly inv: InventoryService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
  ) {}

  // ───────────────────────── properties ─────────────────────────
  private async prop(trx: Trx, id: string) {
    const p = await trx.selectFrom('property').selectAll().where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return p;
  }
  private propDto(p: Awaited<ReturnType<PropertySetupService['prop']>>) {
    return { id: p.id, code: p.code, name: p.name, legalEntityId: p.legal_entity_id, brandId: p.brand_id, timezone: p.timezone, currency: p.currency, businessDate: p.business_date, weekendDays: p.weekend_days, city: p.city, mapsUrl: p.maps_url, registrationStrict: p.registration_strict, nicopAloneOk: p.nicop_alone_ok, terms: p.terms_text, shortStayRule: p.short_stay_rule ?? null, checkInTime: String(p.check_in_time).slice(0, 5), checkOutTime: String(p.check_out_time).slice(0, 5), status: p.status, version: p.version, address: p.address, phone: p.phone, receiptFooter: p.receipt_footer, brandColor: p.brand_color, logoUrl: p.logo_file ? mediaUrl(currentTenant().tenantId, p.logo_file, '') : null };
  }

  /** Properties the current user may view (property-scoped users see only theirs). */
  /** The companies that can own a property (a new property needs one). */
  async listLegalEntities() { return this.tdb.tx((trx) => trx.selectFrom('legal_entity').select(['id', 'name']).orderBy('name').execute()); }

  async listProperties(userId: string) {
    const grants = await this.authz.loadGrants(userId);
    const rows = await this.tdb.tx((trx) => trx.selectFrom('property').selectAll().orderBy('name').execute());
    const { decide } = await import('@hos/auth');
    return rows.filter((p) => decide(grants, { permission: 'property.view', scope: { propertyId: p.id, legalEntityId: p.legal_entity_id } }).effect === 'ALLOW').map((p) => this.propDto(p));
  }

  /** Properties where this user holds any permission — what the staff app offers in its property switcher. */
  async myProperties(userId: string) {
    const grants = await this.authz.loadGrants(userId);
    const rows = await this.tdb.tx((trx) => trx.selectFrom('property').selectAll().where('status', '<>', 'ARCHIVED' as never).orderBy('name').execute());
    const { decide } = await import('@hos/auth');
    return rows.filter((p) => grants.some((g) => decide([g], { permission: g.permission, scope: { propertyId: p.id, legalEntityId: p.legal_entity_id } }).effect === 'ALLOW'))
      .map((p) => ({ id: p.id, code: p.code, name: p.name, businessDate: p.business_date, timezone: p.timezone, status: p.status, city: p.city, mapsUrl: p.maps_url, checkInTime: String(p.check_in_time).slice(0, 5), checkOutTime: String(p.check_out_time).slice(0, 5) }));
  }

  async createProperty(i: z.infer<typeof S.CreateProperty>) {
    return this.tdb.tx(async (trx) => {
      const businessDate = i.openingBusinessDate ?? todayIn(i.timezone);
      const p = await trx.insertInto('property').values({
        tenant_id: currentTenant().tenantId, legal_entity_id: i.legalEntityId, brand_id: i.brandId ?? null, code: i.code, name: i.name,
        timezone: i.timezone, currency: i.currency, business_date: businessDate, status: 'SETUP',
      }).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'property.create', resourceType: 'property', resourceId: p.id, propertyId: p.id, after: this.propDto(p) });
      await this.outbox.publish(trx, { aggregateType: 'property', aggregateId: p.id, eventType: 'PropertyCreated', propertyId: p.id, payload: { code: p.code } });
      return this.propDto(p);
    });
  }

  async updateProperty(id: string, i: z.infer<typeof S.UpdateProperty>) {
    return this.tdb.tx(async (trx) => {
      const before = await this.prop(trx, id);
      if (i.timezone && i.timezone !== before.timezone && before.status !== 'SETUP') {
        throw new ConflictException({ code: 'TIMEZONE_LOCKED', message: 'The time zone cannot change after go-live (business dates depend on it). Contact support.' });
      }
      const set: Record<string, unknown> = { version: sql`version + 1` };
      if (i.name !== undefined) set.name = i.name;
      if (i.timezone !== undefined) set.timezone = i.timezone;
      if (i.brandId !== undefined) set.brand_id = i.brandId;
      if (i.terms !== undefined) set.terms_text = i.terms;
      if (i.registrationStrict !== undefined) set.registration_strict = i.registrationStrict;
      if (i.nicopAloneOk !== undefined) set.nicop_alone_ok = i.nicopAloneOk;
      if (i.city !== undefined) set.city = i.city;
      if (i.shortStayRule !== undefined) set.short_stay_rule = i.shortStayRule === null ? null : JSON.stringify(i.shortStayRule);
      if (i.address !== undefined) set.address = i.address || null; if (i.phone !== undefined) set.phone = i.phone || null; if (i.receiptFooter !== undefined) set.receipt_footer = i.receiptFooter || null; if (i.brandColor !== undefined) set.brand_color = i.brandColor || null;
      if (i.mapsUrl !== undefined) set.maps_url = i.mapsUrl;
      if (i.checkInTime !== undefined) set.check_in_time = i.checkInTime;
      if (i.checkOutTime !== undefined) set.check_out_time = i.checkOutTime;
      if (i.weekendDays !== undefined) set.weekend_days = [...new Set(i.weekendDays)].sort();
      const after = await trx.updateTable('property').set(set as never).where('id', '=', id).where('version', '=', i.version).returningAll().executeTakeFirst();
      if (!after) throw stale();
      await this.audit.record(trx, { action: 'property.update', resourceType: 'property', resourceId: id, propertyId: id, before: this.propDto(before), after: this.propDto(after) });
      return this.propDto(after);
    });
  }

  async setupStatus(id: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, id);
      const c = async (table: 'room_type' | 'room' | 'floor') =>
        Number((await trx.selectFrom(table).select(sql<string>`count(*)`.as('n')).where('property_id', '=', id)
          .$if(table !== 'floor', (q) => q.where('status', '=', table === 'room' ? 'ACTIVE' : 'ACTIVE' as never)).executeTakeFirstOrThrow()).n);
      const [roomTypes, rooms, floors] = [await c('room_type'), await c('room'), await c('floor')];
      const blockers: string[] = [];
      if (roomTypes === 0) blockers.push('Add at least one room type');
      if (rooms === 0) blockers.push('Add at least one room');
      return {
        property: this.propDto(p), steps: { business: true, structure: floors > 0, roomTypes: roomTypes > 0, rooms: rooms > 0 },
        counts: { floors, roomTypes, rooms },
        pendingModules: ['Rate plans', 'Taxes & fees', 'Policies', 'Payment methods'],   // wizard steps whose modules are not built yet
        blockers, readyToGoLive: p.status === 'SETUP' && blockers.length === 0,
      };
    });
  }

  async goLive(id: string, i: z.infer<typeof S.GoLive>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, id);
      if (p.status !== 'SETUP') throw new ConflictException({ code: 'ALREADY_LIVE', message: 'This property is already live' });
      const types = await trx.selectFrom('room_type').select('id').where('property_id', '=', id).where('status', '=', 'ACTIVE').execute();
      const roomCount = Number((await trx.selectFrom('room').select(sql<string>`count(*)`.as('n')).where('property_id', '=', id).where('status', '=', 'ACTIVE').executeTakeFirstOrThrow()).n);
      if (types.length === 0 || roomCount === 0) throw new UnprocessableEntityException({ code: 'SETUP_INCOMPLETE', message: 'Add at least one room type and one room before going live' });
      const opening = i.openingBusinessDate ?? p.business_date;
      await trx.updateTable('property').set({ status: 'LIVE', business_date: opening, version: sql`version + 1` as never }).where('id', '=', id).execute();
      const created = await this.inv.ensureHorizon(trx, id, opening, addDays(opening, HORIZON_DAYS));
      await this.audit.record(trx, { action: 'property.go_live', resourceType: 'property', resourceId: id, propertyId: id, after: { openingBusinessDate: opening, inventoryRows: created, rooms: roomCount } });
      await this.outbox.publish(trx, { aggregateType: 'property', aggregateId: id, eventType: 'PropertyWentLive', propertyId: id, businessDate: opening, payload: { rooms: roomCount } });
      return { status: 'LIVE', businessDate: opening, inventoryRows: created };
    });
  }

  // ───────────────────────── structure ─────────────────────────
  async createBuilding(propertyId: string, i: z.infer<typeof S.CreateBuilding>) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const b = await trx.insertInto('building').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, name: i.name }).returning(['id', 'name']).executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'building.create', resourceType: 'building', resourceId: b.id, propertyId, after: b });
      return b;
    });
  }
  async createFloor(propertyId: string, i: z.infer<typeof S.CreateFloor>) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const f = await trx.insertInto('floor').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, building_id: i.buildingId ?? null, name: i.name, sort_order: i.sortOrder })
        .returning(['id', 'name', 'building_id', 'sort_order']).executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'floor.create', resourceType: 'floor', resourceId: f.id, propertyId, after: f });
      return { id: f.id, name: f.name, buildingId: f.building_id, sortOrder: f.sort_order };
    });
  }
  async structure(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const [buildings, floors] = await Promise.all([
        trx.selectFrom('building').select(['id', 'name']).where('property_id', '=', propertyId).orderBy('name').execute(),
        trx.selectFrom('floor').select(['id', 'name', 'building_id', 'sort_order']).where('property_id', '=', propertyId).orderBy('sort_order').orderBy('name').execute(),
      ]);
      return { buildings, floors: floors.map((f) => ({ id: f.id, name: f.name, buildingId: f.building_id, sortOrder: f.sort_order })) };
    });
  }

  // ───────────────────────── room types ─────────────────────────
  private rtDto(r: any) {
    return { id: r.id, code: r.code, name: r.name, description: r.description, maxAdults: r.max_adults, maxChildren: r.max_children, maxOccupancy: r.max_occupancy,
      baseOccupancy: r.base_occupancy, bedConfig: r.bed_config, sizeSqm: r.size_sqm === null ? null : Number(r.size_sqm), defaultOverbookLimit: r.default_overbook_limit,
      status: r.status, sortOrder: r.sort_order, version: r.version };
  }
  async createRoomType(propertyId: string, i: z.infer<typeof S.CreateRoomType>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const r = await trx.insertInto('room_type').values({
        tenant_id: currentTenant().tenantId, property_id: propertyId, code: i.code, name: i.name, description: i.description ?? null, max_adults: i.maxAdults, max_children: i.maxChildren,
        max_occupancy: i.maxOccupancy, base_occupancy: i.baseOccupancy, bed_config: i.bedConfig ?? null, size_sqm: i.sizeSqm === undefined || i.sizeSqm === null ? null : String(i.sizeSqm),
        default_overbook_limit: i.defaultOverbookLimit, sort_order: i.sortOrder,
      }).returningAll().executeTakeFirstOrThrow();
      if (p.status === 'LIVE') await this.inv.ensureHorizon(trx, propertyId, p.business_date, addDays(p.business_date, HORIZON_DAYS), r.id);
      await this.audit.record(trx, { action: 'room_type.create', resourceType: 'room_type', resourceId: r.id, propertyId, after: this.rtDto(r) });
      return this.rtDto(r);
    });
  }
  async listRoomTypes(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const rows = await trx.selectFrom('room_type').selectAll().where('property_id', '=', propertyId).orderBy('sort_order').orderBy('code').execute();
      const am = await trx.selectFrom('room_type_amenity').select(['room_type_id', 'amenity_id']).execute();
      return rows.map((r) => ({ ...this.rtDto(r), amenityIds: am.filter((a) => a.room_type_id === r.id).map((a) => a.amenity_id) }));
    });
  }
  async updateRoomType(propertyId: string, id: string, i: z.infer<typeof S.UpdateRoomType>) {
    return this.tdb.tx(async (trx) => {
      const before = await trx.selectFrom('room_type').selectAll().where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst();
      if (!before) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room type not found' });
      if (i.status === 'ARCHIVED') {
        const n = Number((await trx.selectFrom('room').select(sql<string>`count(*)`.as('n')).where('room_type_id', '=', id).where('status', '=', 'ACTIVE').executeTakeFirstOrThrow()).n);
        if (n > 0) throw new ConflictException({ code: 'ROOM_TYPE_IN_USE', message: `${n} active room(s) still use this room type` });
      }
      const m: Record<string, unknown> = { version: sql`version + 1` };
      const map: Record<string, string> = { code: 'code', name: 'name', description: 'description', maxAdults: 'max_adults', maxChildren: 'max_children', maxOccupancy: 'max_occupancy', baseOccupancy: 'base_occupancy',
        bedConfig: 'bed_config', defaultOverbookLimit: 'default_overbook_limit', sortOrder: 'sort_order', status: 'status' };
      for (const [k, col] of Object.entries(map)) if ((i as Record<string, unknown>)[k] !== undefined) m[col] = (i as Record<string, unknown>)[k];
      if (i.sizeSqm !== undefined) m.size_sqm = i.sizeSqm === null ? null : String(i.sizeSqm);
      const after = await trx.updateTable('room_type').set(m as never).where('id', '=', id).where('version', '=', i.version).returningAll().executeTakeFirst();
      if (!after) throw stale();
      await this.audit.record(trx, { action: 'room_type.update', resourceType: 'room_type', resourceId: id, propertyId, before: this.rtDto(before), after: this.rtDto(after) });
      return this.rtDto(after);
    });
  }
  async setRoomTypeAmenities(propertyId: string, roomTypeId: string, amenityIds: string[]) {
    return this.tdb.tx(async (trx) => {
      const rt = await trx.selectFrom('room_type').select('id').where('id', '=', roomTypeId).where('property_id', '=', propertyId).executeTakeFirst();
      if (!rt) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room type not found' });
      const ids = [...new Set(amenityIds)];
      await trx.deleteFrom('room_type_amenity').where('room_type_id', '=', roomTypeId).execute();
      if (ids.length) await trx.insertInto('room_type_amenity').values(ids.map((a) => ({ tenant_id: currentTenant().tenantId, room_type_id: roomTypeId, amenity_id: a }))).execute();
      await this.audit.record(trx, { action: 'room_type.set_amenities', resourceType: 'room_type', resourceId: roomTypeId, propertyId, after: { amenityIds: ids } });
      return { amenityIds: ids };
    });
  }

  // ───────────────────────── amenities (tenant catalogue) ─────────────────────────
  async createAmenity(i: z.infer<typeof S.CreateAmenity>) {
    return this.tdb.tx(async (trx) => {
      const a = await trx.insertInto('amenity').values({ tenant_id: currentTenant().tenantId, code: i.code, name_en: i.nameEn, name_ur: i.nameUr ?? null, category: i.category }).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'amenity.create', resourceType: 'amenity', resourceId: a.id, after: a });
      return { id: a.id, code: a.code, nameEn: a.name_en, nameUr: a.name_ur, category: a.category };
    });
  }
  async listAmenities() {
    const rows = await this.tdb.tx((trx) => trx.selectFrom('amenity').selectAll().orderBy('category').orderBy('name_en').execute());
    return rows.map((a) => ({ id: a.id, code: a.code, nameEn: a.name_en, nameUr: a.name_ur, category: a.category }));
  }

  // ───────────────────────── rooms ─────────────────────────
  private roomDto(r: any) {
    return { id: r.id, number: r.number, roomTypeId: r.room_type_id, floorId: r.floor_id, capacityOverride: r.capacity_override, bedConfig: r.bed_config, smoking: r.smoking,
      accessible: r.accessible, connectingRoomId: r.connecting_room_id, status: r.status, notes: r.notes, version: r.version };
  }
  /** Keeps availability in step with the room list. No-op before go-live (the horizon is built at go-live). */
  private async syncCapacity(trx: Trx, p: { id: string; status: string; business_date: string }, roomTypeIds: string[]) {
    if (p.status !== 'LIVE') return;
    for (const rt of new Set(roomTypeIds)) {
      await this.inv.ensureHorizon(trx, p.id, p.business_date, addDays(p.business_date, HORIZON_DAYS), rt);
      await this.inv.recomputePhysical(trx, p.id, rt, p.business_date);
    }
  }
  private async linkConnecting(trx: Trx, propertyId: string, roomId: string, otherId: string | null | undefined, prevOther?: string | null) {
    if (prevOther && prevOther !== otherId) await trx.updateTable('room').set({ connecting_room_id: null }).where('id', '=', prevOther).where('connecting_room_id', '=', roomId).execute();
    if (!otherId) return;
    const o = await trx.selectFrom('room').select(['id', 'connecting_room_id']).where('id', '=', otherId).where('property_id', '=', propertyId).executeTakeFirst();
    if (!o) throw new UnprocessableEntityException({ code: 'REFERENCE_INVALID', message: 'Connecting room not found in this property' });
    if (o.connecting_room_id && o.connecting_room_id !== roomId) throw new ConflictException({ code: 'ALREADY_CONNECTED', message: 'That room is already connected to another room' });
    await trx.updateTable('room').set({ connecting_room_id: roomId }).where('id', '=', otherId).execute();
  }
  async createRoom(propertyId: string, i: z.infer<typeof S.CreateRoom>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const r = await trx.insertInto('room').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, room_type_id: i.roomTypeId, floor_id: i.floorId ?? null, number: i.number,
        capacity_override: i.capacityOverride ?? null, bed_config: i.bedConfig ?? null, smoking: i.smoking, accessible: i.accessible, connecting_room_id: null, notes: i.notes ?? null }).returningAll().executeTakeFirstOrThrow();
      if (i.connectingRoomId) {
        await this.linkConnecting(trx, propertyId, r.id, i.connectingRoomId);
        await trx.updateTable('room').set({ connecting_room_id: i.connectingRoomId }).where('id', '=', r.id).execute();
      }
      await this.syncCapacity(trx, p, [i.roomTypeId]);
      await this.audit.record(trx, { action: 'room.create', resourceType: 'room', resourceId: r.id, propertyId, after: this.roomDto(r) });
      if (p.status === 'LIVE') await this.outbox.publish(trx, { aggregateType: 'room_type', aggregateId: i.roomTypeId, eventType: 'InventoryChanged', propertyId, payload: { reason: 'room_added' } });
      return this.roomDto({ ...r, connecting_room_id: i.connectingRoomId ?? null });
    });
  }
  /** Creates rooms 101…120 (etc.) in one transaction; any duplicate number aborts the whole batch. */
  async bulkRooms(propertyId: string, i: z.infer<typeof S.BulkRooms>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const numbers = Array.from({ length: i.to - i.from + 1 }, (_, k) => `${i.prefix}${i.from + k}`);
      const clash = await trx.selectFrom('room').select('number').where('property_id', '=', propertyId).where(sql<boolean>`lower(number) = any(${sql.val(numbers.map((n) => n.toLowerCase()))}::text[])`).execute();
      if (clash.length) throw new ConflictException({ code: 'DUPLICATE', message: `Room number(s) already exist: ${clash.map((c) => c.number).slice(0, 10).join(', ')}` });
      const rows = await trx.insertInto('room').values(numbers.map((n) => ({ tenant_id: currentTenant().tenantId, property_id: propertyId, room_type_id: i.roomTypeId, floor_id: i.floorId ?? null, number: n,
        capacity_override: null, bed_config: null, smoking: i.smoking, accessible: i.accessible, connecting_room_id: null, notes: null }))).returning(['id', 'number']).execute();
      await this.syncCapacity(trx, p, [i.roomTypeId]);
      await this.audit.record(trx, { action: 'room.bulk_create', resourceType: 'room', propertyId, after: { count: rows.length, first: numbers[0], last: numbers[numbers.length - 1], roomTypeId: i.roomTypeId } });
      if (p.status === 'LIVE') await this.outbox.publish(trx, { aggregateType: 'room_type', aggregateId: i.roomTypeId, eventType: 'InventoryChanged', propertyId, payload: { reason: 'rooms_added', count: rows.length } });
      return { created: rows.length, rooms: rows };
    });
  }
  async listRooms(propertyId: string, f: { roomTypeId?: string; floorId?: string; status?: string }) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      let q = trx.selectFrom('room').selectAll().where('property_id', '=', propertyId);
      if (f.roomTypeId) q = q.where('room_type_id', '=', f.roomTypeId);
      if (f.floorId) q = q.where('floor_id', '=', f.floorId);
      if (f.status) q = q.where('status', '=', f.status as 'ACTIVE' | 'INACTIVE');
      return (await q.orderBy(sql`lpad(regexp_replace(number, '\\D', '', 'g'), 8, '0')`).orderBy('number').execute()).map((r) => this.roomDto(r));
    });
  }
  async updateRoom(propertyId: string, id: string, i: z.infer<typeof S.UpdateRoom>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const before = await trx.selectFrom('room').selectAll().where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst();
      if (!before) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room not found' });
      const m: Record<string, unknown> = { version: sql`version + 1` };
      const map: Record<string, string> = { number: 'number', roomTypeId: 'room_type_id', floorId: 'floor_id', capacityOverride: 'capacity_override', bedConfig: 'bed_config', smoking: 'smoking', accessible: 'accessible', notes: 'notes', status: 'status' };
      for (const [k, col] of Object.entries(map)) if ((i as Record<string, unknown>)[k] !== undefined) m[col] = (i as Record<string, unknown>)[k];
      if (i.status === 'INACTIVE' && before.status === 'ACTIVE') {
        const open = await trx.selectFrom('room_block').select('id').where('room_id', '=', id).where('cancelled_at', 'is', null).where('end_date', '>', p.business_date).executeTakeFirst();
        if (open) throw new ConflictException({ code: 'ROOM_HAS_BLOCKS', message: 'Cancel this room\'s blocks before retiring it' });
        const assigned = await trx.selectFrom('room_assignment').select('id').where('room_id', '=', id).where('status', 'in', ['ASSIGNED', 'IN_HOUSE']).executeTakeFirst();
        if (assigned) throw new ConflictException({ code: 'ROOM_IN_USE', message: 'This room has current or future guests assigned. Move them first.' });
      }
      let after;
      try { after = await trx.updateTable('room').set(m as never).where('id', '=', id).where('version', '=', i.version).returningAll().executeTakeFirst(); }
      catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictException({ code: 'DUPLICATE_ROOM', message: `Another room already has the number ${i.number}` }); throw e; }
      if (!after) throw stale();
      if (i.connectingRoomId !== undefined) {
        await this.linkConnecting(trx, propertyId, id, i.connectingRoomId, before.connecting_room_id);
        await trx.updateTable('room').set({ connecting_room_id: i.connectingRoomId ?? null }).where('id', '=', id).execute();
      }
      await this.syncCapacity(trx, p, [before.room_type_id, after.room_type_id]);
      await this.audit.record(trx, { action: 'room.update', resourceType: 'room', resourceId: id, propertyId, before: this.roomDto(before), after: this.roomDto(after) });
      if (p.status === 'LIVE' && (before.status !== after.status || before.room_type_id !== after.room_type_id)) {
        await this.outbox.publish(trx, { aggregateType: 'room_type', aggregateId: after.room_type_id, eventType: 'InventoryChanged', propertyId, payload: { reason: 'room_changed' } });
      }
      return this.roomDto({ ...after, connecting_room_id: i.connectingRoomId !== undefined ? i.connectingRoomId ?? null : after.connecting_room_id });
    });
  }

  // ───────────────────────── blocks ─────────────────────────
  private blockDto(b: any) { return { id: b.id, roomId: b.room_id, type: b.block_type, startDate: b.start_date, endDate: b.end_date, reason: b.reason, ticketRef: b.ticket_ref, cancelledAt: b.cancelled_at }; }

  async createBlock(propertyId: string, userId: string, i: z.infer<typeof S.CreateBlock>) {
    if (i.endDate <= i.startDate) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'endDate must be after startDate' });
    if (i.acknowledgeOversell) {
      const d = await this.authz.check(userId, { permission: 'inventory.overbook', scope: { propertyId } });
      if (d.effect !== 'ALLOW') throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Acknowledging an oversell needs the overbooking permission' });
    }
    return this.tdb.tx((trx) => this.createBlockIn(trx, propertyId, userId, i));
  }
  /** Inside the caller's transaction (a work order takes a room out of order atomically). The caller has checked the oversell permission. */
  async createBlockIn(trx: Trx, propertyId: string, userId: string, i: z.infer<typeof S.CreateBlock>) {
    {
      const p = await this.prop(trx, propertyId);
      if (p.status !== 'LIVE') throw new UnprocessableEntityException({ code: 'PROPERTY_NOT_LIVE', message: 'Blocks apply once the property is live' });
      if (i.startDate < p.business_date) throw new UnprocessableEntityException({ code: 'DATE_IN_PAST', message: `A block must start on or after the business date (${p.business_date})` });
      nightsOf(i.startDate, i.endDate, 3660);
      const room = await trx.selectFrom('room').select(['id', 'room_type_id', 'status']).where('id', '=', i.roomId).where('property_id', '=', propertyId).executeTakeFirst();
      if (!room) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room not found' });
      if (room.status !== 'ACTIVE') throw new UnprocessableEntityException({ code: 'ROOM_INACTIVE', message: 'This room is retired' });
      await this.inv.ensureHorizon(trx, propertyId, p.business_date, i.endDate > addDays(p.business_date, HORIZON_DAYS) ? i.endDate : addDays(p.business_date, HORIZON_DAYS), room.room_type_id);
      const b = await trx.insertInto('room_block').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, room_id: i.roomId, block_type: i.type, start_date: i.startDate, end_date: i.endDate,
        reason: i.reason, ticket_ref: i.ticketRef ?? null, created_by: userId, cancelled_at: null }).returningAll().executeTakeFirstOrThrow();
      const r = await this.inv.applyBlock(trx, { propertyId, roomTypeId: room.room_type_id, type: i.type, from: i.startDate, to: i.endDate, delta: 1, allowOversell: i.acknowledgeOversell });
      await this.audit.record(trx, { action: 'room_block.create', resourceType: 'room_block', resourceId: b.id, propertyId, after: { ...this.blockDto(b), oversoldDates: r.oversoldDates }, reasonCode: i.acknowledgeOversell ? 'OVERSELL_ACKNOWLEDGED' : undefined, note: i.reason });
      await this.outbox.publish(trx, { aggregateType: 'room_type', aggregateId: room.room_type_id, eventType: 'InventoryChanged', propertyId, payload: { reason: 'block_created', from: i.startDate, to: i.endDate } });
      return { ...this.blockDto(b), oversoldDates: r.oversoldDates };
    }
  }
  async listBlocks(propertyId: string, includeCancelled = false) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      let q = trx.selectFrom('room_block').selectAll().where('property_id', '=', propertyId);
      if (!includeCancelled) q = q.where('cancelled_at', 'is', null);
      return (await q.orderBy('start_date').execute()).map((b) => this.blockDto(b));
    });
  }
  /** Ends a block early (room returns to inventory from `endDate`) or cancels it entirely when endDate <= startDate. */
  async endBlock(propertyId: string, id: string, endDate: string | null) {
    return this.tdb.tx((trx) => this.endBlockIn(trx, propertyId, id, endDate));
  }
  async endBlockIn(trx: Trx, propertyId: string, id: string, endDate: string | null) {
    {
      const p = await this.prop(trx, propertyId);
      const b = await trx.selectFrom('room_block').selectAll().where('id', '=', id).where('property_id', '=', propertyId).where('cancelled_at', 'is', null).executeTakeFirst();
      if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Active block not found' });
      const room = await trx.selectFrom('room').select('room_type_id').where('id', '=', b.room_id).executeTakeFirstOrThrow();
      const newEnd = endDate === null || endDate <= b.start_date ? null : endDate;
      if (newEnd !== null && newEnd >= b.end_date) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'New end date must be earlier than the current end date' });
      const releaseFrom = newEnd ?? b.start_date;
      const from = releaseFrom < p.business_date ? p.business_date : releaseFrom;     // past nights are history; counters only matter from the business date on
      if (from < b.end_date) await this.inv.applyBlock(trx, { propertyId, roomTypeId: room.room_type_id, type: b.block_type, from, to: b.end_date, delta: -1 });
      const after = newEnd === null
        ? await trx.updateTable('room_block').set({ cancelled_at: sql`now()` as never }).where('id', '=', id).returningAll().executeTakeFirstOrThrow()
        : await trx.updateTable('room_block').set({ end_date: newEnd }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: newEnd === null ? 'room_block.cancel' : 'room_block.shorten', resourceType: 'room_block', resourceId: id, propertyId, before: this.blockDto(b), after: this.blockDto(after) });
      await this.outbox.publish(trx, { aggregateType: 'room_type', aggregateId: room.room_type_id, eventType: 'InventoryChanged', propertyId, payload: { reason: 'block_released', from } });
      return this.blockDto(after);
    }
  }

  // ───────────────────────── availability ─────────────────────────
  async availability(propertyId: string, from: string, to: string) {
    return this.tdb.tx(async (trx) => { await this.prop(trx, propertyId); return { roomTypes: await this.inv.getAvailability(trx, propertyId, from, to) }; });
  }
  async setOverbook(propertyId: string, roomTypeId: string, i: z.infer<typeof S.SetOverbook>) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const rt = await trx.selectFrom('room_type').select('id').where('id', '=', roomTypeId).where('property_id', '=', propertyId).executeTakeFirst();
      if (!rt) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room type not found' });
      const n = await this.inv.setOverbookLimit(trx, { propertyId, roomTypeId, from: i.from, to: i.to, limit: i.limit });
      await this.audit.record(trx, { action: 'inventory.set_overbook', resourceType: 'room_type', resourceId: roomTypeId, propertyId, after: { ...i, nights: n }, reasonCode: 'OVERBOOK_POLICY' });
      await this.outbox.publish(trx, { aggregateType: 'room_type', aggregateId: roomTypeId, eventType: 'InventoryChanged', propertyId, payload: { reason: 'overbook_limit', from: i.from, to: i.to } });
      return { nightsUpdated: n };
    });
  }
  async invariants(propertyId: string) {
    return this.tdb.tx(async (trx) => { await this.prop(trx, propertyId); return { issues: await this.inv.checkInvariants(trx, propertyId) }; });
  }
}
