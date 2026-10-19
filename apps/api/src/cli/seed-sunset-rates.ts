import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { createDb, resolveTenantBySlug, withTenant } from '@hos/db';
import { RatesService } from '../rates/rates.service.js';
import { runWithTenant } from '../tenancy/tenant-context.js';
import { loadConfig } from '../config.js';
import { EXTRAS, INTERNATIONAL_UPLIFT_BP, PROPERTIES } from './sunset-data.js';

/**
 * Adds the rate plans to the seeded Sunset tenant: BAR (local) with the owner's rate card per room type (sunset-data.ts), and INTL (international guests, +0% for now).
 * Weekend and weekday prices are the same (no weekend price). Extra person (breakfast included) and extra mattress are the owner's prices; the international plan is
 * +0% for now (foreign and local guests pay the same) so it can be changed later. Safe to re-run: skips properties that already have a BAR plan.
 */
const SLUG = process.env.SEED_TENANT_SLUG ?? 'sunset';
const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
const db = createDb(loadConfig().databaseUrlApp, 2);
try {
  const t = await resolveTenantBySlug(db, SLUG);
  if (!t) throw new Error(`tenant "${SLUG}" not found — run seed:sunset first`);
  const owner = await withTenant(db, t.id, (trx) => trx.selectFrom('staff_user').select('id').orderBy('created_at').executeTakeFirstOrThrow());
  const props = await withTenant(db, t.id, (trx) => trx.selectFrom('property').select(['id', 'code', 'name']).orderBy('name').execute());
  const rates = app.get(RatesService);
  await runWithTenant({ tenantId: t.id, actorId: owner.id, requestId: 'seed-rates' }, async () => {
    for (const p of props) {
      if ((await rates.listPlans(p.id)).some((x) => x.code === 'BAR')) { console.log(`• ${p.name}: already has rates, skipped`); continue; }
      const def = PROPERTIES.find((x) => x.code === p.code);
      if (!def) { console.log(`• ${p.name}: not in the rate card, skipped`); continue; }
      const types = await withTenant(db, t.id, (trx) => trx.selectFrom('room_type').select(['id', 'code']).where('property_id', '=', p.id).execute());
      const bar = await rates.createPlan(p.id, { code: 'BAR', name: 'Best Available Rate (local)', mealPlan: 'ROOM_ONLY', audience: 'PUBLIC', residency: 'RESIDENT',
        channels: ['DIRECT', 'PHONE', 'WALKIN', 'OTA', 'CORPORATE', 'AGENT'], companyIds: [], minLos: 1, minAdvanceDays: 0, extraBed: EXTRAS.extraBed, extraAdultMeal: '0', extraChildMeal: '0',
        cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 }, sortOrder: 0 });
      await rates.setBaseRates(p.id, bar.id, { items: types.map((ty) => ({ roomTypeId: ty.id, amount: def.types.find((x) => x.code === ty.code)!.price, extraAdult: EXTRAS.extraAdult, extraChild: EXTRAS.extraChild })) });
      await rates.createPlan(p.id, { code: 'INTL', name: 'International guests', mealPlan: 'ROOM_ONLY', audience: 'PUBLIC', residency: 'NON_RESIDENT',
        channels: ['DIRECT', 'PHONE', 'WALKIN', 'OTA', 'CORPORATE', 'AGENT'], companyIds: [], minLos: 1, minAdvanceDays: 0, extraBed: EXTRAS.extraBed, extraAdultMeal: '0', extraChildMeal: '0',
        cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 }, sortOrder: 1,
        derive: { parentPlanId: bar.id, type: 'PERCENT', value: INTERNATIONAL_UPLIFT_BP, roundTo: '100' } });
      console.log(`✔ ${p.name}: BAR from the rate card + INTL (same as local for now)`);
    }
  });
} finally { await db.destroy(); await app.close(); }
