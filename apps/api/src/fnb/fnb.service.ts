import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { fmt, type Trx } from '../companies/companies.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { FolioService } from '../folio/folio.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { nowAt, whyNot, type Why } from '../menu/menu.service.js';
import type * as S from './schemas.js';

const WHY: Record<Why, string> = { INACTIVE: 'is not available', OUTLET_CLOSED: 'is from an outlet that is closed', MENU_CLOSED: 'is on a menu that is not in use', NOT_TODAY: 'is not served today', NOT_NOW: 'is not served at this hour', SOLD_OUT: 'is sold out', NONE_LEFT: 'has none left', CATEGORY_GONE: 'is not available' };

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
type Order = Awaited<ReturnType<FnbService['row']>>;

/** Room service and kitchen: a menu, orders for guests who are in the house, a queue for the kitchen, and the charge on the guest's bill when the food is delivered. */
@Injectable()
export class FnbService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(FolioService) private readonly folios: FolioService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  private async can(userId: string, permission: string, propertyId: string) { return (await this.authz.check(userId, { permission, scope: { propertyId } })).effect === 'ALLOW'; }

  // ───────────── the menu ─────────────
  private item(m: { id: string; category: string; name: string; name_ur: string | null; price_minor: string; active: boolean; sort_order: number; version: number }, cur: string) {
    return { id: m.id, category: m.category, name: m.name, nameUr: m.name_ur, price: fmt(m.price_minor, cur), active: m.active, sortOrder: m.sort_order, version: m.version };
  }
  async menu(propertyId: string, all: boolean) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      let q = trx.selectFrom('menu_item').selectAll().where('property_id', '=', propertyId).orderBy('category').orderBy('sort_order').orderBy('name');
      if (!all) q = q.where('active', '=', true);
      return { items: (await q.execute()).map((m) => this.item(m as never, p.currency)) };
    });
  }
  async createItem(propertyId: string, userId: string, i: z.infer<typeof S.CreateItem>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      try {
        const m = await trx.insertInto('menu_item').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, category: i.category, name: i.name, name_ur: i.nameUr ?? null, price_minor: Money.parse(i.price, p.currency).minor.toString(), sort_order: i.sortOrder } as never).returningAll().executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'fnb.menu_create', resourceType: 'menu_item', resourceId: m.id, propertyId, after: { name: i.name, price: i.price } });
        return this.item(m as never, p.currency);
      } catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE', `"${i.name}" is already on the menu`); throw e; }
    });
  }
  async updateItem(propertyId: string, id: string, userId: string, i: z.infer<typeof S.UpdateItem>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const cur = await trx.selectFrom('menu_item').selectAll().where('id', '=', id).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Menu item not found' });
      if (cur.version !== i.version) throw fail(412, 'VERSION_CONFLICT', 'Someone else changed this item. Reload and try again.');
      const m: Record<string, unknown> = {};
      if (i.category !== undefined) m.category = i.category; if (i.name !== undefined) m.name = i.name; if (i.nameUr !== undefined) m.name_ur = i.nameUr; if (i.sortOrder !== undefined) m.sort_order = i.sortOrder; if (i.active !== undefined) m.active = i.active;
      if (i.price !== undefined) m.price_minor = Money.parse(i.price, p.currency).minor.toString();
      try {
        const u = await trx.updateTable('menu_item').set({ ...m, version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'fnb.menu_update', resourceType: 'menu_item', resourceId: id, propertyId, before: { price: cur.price_minor, active: cur.active }, after: { price: u.price_minor, active: u.active } });
        return this.item(u as never, p.currency);
      } catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE', 'Another item has that name'); throw e; }
    });
  }

  // ───────────── who is in the house ─────────────
  async inHouse(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      const rows = await sql<{ line_id: string; reservation_id: string; room: string; guest: string; confirmation_no: string; folio_status: string | null }>`
        SELECT l.id AS line_id, l.reservation_id, rm.number AS room, g.full_name AS guest, r.confirmation_no, f.status AS folio_status
        FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id
        JOIN room_assignment a ON a.assignment_ref = l.id AND a.status = 'IN_HOUSE' JOIN room rm ON rm.id = a.room_id
        LEFT JOIN folio f ON f.tenant_id = r.tenant_id AND f.reservation_id = r.id AND f.folio_type = 'GUEST' AND f.status <> 'VOID'
        WHERE l.tenant_id = ${currentTenant().tenantId} AND l.property_id = ${propertyId} AND l.status = 'CHECKED_IN' ORDER BY lpad(regexp_replace(rm.number, '\\D', '', 'g'), 8, '0'), rm.number`.execute(trx);
      return { items: rows.rows.map((r) => ({ reservationRoomId: r.line_id, reservationId: r.reservation_id, room: r.room, guest: r.guest, confirmationNo: r.confirmation_no })) };
    });
  }

  // ───────────── orders ─────────────
  async row(trx: Trx, propertyId: string, id: string, lock = false) {
    let q = trx.selectFrom('fnb_order').selectAll().where('id', '=', id).where('property_id', '=', propertyId);
    if (lock) q = q.forUpdate();
    const o = await q.executeTakeFirst();
    if (!o) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found' });
    return o;
  }
  private async view(trx: Trx, o: Order) {
    const lines = await trx.selectFrom('fnb_order_line').selectAll().where('order_id', '=', o.id).orderBy('name').execute();
    return { id: o.id, number: o.number, payDigitally: o.pay_digital, status: o.status, room: o.room_number, guest: o.guest_name, reservationId: o.reservation_id, note: o.note, total: fmt(o.total_minor, o.currency), createdAt: o.created_at, readyAt: o.ready_at, deliveredAt: o.delivered_at,
      businessDate: o.business_date, cancelReason: o.cancel_reason, version: o.version, lines: lines.map((l) => ({ id: l.id, name: l.name, variant: l.variant_name, modifiers: l.modifiers, removed: l.removed, quantity: l.quantity, unitPrice: fmt(l.unit_price_minor, o.currency), total: fmt(l.line_minor, o.currency), note: l.note, posted: !!l.posting_id })) };
  }
  async create(propertyId: string, userId: string, i: z.infer<typeof S.CreateOrder>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId);
      const row = await sql<{ id: string; reservation_id: string; room: string; guest: string }>`
        SELECT l.id, l.reservation_id, rm.number AS room, g.full_name AS guest FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id
        JOIN room_assignment a ON a.assignment_ref = l.id AND a.status = 'IN_HOUSE' JOIN room rm ON rm.id = a.room_id
        WHERE l.tenant_id = ${currentTenant().tenantId} AND l.property_id = ${propertyId} AND l.id = ${i.reservationRoomId} AND l.status = 'CHECKED_IN'`.execute(trx);
      const stay = row.rows[0];
      if (!stay) throw fail(422, 'NOT_IN_HOUSE', 'Room service is only for guests who are in the house');
      const folio = await this.folios.ensureGuestFolio(trx, propertyId, stay.reservation_id);
      if (folio.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'This guest’s bill is closed');
      const ids = [...new Set(i.lines.map((l) => l.menuItemId))];
      const items = await trx.selectFrom('menu_item').selectAll().where('property_id', '=', propertyId).where('id', 'in', ids).execute();
      const byId = new Map(items.map((m) => [m.id, m]));
      const tz = (await trx.selectFrom('property').select('timezone').where('id', '=', propertyId).executeTakeFirstOrThrow()).timezone;
      const now = nowAt(this.clock.now(), tz);
      const catIds = items.map((m) => m.category_id).filter((x): x is string => !!x);
      const cats = catIds.length ? await trx.selectFrom('menu_category').select(['id', 'menu_id']).where('id', 'in', catIds).execute() : [];
      const menuIds = [...new Set(cats.map((c) => c.menu_id))];
      const menus = menuIds.length ? await trx.selectFrom('menu').selectAll().where('id', 'in', menuIds).execute() : [];
      const outlets = menus.length ? await trx.selectFrom('outlet').selectAll().where('id', 'in', [...new Set(menus.map((m) => m.outlet_id))]).execute() : [];
      const variants = await trx.selectFrom('menu_item_variant').selectAll().where('item_id', 'in', ids).where('active', '=', true).execute();
      const links = await trx.selectFrom('menu_item_modifier_group').select(['item_id', 'group_id']).where('item_id', 'in', ids).execute();
      const groups = links.length ? await trx.selectFrom('modifier_group').selectAll().where('id', 'in', [...new Set(links.map((x) => x.group_id))]).where('active', '=', true).execute() : [];
      const options = groups.length ? await trx.selectFrom('modifier_option').selectAll().where('group_id', 'in', groups.map((g) => g.id)).where('active', '=', true).execute() : [];
      const asked = new Map<string, number>(); let outletId: string | null = null;
      let total = 0n; const lines = i.lines.map((l) => {
        const m = byId.get(l.menuItemId);
        if (!m) throw fail(422, 'MENU_ITEM_INVALID', 'An item is not on this menu');
        const menu = menus.find((x) => x.id === cats.find((c) => c.id === m.category_id)?.menu_id);
        const outlet = outlets.find((o) => o.id === menu?.outlet_id);
        if (outlet) outletId ??= outlet.id;
        const why = whyNot(m as never, menu as never, outlet, now);
        if (why) throw fail(422, why === 'INACTIVE' ? 'MENU_ITEM_UNAVAILABLE' : 'ITEM_NOT_ORDERABLE', `"${m.name}" ${WHY[why]}`);
        if (l.quantity < m.min_quantity) throw fail(422, 'QUANTITY_TOO_LOW', `"${m.name}" must be ordered at least ${m.min_quantity} at a time`);
        if (m.max_quantity && l.quantity > m.max_quantity) throw fail(422, 'QUANTITY_TOO_HIGH', `"${m.name}" can be ordered at most ${m.max_quantity} at a time`);
        if (l.note && !m.special_instructions) throw fail(422, 'NOTE_NOT_ALLOWED', `"${m.name}" does not take special instructions`);
        const sizes = variants.filter((v) => v.item_id === m.id);
        const size = l.variantId ? sizes.find((v) => v.id === l.variantId) : undefined;
        if (l.variantId && !size) throw fail(422, 'VARIANT_INVALID', `That size is not offered for "${m.name}"`);
        if (!size && sizes.length) throw fail(422, 'VARIANT_REQUIRED', `Choose a size for "${m.name}"`);
        const attached = groups.filter((g) => links.some((x) => x.item_id === m.id && x.group_id === g.id));
        const picked = l.modifierOptionIds.map((id) => options.find((o) => o.id === id && attached.some((g) => g.id === o.group_id)));
        if (picked.some((o) => !o)) throw fail(422, 'OPTION_INVALID', `An option is not offered for "${m.name}"`);
        if (new Set(l.modifierOptionIds).size !== l.modifierOptionIds.length) throw fail(422, 'OPTION_INVALID', 'An option was chosen twice');
        for (const g of attached) {
          const n = picked.filter((o) => o!.group_id === g.id).length;
          if (n < g.min_select) throw fail(422, 'OPTION_REQUIRED', `Choose ${g.min_select === 1 ? 'one' : `at least ${g.min_select}`} for "${g.name}" on "${m.name}"`);
          if (n > g.max_select) throw fail(422, 'OPTION_TOO_MANY', `"${g.name}" on "${m.name}" allows at most ${g.max_select}`);
        }
        const can = new Set(m.removable_ingredients ?? []);
        const bad = l.removed.find((r) => !can.has(r));
        if (bad) throw fail(422, 'CANNOT_REMOVE', `"${bad}" cannot be left out of "${m.name}"`);
        const unit = BigInt(size ? size.price_minor : m.discounted_price_minor ?? m.price_minor) + picked.reduce((a, o) => a + BigInt(o!.price_delta_minor), 0n);
        const lineMinor = unit * BigInt(l.quantity); total += lineMinor;
        if (m.availability === 'LIMITED') asked.set(m.id, (asked.get(m.id) ?? 0) + l.quantity);
        return { menuItemId: m.id, name: m.name, variant: size?.name ?? null, modifiers: picked.map((o) => ({ name: o!.name, price: o!.price_delta_minor })), removed: l.removed, quantity: l.quantity, unit, lineMinor, note: l.note ?? null };
      });
      for (const [id, q] of asked) {                                              // a limited dish is counted down atomically, so two waiters cannot both take the last one
        const r = await sql`UPDATE menu_item SET limited_quantity = limited_quantity - ${q} WHERE id = ${id} AND availability = 'LIMITED' AND limited_quantity >= ${q}`.execute(trx);
        if (!Number(r.numAffectedRows)) throw fail(409, 'ITEM_NOT_ORDERABLE', `"${byId.get(id)!.name}" does not have ${q} left`);
      }
      const seq = (await sql<{ v: string }>`INSERT INTO property_counter (tenant_id, property_id, name, value) VALUES (${currentTenant().tenantId}, ${propertyId}, 'fnb', 1)
        ON CONFLICT (tenant_id, property_id, name) DO UPDATE SET value = property_counter.value + 1 RETURNING value::text AS v`.execute(trx)).rows[0]!.v;
      const o = await trx.insertInto('fnb_order').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, number: `${p.code}-FB${seq.padStart(5, '0')}`, reservation_id: stay.reservation_id, reservation_room_id: stay.id, folio_id: folio.id,
        room_number: stay.room, guest_name: stay.guest, note: i.note ?? null, pay_digital: i.payDigitally, total_minor: total.toString(), currency: p.currency, created_by: userId, outlet_id: outletId } as never).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('fnb_order_line').values(lines.map((l) => ({ tenant_id: currentTenant().tenantId, order_id: o.id, menu_item_id: l.menuItemId, name: l.name, quantity: l.quantity, unit_price_minor: l.unit.toString(), line_minor: l.lineMinor.toString(), note: l.note, variant_name: l.variant, modifiers: JSON.stringify(l.modifiers), removed: l.removed })) as never).execute();
      await this.audit.record(trx, { action: 'fnb.order_create', resourceType: 'fnb_order', resourceId: o.id, propertyId, after: { number: o.number, room: stay.room, total: total.toString() } });
      await this.outbox.publish(trx, { aggregateType: 'fnb_order', aggregateId: o.id, eventType: 'FnbOrderPlaced', propertyId, businessDate: p.business_date, payload: { orderId: o.id, number: o.number, room: stay.room } });
      return this.view(trx, o);
    });
  }

  private async move(propertyId: string, id: string, userId: string, action: string, fn: (trx: Trx, o: Order, bd: string, manager: boolean) => Promise<Record<string, unknown>>, need: 'manage' | 'order') {
    const manager = await this.can(userId, 'fnb.manage', propertyId);
    if (need === 'manage' && !manager) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'This action needs the "fnb.manage" permission' });
    return this.tdb.tx(async (trx) => {
      const o = await this.row(trx, propertyId, id, true);
      const p = await this.folios.property(trx, propertyId);
      const set = await fn(trx, o, p.business_date, manager);
      const u = await trx.updateTable('fnb_order').set({ ...set, version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: `fnb.order_${action}`, resourceType: 'fnb_order', resourceId: id, propertyId, before: { status: o.status }, after: { status: u.status } });
      await this.outbox.publish(trx, { aggregateType: 'fnb_order', aggregateId: id, eventType: 'FnbOrderChanged', propertyId, businessDate: p.business_date, payload: { orderId: id, number: o.number, from: o.status, to: u.status } });
      return this.view(trx, u);
    });
  }
  private wrong(o: Order) { return fail(409, 'WRONG_STATE', `An order that is ${o.status.toLowerCase()} cannot be changed this way`); }
  prepare(pid: string, id: string, userId: string) { return this.move(pid, id, userId, 'prepare', async (_t, o) => { if (o.status !== 'NEW') throw this.wrong(o); return { status: 'PREPARING', prepared_at: new Date(this.clock.now()) }; }, 'manage'); }
  ready(pid: string, id: string, userId: string) { return this.move(pid, id, userId, 'ready', async (_t, o) => { if (o.status !== 'NEW' && o.status !== 'PREPARING') throw this.wrong(o); return { status: 'READY', ready_at: new Date(this.clock.now()) }; }, 'manage'); }
  cancel(pid: string, id: string, userId: string, reason: string) {
    return this.move(pid, id, userId, 'cancel', async (trx, o) => {
      if (o.status === 'DELIVERED') throw fail(409, 'ALREADY_DELIVERED', 'This order is already on the guest’s bill. Reverse the charges on the bill instead.');
      if (o.status === 'CANCELLED') throw this.wrong(o);
      const back = await trx.selectFrom('fnb_order_line').select(['menu_item_id', 'quantity']).where('order_id', '=', o.id).execute();
      for (const l of back) await sql`UPDATE menu_item SET limited_quantity = limited_quantity + ${l.quantity} WHERE id = ${l.menu_item_id} AND availability = 'LIMITED'`.execute(trx);
      return { status: 'CANCELLED', cancel_reason: reason, cancelled_by: userId };
    }, 'order');
  }
  /** Handing the food over puts it on the guest's bill — one charge per item, taxed like any other charge. */
  deliver(pid: string, id: string, userId: string) {
    return this.move(pid, id, userId, 'deliver', async (trx, o, bd, manager) => {
      if (o.status === 'DELIVERED' || o.status === 'CANCELLED') throw this.wrong(o);
      if (o.status !== 'READY' && !manager) throw fail(409, 'NOT_READY', 'The kitchen has not marked this order ready');
      const f = await this.folios.folioRow(trx, pid, o.folio_id, true);
      if (f.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'This guest’s bill is closed');
      const lines = await trx.selectFrom('fnb_order_line').selectAll().where('order_id', '=', o.id).execute();
      for (const l of lines) {
        const amount = BigInt(l.line_minor);
        if (amount === 0n) continue;                                              // a complimentary item has nothing to charge
        const postingId = await this.folios.post(trx, { folioId: o.folio_id, propertyId: pid, currency: o.currency, type: 'CHARGE', txnCode: o.pay_digital ? 'FNB_DIGITAL' : 'FNB', amount, quantity: l.quantity, unitPrice: BigInt(l.unit_price_minor), businessDate: bd, sourceType: 'FNB_ORDER', sourceRef: l.id,
          lineId: o.reservation_room_id, description: `${o.number} · ${l.name}`, idempotencyKey: `fnb:${o.id}:${l.id}`, userId });
        await trx.updateTable('fnb_order_line').set({ posting_id: postingId } as never).where('id', '=', l.id).execute();
      }
      return { status: 'DELIVERED', delivered_at: new Date(this.clock.now()), delivered_by: userId, business_date: bd };
    }, 'order');
  }

  async queue(propertyId: string, q: z.infer<typeof S.QueueQuery>) {
    return this.tdb.tx(async (trx) => {
      let qb = trx.selectFrom('fnb_order').selectAll().where('property_id', '=', propertyId).orderBy('created_at', q.status === 'OPEN' ? 'asc' : 'desc').limit(q.limit);      // the kitchen sees the oldest first; history, the newest
      if (q.status === 'OPEN') qb = qb.where('status', 'in', ['NEW', 'PREPARING', 'READY']); else if (q.status !== 'ALL') qb = qb.where('status', '=', q.status);
      const rows = await qb.execute(); const items = []; for (const o of rows) items.push(await this.view(trx, o));
      return { items };
    });
  }
  async forReservation(propertyId: string, reservationId: string) {
    return this.tdb.tx(async (trx) => {
      const rows = await trx.selectFrom('fnb_order').selectAll().where('property_id', '=', propertyId).where('reservation_id', '=', reservationId).orderBy('created_at').execute();
      const items = []; for (const o of rows) items.push(await this.view(trx, o));
      return { items };
    });
  }
}
