import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import { decide } from '@hos/auth';
import type { DB } from '@hos/db';
import { Money, addDays, nightsOf } from '@hos/domain-types';
import { calendarNight, priceStay, type PriceBook, type RatePlanDef, type Restriction, type RoomTypeLimits } from '@hos/rates';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { CompaniesService } from '../companies/companies.service.js';
import { TaxService } from '../tax/tax.service.js';
import { QuoteSigner } from './quote-signer.js';
import { nightBpFor, perNightDiscounts } from './night-discount.js';
import type * as S from './schemas.js';

type Trx = Transaction<DB>;
const stale = () => new HttpException({ code: 'VERSION_CONFLICT', message: 'This rate plan was changed by someone else. Reload and try again.' }, 412);
const minor = (amount: string, currency: string) => Money.parse(amount, currency).minor;
const fmt = (m: bigint | string, cur: string) => ({ amount: Money.ofMinor(BigInt(m), cur).toDecimalString(), currency: cur });
const WARN_CHANGE_PCT = 30n;

@Injectable()
export class RatesService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(InventoryService) private readonly inv: InventoryService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(QuoteSigner) private readonly signer: QuoteSigner,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(CompaniesService) private readonly companies: CompaniesService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  private async prop(trx: Trx, id: string) {
    const p = await trx.selectFrom('property').select(['id', 'currency', 'business_date', 'weekend_days', 'status']).where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return p;
  }
  private async planRow(trx: Trx, propertyId: string, id: string) {
    const r = await trx.selectFrom('rate_plan').selectAll().where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst();
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Rate plan not found' });
    return r;
  }
  private toDef(r: Awaited<ReturnType<RatesService['planRow']>>, currency: string): RatePlanDef {
    return {
      id: r.id, code: r.code, name: r.name, kind: r.kind, mealPlan: r.meal_plan as RatePlanDef['mealPlan'], audience: r.audience, residency: r.residency,
      channels: r.channels as RatePlanDef['channels'], companyIds: r.company_ids, minLos: r.min_los, maxLos: r.max_los, minAdvanceDays: r.min_advance_days, maxAdvanceDays: r.max_advance_days,
      extraBedMinor: BigInt(r.extra_bed_minor), extraAdultMealMinor: BigInt(r.extra_adult_meal_minor), extraChildMealMinor: BigInt(r.extra_child_meal_minor),
      cancellationRule: r.cancellation_rule as RatePlanDef['cancellationRule'], noShowRule: r.no_show_rule as RatePlanDef['noShowRule'], depositRule: r.deposit_rule as RatePlanDef['depositRule'],
      validFrom: r.valid_from, validTo: r.valid_to, status: r.status, currency,
      derive: r.kind === 'DERIVED' ? { type: r.derive_type!, value: BigInt(r.derive_value!), roundToMinor: BigInt(r.derive_round_minor) } : undefined,
    };
  }
  private dto(r: Awaited<ReturnType<RatesService['planRow']>>, cur: string) {
    return {
      id: r.id, code: r.code, name: r.name, description: r.description, kind: r.kind, parentPlanId: r.parent_rate_plan_id,
      derive: r.kind === 'DERIVED' ? { type: r.derive_type, value: r.derive_type === 'PERCENT' ? Number(r.derive_value) : fmt(r.derive_value!, cur).amount, roundTo: fmt(BigInt(r.derive_round_minor), cur).amount } : null,
      mealPlan: r.meal_plan, audience: r.audience, residency: r.residency, channels: r.channels, companyIds: r.company_ids, minLos: r.min_los, maxLos: r.max_los,
      minAdvanceDays: r.min_advance_days, maxAdvanceDays: r.max_advance_days, extraBed: fmt(r.extra_bed_minor, cur), extraAdultMeal: fmt(r.extra_adult_meal_minor, cur), extraChildMeal: fmt(r.extra_child_meal_minor, cur),
      cancellationRule: r.cancellation_rule, noShowRule: r.no_show_rule, depositRule: r.deposit_rule, validFrom: r.valid_from, validTo: r.valid_to, status: r.status, sortOrder: r.sort_order, version: r.version,
    };
  }

  // ───────── plans ─────────
  async createPlan(propertyId: string, i: z.infer<typeof S.CreatePlan>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const cur = p.currency;
      let kindCols: Record<string, unknown> = { kind: 'BASE' };
      if (i.derive) {
        const parent = await this.planRow(trx, propertyId, i.derive.parentPlanId);
        if (parent.kind !== 'BASE') throw new UnprocessableEntityException({ code: 'DERIVE_DEPTH', message: 'A derived plan must derive from a base plan (no chains)' });
        const v = i.derive.type === 'PERCENT' ? BigInt(i.derive.value) : Money.parse(i.derive.value.replace(/^-/, ''), cur).minor * (i.derive.value.startsWith('-') ? -1n : 1n);
        kindCols = { kind: 'DERIVED', parent_rate_plan_id: parent.id, derive_type: i.derive.type, derive_value: v.toString(), derive_round_minor: Number(minor(i.derive.roundTo, cur)) };
      }
      const row = await trx.insertInto('rate_plan').values({
        tenant_id: currentTenant().tenantId, property_id: propertyId, code: i.code, name: i.name, description: i.description ?? null, meal_plan: i.mealPlan, audience: i.audience, residency: i.residency,
        channels: i.channels, company_ids: i.companyIds, min_los: i.minLos, max_los: i.maxLos ?? null, min_advance_days: i.minAdvanceDays, max_advance_days: i.maxAdvanceDays ?? null,
        extra_bed_minor: minor(i.extraBed, cur).toString(), extra_adult_meal_minor: minor(i.extraAdultMeal, cur).toString(), extra_child_meal_minor: minor(i.extraChildMeal, cur).toString(),
        cancellation_rule: i.cancellationRule ? JSON.stringify(i.cancellationRule) : null, no_show_rule: i.noShowRule ? JSON.stringify(i.noShowRule) : null, deposit_rule: i.depositRule ? JSON.stringify(i.depositRule) : null,
        valid_from: i.validFrom ?? null, valid_to: i.validTo ?? null, sort_order: i.sortOrder, ...kindCols,
      } as never).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'rate_plan.create', resourceType: 'rate_plan', resourceId: row.id, propertyId, after: this.dto(row, cur) });
      await this.outbox.publish(trx, { aggregateType: 'rate_plan', aggregateId: row.id, eventType: 'RateChanged', propertyId, payload: { reason: 'plan_created' } });
      return this.dto(row, cur);
    });
  }

  async updatePlan(propertyId: string, id: string, i: z.infer<typeof S.UpdatePlan>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const before = await this.planRow(trx, propertyId, id);
      const cur = p.currency;
      const m: Record<string, unknown> = { version: sql`version + 1` };
      const direct: Record<string, string> = { name: 'name', description: 'description', mealPlan: 'meal_plan', audience: 'audience', residency: 'residency', minLos: 'min_los', maxLos: 'max_los',
        minAdvanceDays: 'min_advance_days', maxAdvanceDays: 'max_advance_days', validFrom: 'valid_from', validTo: 'valid_to', status: 'status', sortOrder: 'sort_order' };
      for (const [k, col] of Object.entries(direct)) if ((i as Record<string, unknown>)[k] !== undefined) m[col] = (i as Record<string, unknown>)[k];
      if (i.channels !== undefined) m.channels = i.channels;
      if (i.companyIds !== undefined) m.company_ids = i.companyIds;
      if (i.extraBed !== undefined) m.extra_bed_minor = minor(i.extraBed, cur).toString();
      if (i.extraAdultMeal !== undefined) m.extra_adult_meal_minor = minor(i.extraAdultMeal, cur).toString();
      if (i.extraChildMeal !== undefined) m.extra_child_meal_minor = minor(i.extraChildMeal, cur).toString();
      for (const [k, col] of [['cancellationRule', 'cancellation_rule'], ['noShowRule', 'no_show_rule'], ['depositRule', 'deposit_rule']] as const) {
        if ((i as Record<string, unknown>)[k] !== undefined) m[col] = (i as Record<string, unknown>)[k] === null ? null : JSON.stringify((i as Record<string, unknown>)[k]);
      }
      if (i.derive !== undefined) throw new UnprocessableEntityException({ code: 'DERIVE_IMMUTABLE', message: 'Create a new derived plan instead of changing how one is derived' });
      const after = await trx.updateTable('rate_plan').set(m as never).where('id', '=', id).where('version', '=', i.version).returningAll().executeTakeFirst();
      if (!after) throw stale();
      await this.audit.record(trx, { action: 'rate_plan.update', resourceType: 'rate_plan', resourceId: id, propertyId, before: this.dto(before, cur), after: this.dto(after, cur) });
      await this.outbox.publish(trx, { aggregateType: 'rate_plan', aggregateId: id, eventType: 'RateChanged', propertyId, payload: { reason: 'plan_updated' } });
      return this.dto(after, cur);
    });
  }

  async listPlans(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const rows = await trx.selectFrom('rate_plan').selectAll().where('property_id', '=', propertyId).orderBy('sort_order').orderBy('code').execute();
      return rows.map((r) => this.dto(r, p.currency));
    });
  }

  async getPlan(propertyId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const r = await this.planRow(trx, propertyId, id);
      const cur = p.currency;
      const [base, seasons, values, restrictions] = await Promise.all([
        trx.selectFrom('rate_base').selectAll().where('rate_plan_id', '=', id).execute(),
        trx.selectFrom('rate_season').selectAll().where('rate_plan_id', '=', id).orderBy('start_date').execute(),
        trx.selectFrom('rate_season_value').selectAll().where('rate_plan_id', '=', id).execute(),
        trx.selectFrom('rate_restriction').selectAll().where('rate_plan_id', '=', id).orderBy('start_date').execute(),
      ]);
      return {
        ...this.dto(r, cur),
        baseRates: base.map((b) => ({ roomTypeId: b.room_type_id, amount: fmt(b.amount_minor, cur), weekendAmount: b.weekend_amount_minor === null ? null : fmt(b.weekend_amount_minor, cur), extraAdult: fmt(b.extra_adult_minor, cur), extraChild: fmt(b.extra_child_minor, cur) })),
        seasons: seasons.map((s) => ({ id: s.id, name: s.name, startDate: s.start_date, endDate: s.end_date, priority: s.priority,
          values: values.filter((v) => v.season_id === s.id).map((v) => ({ roomTypeId: v.room_type_id, amount: fmt(v.amount_minor, cur), weekendAmount: v.weekend_amount_minor === null ? null : fmt(v.weekend_amount_minor, cur) })) })),
        restrictions: restrictions.map((x) => ({ id: x.id, roomTypeId: x.room_type_id, startDate: x.start_date, endDate: x.end_date, minLos: x.min_los, maxLos: x.max_los, closedToArrival: x.closed_to_arrival,
          closedToDeparture: x.closed_to_departure, stopSell: x.stop_sell, minAdvanceDays: x.min_advance_days, maxAdvanceDays: x.max_advance_days, note: x.note })),
      };
    });
  }

  // ───────── prices ─────────
  private async requireBasePlan(trx: Trx, propertyId: string, id: string) {
    const r = await this.planRow(trx, propertyId, id);
    if (r.kind !== 'BASE') throw new UnprocessableEntityException({ code: 'DERIVED_PLAN', message: 'Derived plans take their prices from the parent plan; edit the parent' });
    return r;
  }

  async setBaseRates(propertyId: string, planId: string, i: z.infer<typeof S.SetBaseRates>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const cur = p.currency;
      await this.requireBasePlan(trx, propertyId, planId);
      const before = await trx.selectFrom('rate_base').selectAll().where('rate_plan_id', '=', planId).execute();
      for (const it of i.items) {
        const amount = minor(it.amount, cur), weekend = it.weekendAmount ? minor(it.weekendAmount, cur) : null;
        if (weekend !== null && weekend < amount / 2n) throw new UnprocessableEntityException({ code: 'PRICE_SUSPICIOUS', message: 'Weekend price is less than half the weekday price — check the amounts' });
        await trx.insertInto('rate_base').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, rate_plan_id: planId, room_type_id: it.roomTypeId, amount_minor: amount.toString(),
          weekend_amount_minor: weekend === null ? null : weekend.toString(), extra_adult_minor: minor(it.extraAdult, cur).toString(), extra_child_minor: minor(it.extraChild, cur).toString() })
          .onConflict((oc) => oc.columns(['tenant_id', 'rate_plan_id', 'room_type_id']).doUpdateSet((eb) => ({ amount_minor: eb.ref('excluded.amount_minor'), weekend_amount_minor: eb.ref('excluded.weekend_amount_minor'),
            extra_adult_minor: eb.ref('excluded.extra_adult_minor'), extra_child_minor: eb.ref('excluded.extra_child_minor') }))).execute();
      }
      await this.audit.record(trx, { action: 'rate.base_set', resourceType: 'rate_plan', resourceId: planId, propertyId,
        before: before.map((b) => ({ roomTypeId: b.room_type_id, amount: fmt(b.amount_minor, cur).amount, weekend: b.weekend_amount_minor === null ? null : fmt(b.weekend_amount_minor, cur).amount })), after: i.items });
      await this.outbox.publish(trx, { aggregateType: 'rate_plan', aggregateId: planId, eventType: 'RateChanged', propertyId, payload: { reason: 'base_rates' } });
      return { updated: i.items.length };
    });
  }

  async createSeason(propertyId: string, planId: string, i: z.infer<typeof S.CreateSeason>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const cur = p.currency;
      await this.requireBasePlan(trx, propertyId, planId);
      const s = await trx.insertInto('rate_season').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, rate_plan_id: planId, name: i.name, start_date: i.startDate, end_date: i.endDate, priority: i.priority }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('rate_season_value').values(i.values.map((v) => ({ tenant_id: currentTenant().tenantId, property_id: propertyId, rate_plan_id: planId, season_id: s.id, room_type_id: v.roomTypeId,
        amount_minor: minor(v.amount, cur).toString(), weekend_amount_minor: v.weekendAmount ? minor(v.weekendAmount, cur).toString() : null }))).execute();
      await this.audit.record(trx, { action: 'rate.season_create', resourceType: 'rate_plan', resourceId: planId, propertyId, after: i });
      await this.outbox.publish(trx, { aggregateType: 'rate_plan', aggregateId: planId, eventType: 'RateChanged', propertyId, payload: { reason: 'season', from: i.startDate, to: i.endDate } });
      return { id: s.id };
    });
  }
  async deleteSeason(propertyId: string, planId: string, seasonId: string) {
    return this.tdb.tx(async (trx) => {
      await this.requireBasePlan(trx, propertyId, planId);
      const s = await trx.deleteFrom('rate_season').where('id', '=', seasonId).where('rate_plan_id', '=', planId).returning(['name', 'start_date', 'end_date']).executeTakeFirst();
      if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Season not found' });
      await this.audit.record(trx, { action: 'rate.season_delete', resourceType: 'rate_plan', resourceId: planId, propertyId, before: s });
      await this.outbox.publish(trx, { aggregateType: 'rate_plan', aggregateId: planId, eventType: 'RateChanged', propertyId, payload: { reason: 'season_removed' } });
    });
  }

  /** Range price edit with guard rails: dry-run preview, and changes of more than 30% against the current price need explicit confirmation. */
  async setOverrides(propertyId: string, planId: string, i: z.infer<typeof S.SetOverrides>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const cur = p.currency;
      await this.requireBasePlan(trx, propertyId, planId);
      const plan = this.toDef(await this.planRow(trx, propertyId, planId), cur);
      const amount = minor(i.amount, cur);
      if (amount <= 0n) throw new UnprocessableEntityException({ code: 'PRICE_INVALID', message: 'Price must be greater than zero (use a complimentary rate plan for free stays)' });
      const dates = nightsOf(i.from, i.to, 800);
      const book = (await this.loadBooks(trx, propertyId, [planId])).get(planId)!;
      const preview = dates.map((d) => {
        const now = calendarNight(plan, book, i.roomTypeId, d, p.weekend_days);
        return { date: d, from: now ? now.amount : null, to: amount, source: now?.source ?? 'NONE' };
      });
      const warnings = preview.filter((r) => r.from !== null && r.from > 0n && ((r.to > r.from! ? r.to - r.from! : r.from! - r.to) * 100n) / r.from! > WARN_CHANGE_PCT).map((r) => ({ date: r.date, code: 'LARGE_CHANGE', message: `Changes the price by more than ${WARN_CHANGE_PCT}% (${fmt(r.from!, cur).amount} → ${fmt(r.to, cur).amount})` }));
      const out = { nights: preview.length, warnings: warnings.slice(0, 20), warningCount: warnings.length,
        preview: preview.slice(0, 31).map((r) => ({ date: r.date, current: r.from === null ? null : fmt(r.from, cur).amount, new: fmt(r.to, cur).amount, source: r.source })) };
      if (i.dryRun) return { applied: false, ...out };
      if (warnings.length && !i.confirmWarnings) throw new HttpException({ code: 'CONFIRMATION_REQUIRED', message: `${warnings.length} night(s) change by more than ${WARN_CHANGE_PCT}%. Review and confirm.`, warnings: out.warnings }, 409);
      await trx.insertInto('rate_override').values(dates.map((d) => ({ tenant_id: currentTenant().tenantId, property_id: propertyId, rate_plan_id: planId, room_type_id: i.roomTypeId, business_date: d, amount_minor: amount.toString() })))
        .onConflict((oc) => oc.columns(['tenant_id', 'rate_plan_id', 'room_type_id', 'business_date']).doUpdateSet((eb) => ({ amount_minor: eb.ref('excluded.amount_minor') }))).execute();
      await this.audit.record(trx, { action: 'rate.override_set', resourceType: 'rate_plan', resourceId: planId, propertyId, before: preview.slice(0, 60).map((r) => ({ date: r.date, price: r.from === null ? null : fmt(r.from, cur).amount })),
        after: { roomTypeId: i.roomTypeId, from: i.from, to: i.to, price: i.amount, nights: dates.length }, reasonCode: warnings.length ? 'LARGE_CHANGE_CONFIRMED' : undefined });
      await this.outbox.publish(trx, { aggregateType: 'rate_plan', aggregateId: planId, eventType: 'RateChanged', propertyId, payload: { reason: 'override', roomTypeId: i.roomTypeId, from: i.from, to: i.to } });
      return { applied: true, ...out };
    });
  }

  async createRestriction(propertyId: string, planId: string, i: z.infer<typeof S.CreateRestriction>) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId); await this.planRow(trx, propertyId, planId);
      const r = await trx.insertInto('rate_restriction').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, rate_plan_id: planId, room_type_id: i.roomTypeId ?? null, start_date: i.startDate, end_date: i.endDate,
        min_los: i.minLos ?? null, max_los: i.maxLos ?? null, closed_to_arrival: i.closedToArrival, closed_to_departure: i.closedToDeparture, stop_sell: i.stopSell, min_advance_days: i.minAdvanceDays ?? null,
        max_advance_days: i.maxAdvanceDays ?? null, note: i.note ?? null }).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'rate.restriction_create', resourceType: 'rate_plan', resourceId: planId, propertyId, after: { id: r.id, ...i } });
      await this.outbox.publish(trx, { aggregateType: 'rate_plan', aggregateId: planId, eventType: 'RestrictionChanged', propertyId, payload: { from: i.startDate, to: i.endDate } });
      return { id: r.id };
    });
  }
  async deleteRestriction(propertyId: string, planId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.deleteFrom('rate_restriction').where('id', '=', id).where('rate_plan_id', '=', planId).where('property_id', '=', propertyId).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Restriction not found' });
      await this.audit.record(trx, { action: 'rate.restriction_delete', resourceType: 'rate_plan', resourceId: planId, propertyId, before: r });
      await this.outbox.publish(trx, { aggregateType: 'rate_plan', aggregateId: planId, eventType: 'RestrictionChanged', propertyId, payload: { from: r.start_date, to: r.end_date } });
    });
  }

  // ───────── loading for the engine ─────────
  /** Loads the price book of the given BASE plans. */
  private async loadBooks(trx: Trx, propertyId: string, baseIds: string[]): Promise<Map<string, PriceBook>> {
    const out = new Map<string, PriceBook>(baseIds.map((id) => [id, { base: {}, seasons: [], overrides: {} }]));
    if (!baseIds.length) return out;
    const [base, seasons, values, overrides] = await Promise.all([
      trx.selectFrom('rate_base').selectAll().where('rate_plan_id', 'in', baseIds).execute(),
      trx.selectFrom('rate_season').selectAll().where('rate_plan_id', 'in', baseIds).execute(),
      trx.selectFrom('rate_season_value').selectAll().where('rate_plan_id', 'in', baseIds).execute(),
      trx.selectFrom('rate_override').selectAll().where('rate_plan_id', 'in', baseIds).execute(),
    ]);
    for (const b of base) out.get(b.rate_plan_id)!.base[b.room_type_id] = { amount: BigInt(b.amount_minor), weekendAmount: b.weekend_amount_minor === null ? null : BigInt(b.weekend_amount_minor), extraAdult: BigInt(b.extra_adult_minor), extraChild: BigInt(b.extra_child_minor) };
    for (const s of seasons) out.get(s.rate_plan_id)!.seasons.push({ id: s.id, name: s.name, start: s.start_date, end: s.end_date, priority: s.priority, values: {} });
    for (const v of values) { const s = out.get(v.rate_plan_id)!.seasons.find((x) => x.id === v.season_id); if (s) s.values[v.room_type_id] = { amount: BigInt(v.amount_minor), weekendAmount: v.weekend_amount_minor === null ? null : BigInt(v.weekend_amount_minor) }; }
    for (const o of overrides) out.get(o.rate_plan_id)!.overrides[`${o.room_type_id}|${o.business_date}`] = BigInt(o.amount_minor);
    return out;
  }
  private async loadRestrictions(trx: Trx, planIds: string[], from: string, to: string): Promise<Map<string, Restriction[]>> {
    const m = new Map<string, Restriction[]>(planIds.map((id) => [id, []]));
    if (!planIds.length) return m;
    const rows = await trx.selectFrom('rate_restriction').selectAll().where('rate_plan_id', 'in', planIds).where('end_date', '>', from).where('start_date', '<=', to).execute();
    for (const r of rows) m.get(r.rate_plan_id)!.push({ roomTypeId: r.room_type_id, start: r.start_date, end: r.end_date, minLos: r.min_los, maxLos: r.max_los, closedToArrival: r.closed_to_arrival,
      closedToDeparture: r.closed_to_departure, stopSell: r.stop_sell, minAdvanceDays: r.min_advance_days, maxAdvanceDays: r.max_advance_days });
    return m;
  }

  /** Prices one stay on one plan with the CURRENT rates. Used by reservations to re-verify a quote at booking/modification time. */
  async priceOne(trx: Trx, propertyId: string, planId: string, r: { roomTypeId: string; arrival: string; departure: string; adults: number; children: number; extraBeds: number;
    channel: string; residency: 'RESIDENT' | 'NON_RESIDENT'; companyId: string | null }) {
    const p = await this.prop(trx, propertyId);
    const row = await this.planRow(trx, propertyId, planId);
    const baseId = row.kind === 'DERIVED' ? row.parent_rate_plan_id! : row.id;
    const rt = await trx.selectFrom('room_type').selectAll().where('id', '=', r.roomTypeId).where('property_id', '=', propertyId).executeTakeFirst();
    if (!rt) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room type not found' });
    const [books, restr] = await Promise.all([this.loadBooks(trx, propertyId, [baseId]), this.loadRestrictions(trx, [planId], r.arrival, r.departure)]);
    const quote = priceStay({ plan: this.toDef(row, p.currency), book: books.get(baseId)!, restrictions: restr.get(planId) ?? [],
      limits: { maxAdults: rt.max_adults, maxChildren: rt.max_children, maxOccupancy: rt.max_occupancy, baseOccupancy: rt.base_occupancy },
      req: { roomTypeId: r.roomTypeId, arrival: r.arrival, departure: r.departure, adults: r.adults, children: r.children, extraBeds: r.extraBeds, channel: r.channel as never, residency: r.residency,
        companyId: r.companyId, today: p.business_date, weekendDays: p.weekend_days } });
    return { quote, currency: p.currency, businessDate: p.business_date };
  }

  /** A signed quote for exactly one room/plan with no discount — used by flows that price and book in one step (walk-ins). */
  async issueQuoteToken(trx: Trx, propertyId: string, planId: string, r: Parameters<RatesService['priceOne']>[3]): Promise<string> {
    if (r.companyId) await this.companies.assertBookable(trx, r.companyId);
    const { quote, currency } = await this.priceOne(trx, propertyId, planId, r);
    if (!quote.sellable) throw new HttpException({ code: 'NOT_SELLABLE', message: 'This rate is not available for these dates', reasons: quote.reasons }, 409);
    const nightsHash = Buffer.from(quote.nights.map((n) => `${n.date}:${n.totalMinor}`).join('|')).toString('base64url').slice(0, 64);
    return this.signer.sign({ propertyId, planId, roomTypeId: r.roomTypeId, arrival: r.arrival, departure: r.departure, adults: r.adults, children: r.children, extraBeds: r.extraBeds,
      channel: r.channel, residency: r.residency, companyId: r.companyId, currency, subtotalMinor: quote.subtotalMinor.toString(), discountPct: 0, discountApproved: true,
      depositDueMinor: quote.depositDueMinor.toString(), nightsHash }, 900, this.clock.now());
  }

  // ───────── calendar ─────────
  async calendar(propertyId: string, planId: string, from: string, to: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const cur = p.currency;
      const row = await this.planRow(trx, propertyId, planId);
      const def = this.toDef(row, cur);
      const baseId = row.kind === 'DERIVED' ? row.parent_rate_plan_id! : row.id;
      const [books, restr, types, avail] = await Promise.all([
        this.loadBooks(trx, propertyId, [baseId]), this.loadRestrictions(trx, [planId], from, to),
        trx.selectFrom('room_type').select(['id', 'code', 'name']).where('property_id', '=', propertyId).where('status', '=', 'ACTIVE').orderBy('sort_order').orderBy('code').execute(),
        this.inv.getAvailability(trx, propertyId, from, to),
      ]);
      const book = books.get(baseId)!;
      const days = nightsOf(from, to, 400);
      return {
        plan: { id: def.id, code: def.code, name: def.name, kind: def.kind, currency: cur }, weekendDays: p.weekend_days,
        roomTypes: types.map((t) => ({
          roomTypeId: t.id, code: t.code, name: t.name,
          nights: days.map((d) => {
            const price = calendarNight(def, book, t.id, d, p.weekend_days);
            const rs = (restr.get(planId) ?? []).filter((r) => (r.roomTypeId === null || r.roomTypeId === t.id) && r.start <= d && d < r.end);
            const a = avail.find((x) => x.roomTypeId === t.id)?.nights.find((n) => n.date === d);
            return { date: d, price: price ? fmt(price.amount, cur).amount : null, source: price?.source ?? null, stopSell: rs.some((r) => r.stopSell), closedToArrival: rs.some((r) => r.closedToArrival),
              closedToDeparture: rs.some((r) => r.closedToDeparture), minLos: rs.reduce<number | null>((m, r) => (r.minLos ? Math.max(m ?? 1, r.minLos) : m), null), available: a?.available ?? null };
          }),
        })),
      };
    });
  }

  // ───────── quotes (search) ─────────
  async quote(propertyId: string, userId: string, i: z.infer<typeof S.QuoteRequest>) {
    const stayDates = nightsOf(i.arrival, i.departure, 90);
    for (const o of i.nightDiscounts) if (!stayDates.includes(o.date)) throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', message: `${o.date} is not a night of this stay` });
    const perNight = i.nightDiscounts.length > 0;
    const nightBp = nightBpFor(stayDates, i.discountPct, i.nightDiscounts);
    const topPct = Math.max(...nightBp) / 100;                                       // the deepest cut decides whether the person may give it
    const discount = topPct > 0 ? await this.authz.check(userId, { permission: 'reservation.create', scope: { propertyId }, discountPct: topPct }) : { effect: 'ALLOW' as const };
    if (discount.effect === 'DENY') throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You may not create quotes for this property' });
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId); const cur = p.currency;
      if (p.status !== 'LIVE') throw new UnprocessableEntityException({ code: 'PROPERTY_NOT_LIVE', message: 'This property is not live yet' });
      if (i.arrival < p.business_date) throw new UnprocessableEntityException({ code: 'DATE_IN_PAST', message: `Arrival cannot be before the business date (${p.business_date})` });
      nightsOf(i.arrival, i.departure, 90);
      if (i.companyId) await this.companies.assertBookable(trx, i.companyId);
      const planRows = await trx.selectFrom('rate_plan').selectAll().where('property_id', '=', propertyId).where('status', '=', 'ACTIVE').orderBy('sort_order').orderBy('code').execute();
      const baseIds = [...new Set(planRows.map((r) => (r.kind === 'DERIVED' ? r.parent_rate_plan_id! : r.id)))];
      const [books, restr, types, avail] = await Promise.all([
        this.loadBooks(trx, propertyId, baseIds), this.loadRestrictions(trx, planRows.map((r) => r.id), i.arrival, i.departure),
        trx.selectFrom('room_type').selectAll().where('property_id', '=', propertyId).where('status', '=', 'ACTIVE').orderBy('sort_order').orderBy('code').execute(),
        this.inv.getAvailability(trx, propertyId, i.arrival, i.departure),
      ]);
      const options: Array<{ sortKey: bigint; roomOrder: number; [k: string]: unknown }> = [];
      for (const t of types) {
        if (i.roomTypeId && t.id !== i.roomTypeId) continue;
        const nights = avail.find((a) => a.roomTypeId === t.id)?.nights ?? [];
        const rooms = nights.length === nightsOf(i.arrival, i.departure).length ? Math.min(...nights.map((n) => n.available)) : 0;
        const limits: RoomTypeLimits = { maxAdults: t.max_adults, maxChildren: t.max_children, maxOccupancy: t.max_occupancy, baseOccupancy: t.base_occupancy };
        for (const pr of planRows) {
          const baseId = pr.kind === 'DERIVED' ? pr.parent_rate_plan_id! : pr.id;
          const q = priceStay({ plan: this.toDef(pr, cur), book: books.get(baseId)!, restrictions: restr.get(pr.id) ?? [], limits,
            req: { roomTypeId: t.id, arrival: i.arrival, departure: i.departure, adults: i.adults, children: i.children, extraBeds: i.extraBeds, channel: i.channel, residency: i.residency, companyId: i.companyId ?? null, today: p.business_date, weekendDays: p.weekend_days } });
          const reasons: Array<{ code: string; message: string }> = [...q.reasons];
          if (rooms < 1) reasons.push({ code: 'SOLD_OUT', message: 'Sold out for these dates' });
          const eligible = q.reasons.length === 0;
          if (!(eligible && rooms >= 1) && !i.includeUnavailable) continue;           // sold-out or ineligible options are listed only on request
          const nightCuts = perNight ? perNightDiscounts(q.nights.map((n) => n.totalMinor), nightBp) : null;
          const discounted = nightCuts ? q.subtotalMinor - nightCuts.reduce((a, b) => a + b, 0n) : i.discountPct > 0 ? q.subtotalMinor - (q.subtotalMinor * BigInt(Math.round(i.discountPct * 100))) / 10000n : q.subtotalMinor;
          const bookable = eligible && rooms >= 1 && discount.effect === 'ALLOW';
          const nightsHash = Buffer.from(q.nights.map((n) => `${n.date}:${n.totalMinor}`).join('|')).toString('base64url').slice(0, 64);
          // tax on top of the price, worked out the way the ledger will: per night, on room and extras, less the discount's share of that night
          const discountMinor = q.subtotalMinor - discounted;
          const shares = nightCuts ?? (discountMinor > 0n ? Money.ofMinor(discountMinor, cur).allocate(q.nights.map((n) => n.totalMinor)).map((m) => m.minor) : q.nights.map(() => 0n));
          const taxLines = q.nights.flatMap((n, k) => [{ date: n.date, txnCode: 'ROOM', netMinor: n.roomMinor }, { date: n.date, txnCode: 'ROOM_EXTRAS', netMinor: n.totalMinor - n.roomMinor }, { date: n.date, txnCode: 'ROOM', netMinor: -shares[k]! }]);
          const perDate = new Map<string, Array<{ txnCode: string; netMinor: bigint }>>();
          for (const l of taxLines) perDate.set(l.date, [...(perDate.get(l.date) ?? []), l]);
          const taxByCode = new Map<string, { code: string; rateBp: number; taxableMinor: bigint; taxMinor: bigint }>();
          for (const [date, ls] of perDate) { const r = await this.tax.previewIn(trx, propertyId, { date, residency: i.residency, lines: ls }); for (const e of r.byCode) { const k = `${e.code}:${e.rateBp}`; const x = taxByCode.get(k) ?? { ...e, taxableMinor: 0n, taxMinor: 0n }; x.taxableMinor += e.taxableMinor; x.taxMinor += e.taxMinor; taxByCode.set(k, x); } }
          const taxTotal = [...taxByCode.values()].reduce((a, e) => a + e.taxMinor, 0n);
          options.push({
            sortKey: discounted, roomOrder: types.indexOf(t),
            roomType: { id: t.id, code: t.code, name: t.name }, plan: { id: pr.id, code: pr.code, name: pr.name, mealPlan: pr.meal_plan },
            sellable: eligible, available: rooms >= 1, roomsLeft: Math.max(0, rooms), bookable, reasons: reasons.map((r) => ({ code: r.code, message: r.message })),
            nights: q.nights.map((n, k) => ({ date: n.date, source: n.source, room: fmt(n.roomMinor, cur).amount, extras: fmt(n.totalMinor - n.roomMinor, cur).amount, total: fmt(n.totalMinor, cur).amount,
              discountPct: (nightBp[k] ?? 0) / 100, discount: fmt(shares[k]!, cur).amount, payable: fmt(n.totalMinor - shares[k]!, cur).amount })),
            subtotal: fmt(q.subtotalMinor, cur), discount: topPct > 0 ? { pct: topPct, amount: fmt(q.subtotalMinor - discounted, cur).amount, status: discount.effect === 'ALLOW' ? 'APPLIED' : 'APPROVAL_REQUIRED' } : null,
            totalExTax: fmt(discounted, cur), taxNote: 'Amounts exclude tax. Taxes are added at the end of the quote and on the invoice.',
            taxes: [...taxByCode.values()].map((e) => ({ code: e.code, ratePercent: e.rateBp / 100, taxable: fmt(e.taxableMinor, cur), tax: fmt(e.taxMinor, cur) })), taxTotal: fmt(taxTotal, cur), totalIncTax: fmt(discounted + taxTotal, cur),
            depositDue: fmt(q.depositDueMinor, cur), policy: q.policy,
            quoteToken: bookable ? this.signer.sign({ propertyId, planId: pr.id, roomTypeId: t.id, arrival: i.arrival, departure: i.departure, adults: i.adults, children: i.children, extraBeds: i.extraBeds,
              channel: i.channel, residency: i.residency, companyId: i.companyId ?? null, currency: cur, subtotalMinor: discounted.toString(), discountPct: i.discountPct, discountApproved: discount.effect === 'ALLOW', ...(perNight ? { nightBp } : {}),
              depositDueMinor: q.depositDueMinor.toString(), nightsHash }, 900, this.clock.now()) : null,
          });
        }
      }
      options.sort((a, b) => a.roomOrder - b.roomOrder || (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));          // room types in house order, cheapest rate first
      return { arrival: i.arrival, departure: i.departure, nights: nightsOf(i.arrival, i.departure).length, currency: cur, businessDate: p.business_date,
        options: options.map(({ sortKey: _k, roomOrder: _o, ...rest }) => rest) };
    });
  }
}

export { decide, addDays };
