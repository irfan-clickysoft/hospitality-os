import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { fmt, type Trx } from '../companies/companies.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { MediaService, mediaUrl } from '../media/media.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
/** Day of week (1 Monday … 7 Sunday) and the time of day at the property right now. */
export function nowAt(ms: number, tz: string): { dow: number; hhmm: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { dow: DOW[p.weekday!] ?? 1, hhmm: `${p.hour}:${p.minute}` };
}
/** Whether a time falls in a window; a window that ends before it starts runs past midnight. */
export const inWindow = (hhmm: string, from: string, to: string) => { const f = from.slice(0, 5), t = to.slice(0, 5); return f <= t ? hhmm >= f && hhmm < t : hhmm >= f || hhmm < t; };

export type Why = 'INACTIVE' | 'OUTLET_CLOSED' | 'MENU_CLOSED' | 'NOT_TODAY' | 'NOT_NOW' | 'SOLD_OUT' | 'NONE_LEFT' | 'CATEGORY_GONE';
interface ItemRow { active: boolean; availability: string; limited_quantity: number | null; days: number[] | null; available_from: string | null; available_to: string | null }
interface MenuRow { status: string; days: number[]; available_from: string | null; available_to: string | null }
/** Why an item cannot be ordered at this moment, or null when it can. */
export function whyNot(item: ItemRow, menu: MenuRow | undefined, outlet: { status: string } | undefined, now: { dow: number; hhmm: string }): Why | null {
  if (!item.active) return 'INACTIVE';
  if (!menu || !outlet) return null;                                       // an item from the older flat menu has no menu around it
  if (outlet.status !== 'ACTIVE') return 'OUTLET_CLOSED';
  if (menu.status !== 'ACTIVE') return 'MENU_CLOSED';
  if (!menu.days.includes(now.dow)) return 'NOT_TODAY';
  if (menu.available_from && menu.available_to && !inWindow(now.hhmm, menu.available_from, menu.available_to)) return 'NOT_NOW';
  if (item.days && !item.days.includes(now.dow)) return 'NOT_TODAY';
  if (item.available_from && item.available_to && !inWindow(now.hhmm, item.available_from, item.available_to)) return 'NOT_NOW';
  if (item.availability === 'SOLD_OUT') return 'SOLD_OUT';
  if (item.availability === 'LIMITED' && (item.limited_quantity ?? 0) <= 0) return 'NONE_LEFT';
  return null;
}

type ItemFull = Awaited<ReturnType<MenuService['itemRow']>>;

/** Outlets, menus, categories and the items on them — everything about a dish a guest or the kitchen needs to know. */
@Injectable()
export class MenuService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(MediaService) private readonly media: MediaService, @Inject(CLOCK) private readonly clock: ClockLike) {}

  private async prop(trx: Trx, id: string) {
    const p = await trx.selectFrom('property').select(['id', 'code', 'currency', 'timezone']).where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return p;
  }
  private async outletRow(trx: Trx, propertyId: string, id: string) {
    const o = await trx.selectFrom('outlet').selectAll().where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst();
    if (!o) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Outlet not found' });
    return o;
  }
  private async menuRow(trx: Trx, propertyId: string, id: string) {
    const m = await trx.selectFrom('menu as m').innerJoin('outlet as o', 'o.id', 'm.outlet_id').selectAll('m').where('m.id', '=', id).where('o.property_id', '=', propertyId).executeTakeFirst();
    if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Menu not found' });
    return m;
  }
  private async categoryRow(trx: Trx, propertyId: string, id: string) {
    const c = await trx.selectFrom('menu_category as c').innerJoin('menu as m', 'm.id', 'c.menu_id').innerJoin('outlet as o', 'o.id', 'm.outlet_id').selectAll('c').where('c.id', '=', id).where('o.property_id', '=', propertyId).executeTakeFirst();
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Category not found' });
    return c;
  }
  async itemRow(trx: Trx, propertyId: string, id: string, lock = false) {
    let q = trx.selectFrom('menu_item').selectAll().where('id', '=', id).where('property_id', '=', propertyId);
    if (lock) q = q.forUpdate();
    const m = await q.executeTakeFirst();
    if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Menu item not found' });
    return m;
  }
  private dup(e: unknown, what: string): never {
    const c = (e as { code?: string }).code;
    if (c === '23505') throw fail(409, 'DUPLICATE', `${what} with that name already exists`);
    if (c === '23514') throw fail(422, 'VALIDATION_FAILED', 'One of the values is outside its allowed range');
    throw e;
  }

  /** The earlier flat menu is gathered into a "Room service" outlet the first time the new menu is opened, so nothing already on it is lost. */
  private async adoptLegacy(trx: Trx, propertyId: string) {
    const loose = await trx.selectFrom('menu_item').select(['id', 'category']).where('property_id', '=', propertyId).where('category_id', 'is', null).execute();
    if (!loose.length) return;
    const t = currentTenant().tenantId;
    let outlet = await trx.selectFrom('outlet').select('id').where('property_id', '=', propertyId).where('kind', '=', 'ROOM_SERVICE').orderBy('created_at').executeTakeFirst();
    if (!outlet) outlet = await trx.insertInto('outlet').values({ tenant_id: t, property_id: propertyId, name: 'Room service', kind: 'ROOM_SERVICE' } as never).onConflict((oc) => oc.doNothing()).returning('id').executeTakeFirst()
      ?? await trx.selectFrom('outlet').select('id').where('property_id', '=', propertyId).where(sql`lower(btrim(name))`, '=', 'room service').executeTakeFirstOrThrow();
    let menu = await trx.selectFrom('menu').select('id').where('outlet_id', '=', outlet.id).orderBy('sort_order').executeTakeFirst();
    if (!menu) menu = await trx.insertInto('menu').values({ tenant_id: t, outlet_id: outlet.id, name: 'Main menu' } as never).returning('id').executeTakeFirstOrThrow();
    const cats = new Map<string, string>();
    for (const c of await trx.selectFrom('menu_category').select(['id', 'name']).where('menu_id', '=', menu.id).execute()) cats.set(c.name.toLowerCase(), c.id);
    for (const it of loose) {
      const key = it.category.trim().toLowerCase();
      let cid = cats.get(key);
      if (!cid) { cid = (await trx.insertInto('menu_category').values({ tenant_id: t, menu_id: menu.id, name: it.category.trim() } as never).returning('id').executeTakeFirstOrThrow()).id; cats.set(key, cid); }
      await trx.updateTable('menu_item').set({ category_id: cid } as never).where('id', '=', it.id).execute();
    }
  }

  // ───────────── outlets ─────────────
  async outlets(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      await this.adoptLegacy(trx, propertyId);
      const rows = await trx.selectFrom('outlet').selectAll().where('property_id', '=', propertyId).orderBy('sort_order').orderBy('name').execute();
      const counts = await sql<{ outlet_id: string; menus: number; items: number }>`SELECT m.outlet_id, count(DISTINCT m.id)::int AS menus, count(i.id)::int AS items FROM menu m LEFT JOIN menu_category c ON c.tenant_id = m.tenant_id AND c.menu_id = m.id
        LEFT JOIN menu_item i ON i.tenant_id = c.tenant_id AND i.category_id = c.id AND i.active WHERE m.tenant_id = ${currentTenant().tenantId} GROUP BY m.outlet_id`.execute(trx);
      return { items: rows.map((o) => ({ id: o.id, name: o.name, kind: o.kind, description: o.description, openingNote: o.opening_note, status: o.status, sortOrder: o.sort_order, menus: counts.rows.find((c) => c.outlet_id === o.id)?.menus ?? 0, items: counts.rows.find((c) => c.outlet_id === o.id)?.items ?? 0 })) };
    });
  }
  async createOutlet(propertyId: string, userId: string, i: z.infer<typeof S.CreateOutlet>) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      try {
        const o = await trx.insertInto('outlet').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, name: i.name, kind: i.kind, description: i.description ?? null, opening_note: i.openingNote ?? null, sort_order: i.sortOrder } as never).returning('id').executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'menu.outlet_create', resourceType: 'outlet', resourceId: o.id, propertyId, after: { name: i.name, kind: i.kind } });
        return { id: o.id };
      } catch (e) { return this.dup(e, 'An outlet'); }
    });
  }
  async updateOutlet(propertyId: string, id: string, userId: string, i: z.infer<typeof S.UpdateOutlet>) {
    return this.tdb.tx(async (trx) => {
      await this.outletRow(trx, propertyId, id);
      const m: Record<string, unknown> = {};
      if (i.name !== undefined) m.name = i.name; if (i.kind !== undefined) m.kind = i.kind; if (i.description !== undefined) m.description = i.description; if (i.openingNote !== undefined) m.opening_note = i.openingNote; if (i.status !== undefined) m.status = i.status; if (i.sortOrder !== undefined) m.sort_order = i.sortOrder;
      if (!Object.keys(m).length) throw fail(422, 'VALIDATION_FAILED', 'Nothing to change');
      try { await trx.updateTable('outlet').set(m as never).where('id', '=', id).execute(); } catch (e) { return this.dup(e, 'An outlet'); }
      await this.audit.record(trx, { action: 'menu.outlet_update', resourceType: 'outlet', resourceId: id, propertyId, after: m });
      return { id };
    });
  }

  // ───────────── menus and categories ─────────────
  async createMenu(propertyId: string, outletId: string, userId: string, i: z.infer<typeof S.CreateMenu>) {
    return this.tdb.tx(async (trx) => {
      await this.outletRow(trx, propertyId, outletId);
      try {
        const m = await trx.insertInto('menu').values({ tenant_id: currentTenant().tenantId, outlet_id: outletId, name: i.name, days: i.days as never, available_from: i.availableFrom ?? null, available_to: i.availableTo ?? null, sort_order: i.sortOrder } as never).returning('id').executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'menu.menu_create', resourceType: 'menu', resourceId: m.id, propertyId, after: { name: i.name } });
        return { id: m.id };
      } catch (e) { return this.dup(e, 'A menu'); }
    });
  }
  async updateMenu(propertyId: string, id: string, userId: string, i: z.infer<typeof S.UpdateMenu>) {
    return this.tdb.tx(async (trx) => {
      const cur = await this.menuRow(trx, propertyId, id);
      const m: Record<string, unknown> = {};
      if (i.name !== undefined) m.name = i.name; if (i.days !== undefined) m.days = i.days; if (i.availableFrom !== undefined) m.available_from = i.availableFrom; if (i.availableTo !== undefined) m.available_to = i.availableTo; if (i.status !== undefined) m.status = i.status; if (i.sortOrder !== undefined) m.sort_order = i.sortOrder;
      const from = 'available_from' in m ? m.available_from : cur.available_from, to = 'available_to' in m ? m.available_to : cur.available_to;
      if (!from !== !to) throw fail(422, 'VALIDATION_FAILED', 'Give both the opening and closing time, or neither');
      if (!Object.keys(m).length) throw fail(422, 'VALIDATION_FAILED', 'Nothing to change');
      try { await trx.updateTable('menu').set(m as never).where('id', '=', id).execute(); } catch (e) { return this.dup(e, 'A menu'); }
      await this.audit.record(trx, { action: 'menu.menu_update', resourceType: 'menu', resourceId: id, propertyId, after: m });
      return { id };
    });
  }
  async createCategory(propertyId: string, menuId: string, userId: string, i: z.infer<typeof S.CreateCategory>) {
    return this.tdb.tx(async (trx) => {
      await this.menuRow(trx, propertyId, menuId);
      try {
        const c = await trx.insertInto('menu_category').values({ tenant_id: currentTenant().tenantId, menu_id: menuId, name: i.name, name_ur: i.nameUr ?? null, description: i.description ?? null, sort_order: i.sortOrder } as never).returning('id').executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'menu.category_create', resourceType: 'menu_category', resourceId: c.id, propertyId, after: { name: i.name } });
        return { id: c.id };
      } catch (e) { return this.dup(e, 'A category'); }
    });
  }
  async updateCategory(propertyId: string, id: string, userId: string, i: z.infer<typeof S.UpdateCategory>) {
    return this.tdb.tx(async (trx) => {
      await this.categoryRow(trx, propertyId, id);
      const m: Record<string, unknown> = {};
      if (i.name !== undefined) m.name = i.name; if (i.nameUr !== undefined) m.name_ur = i.nameUr; if (i.description !== undefined) m.description = i.description; if (i.sortOrder !== undefined) m.sort_order = i.sortOrder;
      if (!Object.keys(m).length) throw fail(422, 'VALIDATION_FAILED', 'Nothing to change');
      try { await trx.updateTable('menu_category').set(m as never).where('id', '=', id).execute(); } catch (e) { return this.dup(e, 'A category'); }
      if (i.name !== undefined) await trx.updateTable('menu_item').set({ category: i.name } as never).where('category_id', '=', id).execute();       // the older screens read the name from the item
      return { id };
    });
  }
  async deleteCategory(propertyId: string, id: string, userId: string) {
    return this.tdb.tx(async (trx) => {
      await this.categoryRow(trx, propertyId, id);
      const n = await trx.selectFrom('menu_item').select(({ fn }) => fn.countAll<string>().as('n')).where('category_id', '=', id).executeTakeFirstOrThrow();
      if (Number(n.n) > 0) throw fail(409, 'CATEGORY_NOT_EMPTY', 'Move or remove its items first');
      await trx.deleteFrom('menu_category').where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'menu.category_delete', resourceType: 'menu_category', resourceId: id, propertyId });
    });
  }

  // ───────────── reading a menu ─────────────
  private card(m: ItemFull, cur: string, ctx: { menu?: MenuRow; outlet?: { status: string }; now: { dow: number; hhmm: string }; image?: string | null; variants: number; groups: number }) {
    const reason = whyNot(m as never, ctx.menu, ctx.outlet, ctx.now);
    return {
      id: m.id, categoryId: m.category_id, name: m.name, nameUr: m.name_ur, shortDescription: m.short_description, price: fmt(m.price_minor, cur), discountedPrice: m.discounted_price_minor === null ? null : fmt(m.discounted_price_minor, cur),
      serves: m.serves, servingSize: m.serving_size, prepMinMinutes: m.prep_min_minutes, prepMaxMinutes: m.prep_max_minutes, dietary: m.dietary, spiceLevel: m.spice_level, allergensContain: m.allergens_contain,
      availability: m.availability, limitedQuantity: m.limited_quantity, active: m.active, orderable: reason === null, unavailableReason: reason, image: ctx.image ?? null, variants: ctx.variants, hasModifiers: ctx.groups > 0, sortOrder: m.sort_order, version: m.version,
    };
  }
  /** One outlet with its menus, their categories and the items on them, as the listing card needs them. */
  async tree(propertyId: string, outletId: string, all: boolean) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); await this.adoptLegacy(trx, propertyId);
      const outlet = await this.outletRow(trx, propertyId, outletId);
      const now = nowAt(this.clock.now(), p.timezone);
      let mq = trx.selectFrom('menu').selectAll().where('outlet_id', '=', outletId).orderBy('sort_order').orderBy('name'); if (!all) mq = mq.where('status', '=', 'ACTIVE');
      const menus = await mq.execute();
      const cats = menus.length ? await trx.selectFrom('menu_category').selectAll().where('menu_id', 'in', menus.map((m) => m.id)).orderBy('sort_order').orderBy('name').execute() : [];
      let iq = cats.length ? trx.selectFrom('menu_item').selectAll().where('category_id', 'in', cats.map((c) => c.id)).orderBy('sort_order').orderBy('name') : null;
      if (iq && !all) iq = iq.where('active', '=', true);
      const items = iq ? await iq.execute() : [];
      const ids = items.map((i) => i.id);
      const [media, variants, groups] = ids.length ? await Promise.all([
        trx.selectFrom('menu_item_media').select(['item_id', 'file_name']).where('item_id', 'in', ids).where('kind', '=', 'IMAGE').orderBy('is_primary', 'desc').orderBy('sort_order').execute(),
        trx.selectFrom('menu_item_variant').select(['item_id']).where('item_id', 'in', ids).where('active', '=', true).execute(),
        trx.selectFrom('menu_item_modifier_group').select(['item_id']).where('item_id', 'in', ids).execute(),
      ]) : [[], [], []];
      const t = currentTenant().tenantId;
      return {
        outlet: { id: outlet.id, name: outlet.name, kind: outlet.kind, description: outlet.description, openingNote: outlet.opening_note, status: outlet.status }, currency: p.currency,
        menus: menus.map((m) => ({
          id: m.id, name: m.name, days: m.days, availableFrom: m.available_from?.slice(0, 5) ?? null, availableTo: m.available_to?.slice(0, 5) ?? null, status: m.status,
          categories: cats.filter((c) => c.menu_id === m.id).map((c) => ({ id: c.id, name: c.name, nameUr: c.name_ur, description: c.description, sortOrder: c.sort_order,
            items: items.filter((i) => i.category_id === c.id).map((i) => this.card(i as never, p.currency, { menu: m as never, outlet, now, image: (() => { const f = media.find((x) => x.item_id === i.id)?.file_name; return f ? mediaUrl(t, f, '') : null; })(), variants: variants.filter((v) => v.item_id === i.id).length, groups: groups.filter((g) => g.item_id === i.id).length })) })),
        })),
      };
    });
  }
  /** Everything about one item, for editing and for the order screen. */
  async item(propertyId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const m = await this.itemRow(trx, propertyId, id);
      const cat = m.category_id ? await trx.selectFrom('menu_category as c').innerJoin('menu as mn', 'mn.id', 'c.menu_id').innerJoin('outlet as o', 'o.id', 'mn.outlet_id').select(['c.name as category', 'mn.id as menu_id', 'mn.status as menu_status', 'mn.days as menu_days', 'mn.available_from as menu_from', 'mn.available_to as menu_to', 'o.id as outlet_id', 'o.name as outlet', 'o.status as outlet_status']).where('c.id', '=', m.category_id).executeTakeFirst() : undefined;
      const [variants, media, attached] = await Promise.all([
        trx.selectFrom('menu_item_variant').selectAll().where('item_id', '=', id).orderBy('sort_order').orderBy('name').execute(),
        trx.selectFrom('menu_item_media').selectAll().where('item_id', '=', id).orderBy('is_primary', 'desc').orderBy('sort_order').orderBy('created_at').execute(),
        trx.selectFrom('menu_item_modifier_group').select('group_id').where('item_id', '=', id).orderBy('sort_order').execute(),
      ]);
      const groups = await this.groupsIn(trx, propertyId, attached.map((a) => a.group_id), p.currency);
      const now = nowAt(this.clock.now(), p.timezone);
      const reason = whyNot(m as never, cat ? { status: cat.menu_status, days: cat.menu_days, available_from: cat.menu_from, available_to: cat.menu_to } : undefined, cat ? { status: cat.outlet_status } : undefined, now);
      const t = currentTenant().tenantId;
      return {
        ...this.card(m, p.currency, { now, variants: variants.filter((v) => v.active).length, groups: groups.length, menu: cat ? { status: cat.menu_status, days: cat.menu_days, available_from: cat.menu_from, available_to: cat.menu_to } : undefined, outlet: cat ? { status: cat.outlet_status } : undefined }),
        orderable: reason === null, unavailableReason: reason, category: cat?.category ?? m.category, menuId: cat?.menu_id ?? null, outletId: cat?.outlet_id ?? null, outlet: cat?.outlet ?? null,
        description: m.description, portionAmount: m.portion_amount, days: m.days, availableFrom: m.available_from?.slice(0, 5) ?? null, availableTo: m.available_to?.slice(0, 5) ?? null,
        ingredients: m.ingredients, removableIngredients: m.removable_ingredients, allergensMay: m.allergens_may, calories: m.calories, proteinG: m.protein_g === null ? null : Number(m.protein_g), carbsG: m.carbs_g === null ? null : Number(m.carbs_g), fatG: m.fat_g === null ? null : Number(m.fat_g),
        sodiumMg: m.sodium_mg, cuisine: m.cuisine, temperature: m.temperature, pairings: m.pairings, minQuantity: m.min_quantity, maxQuantity: m.max_quantity, specialInstructions: m.special_instructions,
        variantList: variants.map((v) => ({ id: v.id, name: v.name, price: fmt(v.price_minor, p.currency), serves: v.serves, active: v.active, sortOrder: v.sort_order })), modifierGroups: groups,
        media: media.map((x) => ({ id: x.id, kind: x.kind, url: mediaUrl(t, x.file_name, ''), altText: x.alt_text, isPrimary: x.is_primary, sizeBytes: Number(x.size_bytes) })),
      };
    });
  }
  private async groupsIn(trx: Trx, propertyId: string, ids: string[] | null, cur: string) {
    let q = trx.selectFrom('modifier_group').selectAll().where('property_id', '=', propertyId).orderBy('name');
    if (ids) { if (!ids.length) return []; q = q.where('id', 'in', ids); }
    const gs = await q.execute();
    const opts = gs.length ? await trx.selectFrom('modifier_option').selectAll().where('group_id', 'in', gs.map((g) => g.id)).orderBy('sort_order').orderBy('name').execute() : [];
    const order = ids ? new Map(ids.map((x, k) => [x, k])) : null;
    return gs.sort((a, b) => (order ? (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) : 0)).map((g) => ({ id: g.id, name: g.name, minSelect: g.min_select, maxSelect: g.max_select, active: g.active,
      options: opts.filter((o) => o.group_id === g.id).map((o) => ({ id: o.id, name: o.name, priceDelta: fmt(o.price_delta_minor, cur), active: o.active, sortOrder: o.sort_order })) }));
  }

  // ───────────── items ─────────────
  private itemColumns(i: Partial<z.infer<typeof S.CreateItem>> & { active?: boolean }, cur: string): Record<string, unknown> {
    const m: Record<string, unknown> = {}; const set = (k: string, v: unknown) => { if (v !== undefined) m[k] = v; };
    set('name', i.name); set('name_ur', i.nameUr); set('short_description', i.shortDescription); set('description', i.description);
    if (i.price !== undefined) m.price_minor = Money.parse(i.price, cur).minor.toString();
    if (i.discountedPrice !== undefined) m.discounted_price_minor = i.discountedPrice === null ? null : Money.parse(i.discountedPrice, cur).minor.toString();
    set('serving_size', i.servingSize); set('serves', i.serves); set('portion_amount', i.portionAmount); set('prep_min_minutes', i.prepMinMinutes); set('prep_max_minutes', i.prepMaxMinutes);
    set('availability', i.availability); set('limited_quantity', i.limitedQuantity); set('days', i.days); set('available_from', i.availableFrom); set('available_to', i.availableTo);
    set('ingredients', i.ingredients); set('removable_ingredients', i.removableIngredients); set('allergens_contain', i.allergensContain); set('allergens_may', i.allergensMay); set('dietary', i.dietary);
    set('calories', i.calories); set('protein_g', i.proteinG); set('carbs_g', i.carbsG); set('fat_g', i.fatG); set('sodium_mg', i.sodiumMg); set('spice_level', i.spiceLevel); set('cuisine', i.cuisine); set('temperature', i.temperature); set('pairings', i.pairings);
    set('min_quantity', i.minQuantity); set('max_quantity', i.maxQuantity); set('special_instructions', i.specialInstructions); set('sort_order', i.sortOrder); set('active', i.active);
    return m;
  }
  async createItem(propertyId: string, userId: string, i: z.infer<typeof S.CreateItem>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const cat = await this.categoryRow(trx, propertyId, i.categoryId);
      const cols = this.itemColumns(i, p.currency);
      if (i.discountedPrice != null && Money.parse(i.discountedPrice, p.currency).minor > Money.parse(i.price, p.currency).minor) throw fail(422, 'VALIDATION_FAILED', 'The discounted price cannot be more than the price');
      try {
        const m = await trx.insertInto('menu_item').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, category_id: cat.id, category: cat.name, ...cols } as never).returning('id').executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'menu.item_create', resourceType: 'menu_item', resourceId: m.id, propertyId, after: { name: i.name, price: i.price } });
        return { id: m.id };
      } catch (e) { return this.dup(e, 'An item'); }
    });
  }
  async updateItem(propertyId: string, id: string, userId: string, i: z.infer<typeof S.UpdateItem>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const cur = await this.itemRow(trx, propertyId, id, true);
      if (cur.version !== i.version) throw fail(412, 'VERSION_CONFLICT', 'Someone else changed this item. Reload and try again.');
      const m = this.itemColumns(i, p.currency);
      if (i.categoryId) { const cat = await this.categoryRow(trx, propertyId, i.categoryId); m.category_id = cat.id; m.category = cat.name; }
      // the rules that span fields are checked against the item as it will be, not only the fields sent
      const next = { ...cur, ...m } as Record<string, any>;
      if (next.discounted_price_minor !== null && BigInt(next.discounted_price_minor) > BigInt(next.price_minor)) throw fail(422, 'VALIDATION_FAILED', 'The discounted price cannot be more than the price');
      if ((next.availability === 'LIMITED') !== (next.limited_quantity !== null)) { if (next.availability !== 'LIMITED') m.limited_quantity = null; else throw fail(422, 'VALIDATION_FAILED', 'Say how many are left for a limited item'); }
      if (!next.available_from !== !next.available_to) throw fail(422, 'VALIDATION_FAILED', 'Give both times, or neither');
      if ((next.removable_ingredients as string[]).some((r) => !(next.ingredients as string[]).some((x) => x.toLowerCase() === r.toLowerCase()))) throw fail(422, 'VALIDATION_FAILED', 'Every removable ingredient must be in the ingredient list');
      try {
        const u = await trx.updateTable('menu_item').set({ ...m, version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'menu.item_update', resourceType: 'menu_item', resourceId: id, propertyId, before: { price: cur.price_minor, active: cur.active, availability: cur.availability }, after: { price: u.price_minor, active: u.active, availability: u.availability } });
        return { id, version: u.version };
      } catch (e) { return this.dup(e, 'An item'); }
    });
  }

  // ───────────── variants ─────────────
  async createVariant(propertyId: string, itemId: string, userId: string, i: z.infer<typeof S.CreateVariant>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); await this.itemRow(trx, propertyId, itemId);
      try {
        const v = await trx.insertInto('menu_item_variant').values({ tenant_id: currentTenant().tenantId, item_id: itemId, name: i.name, price_minor: Money.parse(i.price, p.currency).minor.toString(), serves: i.serves ?? null, sort_order: i.sortOrder } as never).returning('id').executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'menu.variant_create', resourceType: 'menu_item', resourceId: itemId, propertyId, after: { variant: i.name, price: i.price } });
        return { id: v.id };
      } catch (e) { return this.dup(e, 'A size'); }
    });
  }
  async updateVariant(propertyId: string, itemId: string, id: string, userId: string, i: z.infer<typeof S.UpdateVariant>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); await this.itemRow(trx, propertyId, itemId);
      const m: Record<string, unknown> = {};
      if (i.name !== undefined) m.name = i.name; if (i.price !== undefined) m.price_minor = Money.parse(i.price, p.currency).minor.toString(); if (i.serves !== undefined) m.serves = i.serves; if (i.sortOrder !== undefined) m.sort_order = i.sortOrder; if (i.active !== undefined) m.active = i.active;
      if (!Object.keys(m).length) throw fail(422, 'VALIDATION_FAILED', 'Nothing to change');
      try { const r = await trx.updateTable('menu_item_variant').set(m as never).where('id', '=', id).where('item_id', '=', itemId).returning('id').executeTakeFirst(); if (!r) throw fail(404, 'NOT_FOUND', 'Size not found'); } catch (e) { if (e instanceof HttpException) throw e; return this.dup(e, 'A size'); }
      await this.audit.record(trx, { action: 'menu.variant_update', resourceType: 'menu_item', resourceId: itemId, propertyId, after: m });
      return { id };
    });
  }

  // ───────────── modifier groups ─────────────
  async groups(propertyId: string) {
    return this.tdb.tx(async (trx) => { const p = await this.prop(trx, propertyId); return { items: await this.groupsIn(trx, propertyId, null, p.currency) }; });
  }
  async createGroup(propertyId: string, userId: string, i: z.infer<typeof S.CreateGroup>) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      try {
        const g = await trx.insertInto('modifier_group').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, name: i.name, min_select: i.minSelect, max_select: i.maxSelect } as never).returning('id').executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'menu.group_create', resourceType: 'modifier_group', resourceId: g.id, propertyId, after: { name: i.name } });
        return { id: g.id };
      } catch (e) { return this.dup(e, 'A group'); }
    });
  }
  async updateGroup(propertyId: string, id: string, userId: string, i: z.infer<typeof S.UpdateGroup>) {
    return this.tdb.tx(async (trx) => {
      const cur = await trx.selectFrom('modifier_group').selectAll().where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst();
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Group not found' });
      const m: Record<string, unknown> = {};
      if (i.name !== undefined) m.name = i.name; if (i.minSelect !== undefined) m.min_select = i.minSelect; if (i.maxSelect !== undefined) m.max_select = i.maxSelect; if (i.active !== undefined) m.active = i.active;
      if (((m.min_select as number | undefined) ?? cur.min_select) > ((m.max_select as number | undefined) ?? cur.max_select)) throw fail(422, 'VALIDATION_FAILED', 'The least cannot be more than the most');
      if (!Object.keys(m).length) throw fail(422, 'VALIDATION_FAILED', 'Nothing to change');
      try { await trx.updateTable('modifier_group').set(m as never).where('id', '=', id).execute(); } catch (e) { return this.dup(e, 'A group'); }
      return { id };
    });
  }
  async createOption(propertyId: string, groupId: string, userId: string, i: z.infer<typeof S.CreateOption>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      if (!(await trx.selectFrom('modifier_group').select('id').where('id', '=', groupId).where('property_id', '=', propertyId).executeTakeFirst())) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Group not found' });
      const o = await trx.insertInto('modifier_option').values({ tenant_id: currentTenant().tenantId, group_id: groupId, name: i.name, price_delta_minor: Money.parse(i.priceDelta, p.currency).minor.toString(), sort_order: i.sortOrder } as never).returning('id').executeTakeFirstOrThrow();
      return { id: o.id };
    });
  }
  async updateOption(propertyId: string, groupId: string, id: string, userId: string, i: z.infer<typeof S.UpdateOption>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      if (!(await trx.selectFrom('modifier_group').select('id').where('id', '=', groupId).where('property_id', '=', propertyId).executeTakeFirst())) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Group not found' });
      const m: Record<string, unknown> = {};
      if (i.name !== undefined) m.name = i.name; if (i.priceDelta !== undefined) m.price_delta_minor = Money.parse(i.priceDelta, p.currency).minor.toString(); if (i.sortOrder !== undefined) m.sort_order = i.sortOrder; if (i.active !== undefined) m.active = i.active;
      if (!Object.keys(m).length) throw fail(422, 'VALIDATION_FAILED', 'Nothing to change');
      const r = await trx.updateTable('modifier_option').set(m as never).where('id', '=', id).where('group_id', '=', groupId).returning('id').executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Option not found' });
      return { id };
    });
  }
  async attachGroups(propertyId: string, itemId: string, userId: string, ids: string[]) {
    return this.tdb.tx(async (trx) => {
      await this.itemRow(trx, propertyId, itemId, true);
      const uniq = [...new Set(ids)];
      if (uniq.length) {
        const have = await trx.selectFrom('modifier_group').select('id').where('property_id', '=', propertyId).where('id', 'in', uniq).execute();
        if (have.length !== uniq.length) throw fail(422, 'REFERENCE_INVALID', 'One of the groups does not exist');
      }
      await trx.deleteFrom('menu_item_modifier_group').where('item_id', '=', itemId).execute();
      if (uniq.length) await trx.insertInto('menu_item_modifier_group').values(uniq.map((g, k) => ({ tenant_id: currentTenant().tenantId, item_id: itemId, group_id: g, sort_order: k }))).execute();
      await this.audit.record(trx, { action: 'menu.item_groups', resourceType: 'menu_item', resourceId: itemId, propertyId, after: { groups: uniq.length } });
      return { ok: true };
    });
  }

  // ───────────── pictures and the short video ─────────────
  async addMedia(propertyId: string, itemId: string, userId: string, data: Buffer) {
    const stored = await this.media.storePublic(data);
    try {
      return await this.tdb.tx(async (trx) => {
        await this.itemRow(trx, propertyId, itemId);
        const rows = await trx.selectFrom('menu_item_media').select(['kind', 'sort_order']).where('item_id', '=', itemId).execute();
        if (rows.length >= 10) throw fail(409, 'MEDIA_LIMIT', 'An item can have up to 10 pictures and videos');
        if (stored.kind === 'VIDEO' && rows.some((r) => r.kind === 'VIDEO')) throw fail(409, 'VIDEO_LIMIT', 'An item can have one short video');
        const first = !rows.some((r) => r.kind === 'IMAGE') && stored.kind === 'IMAGE';
        const m = await trx.insertInto('menu_item_media').values({ tenant_id: currentTenant().tenantId, item_id: itemId, kind: stored.kind, file_name: stored.fileName, content_type: stored.contentType, size_bytes: String(stored.size), is_primary: first, sort_order: rows.length, uploaded_by: userId } as never).returning('id').executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'menu.media_add', resourceType: 'menu_item', resourceId: itemId, propertyId, after: { mediaId: m.id, kind: stored.kind } });
        return { id: m.id, kind: stored.kind, url: mediaUrl(currentTenant().tenantId, stored.fileName, ''), isPrimary: first };
      });
    } catch (e) { await this.media.removePublic(stored.fileName); throw e; }
  }
  async updateMedia(propertyId: string, itemId: string, id: string, userId: string, i: z.infer<typeof S.UpdateMedia>) {
    return this.tdb.tx(async (trx) => {
      await this.itemRow(trx, propertyId, itemId);
      const m = await trx.selectFrom('menu_item_media').selectAll().where('id', '=', id).where('item_id', '=', itemId).executeTakeFirst();
      if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Picture not found' });
      if (i.altText !== undefined) await trx.updateTable('menu_item_media').set({ alt_text: i.altText?.trim() || null } as never).where('id', '=', id).execute();
      if (i.makePrimary) {
        if (m.kind !== 'IMAGE') throw fail(422, 'VALIDATION_FAILED', 'Only a picture can be the main image');
        await trx.updateTable('menu_item_media').set({ is_primary: false } as never).where('item_id', '=', itemId).where('is_primary', '=', true).execute();
        await trx.updateTable('menu_item_media').set({ is_primary: true } as never).where('id', '=', id).execute();
      }
      return { id };
    });
  }
  async removeMedia(propertyId: string, itemId: string, id: string, userId: string) {
    const gone = await this.tdb.tx(async (trx) => {
      await this.itemRow(trx, propertyId, itemId);
      const m = await trx.deleteFrom('menu_item_media').where('id', '=', id).where('item_id', '=', itemId).returning(['file_name', 'is_primary']).executeTakeFirst();
      if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Picture not found' });
      if (m.is_primary) {                                    // the next picture takes over as the main one
        const next = await trx.selectFrom('menu_item_media').select('id').where('item_id', '=', itemId).where('kind', '=', 'IMAGE').orderBy('sort_order').executeTakeFirst();
        if (next) await trx.updateTable('menu_item_media').set({ is_primary: true } as never).where('id', '=', next.id).execute();
      }
      await this.audit.record(trx, { action: 'menu.media_remove', resourceType: 'menu_item', resourceId: itemId, propertyId, after: { mediaId: id } });
      return m.file_name;
    });
    await this.media.removePublic(gone);
  }
}
