import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { fmt, type Trx } from '../companies/companies.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { MediaService, mediaUrl } from '../media/media.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { needs, perUnitCost, toBase, wouldLoop, batchCost, type Graph, type Version } from './costing.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const n = (v: string | number | null) => (v === null ? null : Number(v));
/** Cost per base unit from "600 per kg": the stock keeps whatever one g, ml or piece costs, in paisa, with decimals. */
const perBase = (amount: string, per: string, unit: 'g' | 'ml' | 'pcs', cur: string) => {
  const major = Number(amount); const f = toBase(1, per, unit); if (f === null) throw fail(422, 'UNIT_MISMATCH', `A cost per ${per} does not fit an item counted in ${unit}`);
  return (major * Number(Money.parse('1', cur).minor)) / f;
};

/** Recipes and the kitchen's stock: versions that are drafted and then approved, what a dish costs to make, and what a delivered order takes out of the store. */
@Injectable()
export class RecipesService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(MediaService) private readonly media: MediaService) {}

  private async prop(trx: Trx, id: string) {
    const p = await trx.selectFrom('property').select(['id', 'currency']).where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return p;
  }
  private minorFactor = (cur: string) => Number(Money.parse('1', cur).minor);
  private money(minor: number, cur: string) { return fmt(BigInt(Math.round(minor)), cur); }

  // ───────────── stock ─────────────
  private stockView(s: { id: string; name: string; unit: string; unit_cost_minor: string; on_hand: string; reorder_level: string | null; active: boolean; version: number }, cur: string) {
    const per = s.unit === 'pcs' ? 'pcs' : s.unit === 'g' ? 'kg' : 'l'; const f = per === 'pcs' ? 1 : 1000;
    return { id: s.id, name: s.name, unit: s.unit, unitCost: this.money(Number(s.unit_cost_minor), cur), costPerLarge: { per, amount: this.money(Number(s.unit_cost_minor) * f, cur).amount }, onHand: Number(s.on_hand), reorderLevel: n(s.reorder_level), low: s.reorder_level !== null && Number(s.on_hand) <= Number(s.reorder_level), active: s.active, version: s.version };
  }
  async stock(propertyId: string, all: boolean) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      let q = trx.selectFrom('stock_item').selectAll().where('property_id', '=', propertyId).orderBy('name'); if (!all) q = q.where('active', '=', true);
      return { items: (await q.execute()).map((s) => this.stockView(s as never, p.currency)) };
    });
  }
  async createStock(propertyId: string, userId: string, i: z.infer<typeof S.CreateStock>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      try {
        const s = await trx.insertInto('stock_item').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, name: i.name, unit: i.unit, unit_cost_minor: String(perBase(i.cost, i.costPer ?? i.unit, i.unit, p.currency)), reorder_level: i.reorderLevel == null ? null : String(i.reorderLevel) } as never).returningAll().executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'stock.item_create', resourceType: 'stock_item', resourceId: s.id, propertyId, after: { name: i.name, unit: i.unit } });
        return this.stockView(s as never, p.currency);
      } catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE', `"${i.name}" is already in stock`); throw e; }
    });
  }
  async updateStock(propertyId: string, id: string, userId: string, i: z.infer<typeof S.UpdateStock>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const cur = await trx.selectFrom('stock_item').selectAll().where('id', '=', id).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Stock item not found' });
      if (cur.version !== i.version) throw fail(412, 'VERSION_CONFLICT', 'Someone else changed this item. Reload and try again.');
      const m: Record<string, unknown> = {};
      if (i.name !== undefined) m.name = i.name; if (i.reorderLevel !== undefined) m.reorder_level = i.reorderLevel === null ? null : String(i.reorderLevel); if (i.active !== undefined) m.active = i.active;
      if (i.cost !== undefined) m.unit_cost_minor = String(perBase(i.cost, i.costPer ?? cur.unit, cur.unit, p.currency));
      try {
        const u = await trx.updateTable('stock_item').set({ ...m, version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'stock.item_update', resourceType: 'stock_item', resourceId: id, propertyId, before: { cost: cur.unit_cost_minor, active: cur.active }, after: { cost: u.unit_cost_minor, active: u.active } });
        return this.stockView(u as never, p.currency);
      } catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE', 'Another item has that name'); throw e; }
    });
  }
  async move(propertyId: string, id: string, userId: string, i: z.infer<typeof S.Movement>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const s = await trx.selectFrom('stock_item').selectAll().where('id', '=', id).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
      if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Stock item not found' });
      const conv = (q: number, u?: string) => { const b = toBase(q, u ?? s.unit, s.unit); if (b === null) throw fail(422, 'UNIT_MISMATCH', `This item is counted in ${s.unit}, not ${u}`); return b; };
      let delta: number; let unitCost: number | null = null; let note: string | null = null;
      if (i.kind === 'RECEIVE') { delta = conv(i.qty, i.unit); note = i.note ?? null; if (i.cost) { unitCost = perBase(i.cost, i.costPer ?? i.unit ?? s.unit, s.unit, p.currency); } }
      else if (i.kind === 'WASTE') { delta = -conv(i.qty, i.unit); note = i.note; }
      else { delta = conv(i.counted, i.unit) - Number(s.on_hand); note = i.note; if (delta === 0) throw fail(422, 'NOTHING_TO_CHANGE', 'The count is already that'); }
      await trx.insertInto('stock_movement').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, item_id: id, kind: i.kind, qty: String(delta), unit_cost_minor: unitCost === null ? null : String(unitCost), note, created_by: userId } as never).execute();
      const u = await trx.updateTable('stock_item').set({ on_hand: sql`on_hand + ${delta}`, ...(unitCost !== null ? { unit_cost_minor: String(unitCost) } : {}), version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: `stock.${i.kind.toLowerCase()}`, resourceType: 'stock_item', resourceId: id, propertyId, after: { delta, onHand: u.on_hand, note } });
      return this.stockView(u as never, p.currency);
    });
  }
  async movements(propertyId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const rows = await trx.selectFrom('stock_movement').selectAll().where('property_id', '=', propertyId).where('item_id', '=', id).orderBy('created_at', 'desc').limit(60).execute();
      return { items: rows.map((r) => ({ id: r.id, kind: r.kind, qty: Number(r.qty), note: r.note, at: r.created_at })) };
    });
  }

  // ───────────── recipes ─────────────
  /** Every approved recipe of the property and the cost of each stock item, as the arithmetic needs them. `override` swaps in a draft to cost it. */
  private async graph(trx: Trx, propertyId: string, override?: { recipeId: string; version: Version }): Promise<Graph & { names: Map<string, string> }> {
    const recipes = await trx.selectFrom('recipe').select(['id', 'kind', 'current_version_id']).where('property_id', '=', propertyId).execute();
    const vids = recipes.map((r) => r.current_version_id).filter((x): x is string => !!x);
    const vs = vids.length ? await trx.selectFrom('recipe_version').select(['id', 'recipe_id', 'yield_qty']).where('id', 'in', vids).execute() : [];
    const ls = vids.length ? await trx.selectFrom('recipe_line').selectAll().where('version_id', 'in', vids).execute() : [];
    const items = await trx.selectFrom('stock_item').select(['id', 'name', 'unit_cost_minor']).where('property_id', '=', propertyId).execute();
    const versions = new Map<string, Version>();
    for (const v of vs) versions.set(v.recipe_id, { kind: recipes.find((r) => r.id === v.recipe_id)!.kind, yieldQty: Number(v.yield_qty), lines: ls.filter((l) => l.version_id === v.id).map((l) => ({ stockItemId: l.stock_item_id, subRecipeId: l.sub_recipe_id, qty: Number(l.qty), wastePct: Number(l.waste_pct) })) });
    if (override) versions.set(override.recipeId, override.version);
    return { versions, unitCost: new Map(items.map((s) => [s.id, Number(s.unit_cost_minor)])), names: new Map(items.map((s) => [s.id, s.name])) };
  }
  private async menuPrice(trx: Trx, itemId: string | null) {
    if (!itemId) return null;
    const m = await trx.selectFrom('menu_item').select(['name', 'price_minor', 'discounted_price_minor']).where('id', '=', itemId).executeTakeFirst();
    return m ? { name: m.name, minor: Number(m.discounted_price_minor ?? m.price_minor) } : null;
  }
  async list(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const g = await this.graph(trx, propertyId);
      const rows = await trx.selectFrom('recipe').selectAll().where('property_id', '=', propertyId).orderBy('name').execute();
      const vs = rows.length ? await trx.selectFrom('recipe_version').select(['recipe_id', 'status', 'version_no']).where('recipe_id', 'in', rows.map((r) => r.id)).execute() : [];
      const items = [];
      for (const r of rows) {
        const mine = vs.filter((v) => v.recipe_id === r.id); const v = g.versions.get(r.id); const price = await this.menuPrice(trx, r.menu_item_id);
        const per = v ? perUnitCost(g, r.id) : null;
        items.push({ id: r.id, name: r.name, kind: r.kind, active: r.active, menuItemId: r.menu_item_id, dish: price?.name ?? null, approvedVersion: mine.find((x) => x.status === 'APPROVED')?.version_no ?? null, hasDraft: mine.some((x) => x.status === 'DRAFT'),
          costPerUnit: per === null ? null : this.money(per, p.currency), yieldQty: v?.yieldQty ?? null, price: price ? this.money(price.minor, p.currency) : null,
          foodCostPct: per !== null && price && r.kind === 'DISH' && price.minor > 0 ? Math.round((per / price.minor) * 1000) / 10 : null });
      }
      return { items };
    });
  }
  async create(propertyId: string, userId: string, i: z.infer<typeof S.CreateRecipe>) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      if (i.menuItemId) {
        if (i.kind !== 'DISH') throw fail(422, 'VALIDATION_FAILED', 'Only a dish can be linked to a menu item');
        if (!(await trx.selectFrom('menu_item').select('id').where('id', '=', i.menuItemId).where('property_id', '=', propertyId).executeTakeFirst())) throw fail(422, 'MENU_ITEM_INVALID', 'That dish is not on the menu');
      }
      try {
        const r = await trx.insertInto('recipe').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, name: i.name, kind: i.kind, menu_item_id: i.menuItemId ?? null, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
        const v = await trx.insertInto('recipe_version').values({ tenant_id: currentTenant().tenantId, recipe_id: r.id, version_no: 1, yield_qty: i.kind === 'DISH' ? '1' : '1000', yield_unit: i.kind === 'DISH' ? 'portion' : 'g', created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'recipe.create', resourceType: 'recipe', resourceId: r.id, propertyId, after: { name: i.name, kind: i.kind } });
        return { id: r.id, versionId: v.id };
      } catch (e) {
        const c = (e as { code?: string; constraint?: string });
        if (c.code === '23505') throw fail(409, 'DUPLICATE', c.constraint === 'recipe_menu_item_uq' ? 'That dish already has a recipe' : `A recipe called "${i.name}" already exists`);
        throw e;
      }
    });
  }
  async update(propertyId: string, id: string, userId: string, i: z.infer<typeof S.UpdateRecipe>) {
    return this.tdb.tx(async (trx) => {
      const r = await this.recipeRow(trx, propertyId, id);
      const m: Record<string, unknown> = {};
      if (i.name !== undefined) m.name = i.name; if (i.active !== undefined) m.active = i.active;
      if (i.menuItemId !== undefined) {
        if (i.menuItemId && r.kind !== 'DISH') throw fail(422, 'VALIDATION_FAILED', 'Only a dish can be linked to a menu item');
        if (i.menuItemId && !(await trx.selectFrom('menu_item').select('id').where('id', '=', i.menuItemId).where('property_id', '=', propertyId).executeTakeFirst())) throw fail(422, 'MENU_ITEM_INVALID', 'That dish is not on the menu');
        m.menu_item_id = i.menuItemId;
      }
      if (!Object.keys(m).length) throw fail(422, 'VALIDATION_FAILED', 'Nothing to change');
      try { await trx.updateTable('recipe').set(m as never).where('id', '=', id).execute(); }
      catch (e) { if ((e as { code?: string }).code === '23505') throw fail(409, 'DUPLICATE', 'That name or dish is already used by another recipe'); throw e; }
      await this.audit.record(trx, { action: 'recipe.update', resourceType: 'recipe', resourceId: id, propertyId, after: m });
      return { id };
    });
  }
  private async recipeRow(trx: Trx, propertyId: string, id: string) {
    const r = await trx.selectFrom('recipe').selectAll().where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst();
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recipe not found' });
    return r;
  }
  private async versionRow(trx: Trx, propertyId: string, id: string, lock = false) {
    let q = trx.selectFrom('recipe_version as v').innerJoin('recipe as r', 'r.id', 'v.recipe_id').selectAll('v').select(['r.property_id', 'r.kind as recipe_kind', 'r.name as recipe_name']).where('v.id', '=', id).where('r.property_id', '=', propertyId);
    if (lock) q = q.forUpdate();
    const v = await q.executeTakeFirst();
    if (!v) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recipe version not found' });
    return v;
  }
  private async content(trx: Trx, v: Awaited<ReturnType<RecipesService['versionRow']>>) {
    const ls = await trx.selectFrom('recipe_line').selectAll().where('version_id', '=', v.id).orderBy('seq').execute();
    const si = ls.filter((l) => l.stock_item_id).map((l) => l.stock_item_id!); const sr = ls.filter((l) => l.sub_recipe_id).map((l) => l.sub_recipe_id!);
    const items = si.length ? await trx.selectFrom('stock_item').select(['id', 'name', 'unit']).where('id', 'in', si).execute() : [];
    const subs = sr.length ? await trx.selectFrom('recipe').select(['id', 'name']).where('id', 'in', sr).execute() : [];
    const subV = sr.length ? await trx.selectFrom('recipe_version').select(['recipe_id', 'yield_unit']).where('recipe_id', 'in', sr).where('status', '=', 'APPROVED').execute() : [];
    const t = currentTenant().tenantId;
    return {
      id: v.id, recipeId: v.recipe_id, versionNo: v.version_no, status: v.status, yieldQty: Number(v.yield_qty), yieldUnit: v.yield_unit, prepMinutes: v.prep_minutes, cookMinutes: v.cook_minutes, steps: v.steps, equipment: v.equipment,
      cookingMethod: v.cooking_method, temperature: v.temperature, plating: v.plating, foodSafety: v.food_safety, changeNote: v.change_note, video: v.video_file ? mediaUrl(t, v.video_file, '') : null, approvedAt: v.approved_at, approvedBy: v.approved_by, createdAt: v.created_at,
      lines: ls.map((l) => ({ id: l.id, stockItemId: l.stock_item_id, subRecipeId: l.sub_recipe_id, name: items.find((x) => x.id === l.stock_item_id)?.name ?? subs.find((x) => x.id === l.sub_recipe_id)?.name ?? '', unit: l.stock_item_id ? items.find((x) => x.id === l.stock_item_id)?.unit ?? '' : subV.find((x) => x.recipe_id === l.sub_recipe_id)?.yield_unit ?? '', qty: Number(l.qty), wastePct: Number(l.waste_pct), note: l.note })),
    };
  }
  /** One recipe: its versions, and the content of the one asked for (the draft if there is one, otherwise the approved one). */
  async get(propertyId: string, id: string, versionId?: string) {
    return this.tdb.tx(async (trx) => {
      const r = await this.recipeRow(trx, propertyId, id);
      const vs = await trx.selectFrom('recipe_version').select(['id', 'version_no', 'status', 'change_note', 'created_at', 'approved_at']).where('recipe_id', '=', id).orderBy('version_no', 'desc').execute();
      const pick = versionId ? vs.find((x) => x.id === versionId) : vs.find((x) => x.status === 'DRAFT') ?? vs.find((x) => x.status === 'APPROVED') ?? vs[0];
      if (!pick) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recipe version not found' });
      const v = await this.versionRow(trx, propertyId, pick.id);
      return { id: r.id, name: r.name, kind: r.kind, active: r.active, menuItemId: r.menu_item_id, versions: vs.map((x) => ({ id: x.id, versionNo: x.version_no, status: x.status, changeNote: x.change_note, createdAt: x.created_at, approvedAt: x.approved_at })), version: await this.content(trx, v) };
    });
  }
  /** A new draft, starting as a copy of what is approved now (or of the latest version), so a change is a small edit rather than a rewrite. */
  async newVersion(propertyId: string, recipeId: string, userId: string) {
    return this.tdb.tx(async (trx) => {
      await this.recipeRow(trx, propertyId, recipeId);
      const all = await trx.selectFrom('recipe_version').selectAll().where('recipe_id', '=', recipeId).orderBy('version_no', 'desc').execute();
      if (all.some((v) => v.status === 'DRAFT')) throw fail(409, 'DRAFT_EXISTS', 'There is already a draft of this recipe. Finish or approve it first.');
      const from = all.find((v) => v.status === 'APPROVED') ?? all[0]!;
      const v = await trx.insertInto('recipe_version').values({ tenant_id: currentTenant().tenantId, recipe_id: recipeId, version_no: (all[0]?.version_no ?? 0) + 1, yield_qty: from.yield_qty, yield_unit: from.yield_unit, prep_minutes: from.prep_minutes, cook_minutes: from.cook_minutes,
        steps: from.steps, equipment: from.equipment, cooking_method: from.cooking_method, temperature: from.temperature, plating: from.plating, food_safety: from.food_safety, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      const ls = await trx.selectFrom('recipe_line').selectAll().where('version_id', '=', from.id).execute();
      if (ls.length) await trx.insertInto('recipe_line').values(ls.map((l) => ({ tenant_id: l.tenant_id, version_id: v.id, seq: l.seq, stock_item_id: l.stock_item_id, sub_recipe_id: l.sub_recipe_id, qty: l.qty, waste_pct: l.waste_pct, note: l.note })) as never).execute();
      await this.audit.record(trx, { action: 'recipe.version_new', resourceType: 'recipe', resourceId: recipeId, propertyId, after: { versionNo: (all[0]?.version_no ?? 0) + 1 } });
      return { id: v.id };
    });
  }
  /** Which sub-recipes each recipe's latest content uses, for stopping a recipe from containing itself. */
  private async edges(trx: Trx, propertyId: string, replacing: { recipeId: string; subs: string[] }) {
    const rs = await trx.selectFrom('recipe').select(['id', 'current_version_id']).where('property_id', '=', propertyId).execute();
    const vids = rs.map((r) => r.current_version_id).filter((x): x is string => !!x);
    const ls = vids.length ? await trx.selectFrom('recipe_line').select(['version_id', 'sub_recipe_id']).where('version_id', 'in', vids).where('sub_recipe_id', 'is not', null).execute() : [];
    const edges = new Map<string, string[]>();
    for (const r of rs) edges.set(r.id, ls.filter((l) => l.version_id === r.current_version_id).map((l) => l.sub_recipe_id!));
    edges.set(replacing.recipeId, replacing.subs);
    return edges;
  }
  async save(propertyId: string, versionId: string, userId: string, i: z.infer<typeof S.VersionContent>) {
    return this.tdb.tx(async (trx) => {
      const v = await this.versionRow(trx, propertyId, versionId, true);
      if (v.status !== 'DRAFT') throw fail(409, 'NOT_A_DRAFT', 'Only a draft can be changed. Start a new version to make a change.');
      if (v.recipe_kind === 'DISH' && i.yieldUnit !== 'portion') throw fail(422, 'VALIDATION_FAILED', 'A dish is made in portions');
      if (v.recipe_kind === 'SUB_RECIPE' && i.yieldUnit === 'portion') throw fail(422, 'VALIDATION_FAILED', 'A sub-recipe yields grams, millilitres or pieces');
      const itemIds = [...new Set(i.lines.filter((l) => l.stockItemId).map((l) => l.stockItemId!))]; const subIds = [...new Set(i.lines.filter((l) => l.subRecipeId).map((l) => l.subRecipeId!))];
      const items = itemIds.length ? await trx.selectFrom('stock_item').select(['id', 'unit', 'active']).where('id', 'in', itemIds).where('property_id', '=', propertyId).execute() : [];
      const subs = subIds.length ? await trx.selectFrom('recipe').select(['id', 'kind', 'active', 'current_version_id']).where('id', 'in', subIds).where('property_id', '=', propertyId).execute() : [];
      const subUnits = subIds.length ? await trx.selectFrom('recipe_version').select(['recipe_id', 'yield_unit']).where('recipe_id', 'in', subIds).orderBy('version_no', 'desc').execute() : [];
      if (items.length !== itemIds.length) throw fail(422, 'STOCK_ITEM_INVALID', 'An ingredient is not in the stock list');
      if (subs.length !== subIds.length || subs.some((s) => s.kind !== 'SUB_RECIPE' || !s.active)) throw fail(422, 'SUB_RECIPE_INVALID', 'A sub-recipe line must be an active sub-recipe');
      if (wouldLoop(await this.edges(trx, propertyId, { recipeId: v.recipe_id, subs: subIds }), v.recipe_id, subIds)) throw fail(422, 'RECIPE_LOOP', 'A recipe cannot use itself as an ingredient, not even through another recipe');
      const rows = i.lines.map((l, k) => {
        const unit = l.stockItemId ? items.find((x) => x.id === l.stockItemId)!.unit : subUnits.find((x) => x.recipe_id === l.subRecipeId)!.yield_unit;
        const q = toBase(l.qty, l.unit ?? unit, unit as 'g' | 'ml' | 'pcs'); if (q === null) throw fail(422, 'UNIT_MISMATCH', `Line ${k + 1}: this ingredient is counted in ${unit}, not ${l.unit}`);
        return { tenant_id: currentTenant().tenantId, version_id: versionId, seq: k, stock_item_id: l.stockItemId ?? null, sub_recipe_id: l.subRecipeId ?? null, qty: String(q), waste_pct: String(l.wastePct), note: l.note || null };
      });
      await trx.updateTable('recipe_version').set({ yield_qty: String(i.yieldQty), yield_unit: i.yieldUnit, prep_minutes: i.prepMinutes ?? null, cook_minutes: i.cookMinutes ?? null, steps: i.steps, equipment: i.equipment, cooking_method: i.cookingMethod || null, temperature: i.temperature || null, plating: i.plating || null, food_safety: i.foodSafety || null, change_note: i.changeNote || null } as never).where('id', '=', versionId).execute();
      await trx.deleteFrom('recipe_line').where('version_id', '=', versionId).execute();
      if (rows.length) await trx.insertInto('recipe_line').values(rows as never).execute();
      await this.audit.record(trx, { action: 'recipe.version_save', resourceType: 'recipe_version', resourceId: versionId, propertyId, after: { lines: rows.length, steps: i.steps.length } });
      return this.content(trx, await this.versionRow(trx, propertyId, versionId));
    });
  }
  /** Approval makes this the version the kitchen cooks from, costs and deducts; the one before it is kept as history. */
  async approve(propertyId: string, versionId: string, userId: string) {
    return this.tdb.tx(async (trx) => {
      const v = await this.versionRow(trx, propertyId, versionId, true);
      if (v.status !== 'DRAFT') throw fail(409, 'NOT_A_DRAFT', 'Only a draft can be approved');
      const lines = await trx.selectFrom('recipe_line').select('id').where('version_id', '=', versionId).execute();
      if (!lines.length) throw fail(422, 'RECIPE_EMPTY', 'Add the ingredients before approving');
      if (!v.steps.length) throw fail(422, 'RECIPE_NO_STEPS', 'Add the steps before approving');
      await trx.updateTable('recipe_version').set({ status: 'RETIRED' } as never).where('recipe_id', '=', v.recipe_id).where('status', '=', 'APPROVED').execute();
      await trx.updateTable('recipe_version').set({ status: 'APPROVED', approved_by: userId, approved_at: sql`now()` } as never).where('id', '=', versionId).execute();
      await trx.updateTable('recipe').set({ current_version_id: versionId } as never).where('id', '=', v.recipe_id).execute();
      await this.audit.record(trx, { action: 'recipe.approve', resourceType: 'recipe_version', resourceId: versionId, propertyId, after: { recipe: v.recipe_name, versionNo: v.version_no, authoredBy: v.created_by } });
      return this.content(trx, await this.versionRow(trx, propertyId, versionId));
    });
  }
  async addVideo(propertyId: string, versionId: string, userId: string, data: Buffer) {
    const stored = await this.media.storePublic(data);
    try {
      if (stored.kind !== 'VIDEO') throw fail(422, 'MEDIA_TYPE_UNSUPPORTED', 'Send an MP4 or WebM video');
      const old = await this.tdb.tx(async (trx) => {
        const v = await this.versionRow(trx, propertyId, versionId, true);
        if (v.status !== 'DRAFT') throw fail(409, 'NOT_A_DRAFT', 'The video belongs to a draft. Start a new version to change it.');
        await trx.updateTable('recipe_version').set({ video_file: stored.fileName } as never).where('id', '=', versionId).execute();
        await this.audit.record(trx, { action: 'recipe.video_set', resourceType: 'recipe_version', resourceId: versionId, propertyId });
        return v.video_file;
      });
      if (old) await this.media.removePublic(old);
      return { url: mediaUrl(currentTenant().tenantId, stored.fileName, '') };
    } catch (e) { await this.media.removePublic(stored.fileName); throw e; }
  }
  async removeVideo(propertyId: string, versionId: string, userId: string) {
    const old = await this.tdb.tx(async (trx) => {
      const v = await this.versionRow(trx, propertyId, versionId, true);
      if (v.status !== 'DRAFT') throw fail(409, 'NOT_A_DRAFT', 'The video belongs to a draft. Start a new version to change it.');
      await trx.updateTable('recipe_version').set({ video_file: null } as never).where('id', '=', versionId).execute();
      return v.video_file;
    });
    if (old) await this.media.removePublic(old);
  }

  /** What a version costs to make: each line, the batch, one portion (or one unit), and against the menu price. */
  async cost(propertyId: string, versionId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const v = await this.versionRow(trx, propertyId, versionId);
      const c = await this.content(trx, v);
      const r = await this.recipeRow(trx, propertyId, v.recipe_id);
      const g = await this.graph(trx, propertyId, { recipeId: v.recipe_id, version: { kind: v.recipe_kind, yieldQty: c.yieldQty, lines: c.lines.map((l) => ({ stockItemId: l.stockItemId, subRecipeId: l.subRecipeId, qty: l.qty, wastePct: l.wastePct })) } });
      const lineCost = (l: (typeof c.lines)[number]) => (l.stockItemId ? (l.qty / (1 - l.wastePct / 100)) * (g.unitCost.get(l.stockItemId) ?? 0) : (l.qty / (1 - l.wastePct / 100)) * perUnitCost(g, l.subRecipeId!));
      const batch = batchCost(g, v.recipe_id); const per = batch / c.yieldQty; const price = await this.menuPrice(trx, r.menu_item_id);
      const zero = c.lines.filter((l) => l.stockItemId && !(g.unitCost.get(l.stockItemId) ?? 0)).map((l) => l.name);
      return {
        yieldQty: c.yieldQty, yieldUnit: c.yieldUnit, lines: c.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, cost: this.money(lineCost(l), p.currency) })),
        batch: this.money(batch, p.currency), perUnit: this.money(per, p.currency), price: price ? this.money(price.minor, p.currency) : null,
        foodCostPct: price && r.kind === 'DISH' && price.minor > 0 ? Math.round((per / price.minor) * 1000) / 10 : null, margin: price && r.kind === 'DISH' ? this.money(price.minor - per, p.currency) : null,
        missingCosts: zero,                                              // ingredients with no cost entered, so the total is understated
      };
    });
  }
  /** The recipe card a cook sees for a dish: the approved version, with no costs. */
  async card(propertyId: string, menuItemId: string) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.selectFrom('recipe').selectAll().where('property_id', '=', propertyId).where('menu_item_id', '=', menuItemId).where('active', '=', true).executeTakeFirst();
      if (!r?.current_version_id) return { available: false as const };
      const c = await this.content(trx, await this.versionRow(trx, propertyId, r.current_version_id));
      return { available: true as const, name: r.name, versionNo: c.versionNo, yieldQty: c.yieldQty, prepMinutes: c.prepMinutes, cookMinutes: c.cookMinutes, steps: c.steps, equipment: c.equipment, cookingMethod: c.cookingMethod, temperature: c.temperature, plating: c.plating, foodSafety: c.foodSafety, video: c.video,
        ingredients: c.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, note: l.note })) };
    });
  }

  /** Delivery takes the food out of the store: each delivered line, once, by the approved recipe of its dish (portions ordered ÷ portions the recipe makes), less anything the guest had left out. */
  async deduct(trx: Trx, propertyId: string, userId: string, line: { id: string; menuItemId: string; quantity: number; removed: string[] }) {
    const r = await trx.selectFrom('recipe').select(['id', 'current_version_id']).where('property_id', '=', propertyId).where('menu_item_id', '=', line.menuItemId).where('active', '=', true).executeTakeFirst();
    if (!r?.current_version_id) return;
    const g = await this.graph(trx, propertyId);
    const used = needs(g, r.id, line.quantity, g.names, new Set(line.removed.map((x) => x.toLowerCase())));
    for (const [item, q] of used) {
      if (q <= 0) continue;
      const ins = await sql`INSERT INTO stock_movement (tenant_id, property_id, item_id, kind, qty, unit_cost_minor, note, order_line_id, created_by)
        VALUES (${currentTenant().tenantId}, ${propertyId}, ${item}, 'SALE', ${-q}, ${g.unitCost.get(item) ?? 0}, 'Order delivered', ${line.id}, ${userId}) ON CONFLICT DO NOTHING`.execute(trx);
      if (Number(ins.numAffectedRows)) await sql`UPDATE stock_item SET on_hand = on_hand - ${q}, version = version + 1 WHERE id = ${item}`.execute(trx);
    }
  }
}
