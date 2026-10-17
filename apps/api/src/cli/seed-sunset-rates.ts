import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { createDb, resolveTenantBySlug, withTenant } from '@hos/db';
import { RatesService } from '../rates/rates.service.js';
import { runWithTenant } from '../tenancy/tenant-context.js';
import { loadConfig } from '../config.js';

/**
 * Adds PLACEHOLDER rate plans to the seeded Sunset tenant (BAR local, INTL +25%). The prices are illustrative only —
 * replace them with Sunset's real rate card. Safe to re-run: skips properties that already have a BAR plan.
 */
const SLUG = process.env.SEED_TENANT_SLUG ?? 'sunset';
const PRICES: Record<string, { amount: string; weekend: string; extraAdult: string; extraChild: string }> = {
  STD: { amount: '12000', weekend: '15000', extraAdult: '3000', extraChild: '1500' },
  DLX: { amount: '15000', weekend: '18000', extraAdult: '3500', extraChild: '1500' },
  EXE: { amount: '20000', weekend: '24000', extraAdult: '4000', extraChild: '2000' },
};

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
      const types = await withTenant(db, t.id, (trx) => trx.selectFrom('room_type').select(['id', 'code']).where('property_id', '=', p.id).execute());
      const bar = await rates.createPlan(p.id, { code: 'BAR', name: 'Best Available Rate (local)', mealPlan: 'ROOM_ONLY', audience: 'PUBLIC', residency: 'RESIDENT',
        channels: ['DIRECT', 'PHONE', 'WALKIN', 'OTA', 'CORPORATE', 'AGENT'], companyIds: [], minLos: 1, minAdvanceDays: 0, extraBed: '2000', extraAdultMeal: '0', extraChildMeal: '0',
        cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 }, sortOrder: 0 });
      await rates.setBaseRates(p.id, bar.id, { items: types.map((ty) => ({ roomTypeId: ty.id, amount: PRICES[ty.code]!.amount, weekendAmount: PRICES[ty.code]!.weekend, extraAdult: PRICES[ty.code]!.extraAdult, extraChild: PRICES[ty.code]!.extraChild })) });
      await rates.createPlan(p.id, { code: 'INTL', name: 'International guests (+25%)', mealPlan: 'ROOM_ONLY', audience: 'PUBLIC', residency: 'NON_RESIDENT',
        channels: ['DIRECT', 'PHONE', 'WALKIN', 'OTA', 'CORPORATE', 'AGENT'], companyIds: [], minLos: 1, minAdvanceDays: 0, extraBed: '2000', extraAdultMeal: '0', extraChildMeal: '0',
        cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 }, sortOrder: 1,
        derive: { parentPlanId: bar.id, type: 'PERCENT', value: 2500, roundTo: '100' } });
      console.log(`✔ ${p.name}: BAR + INTL (placeholder prices)`);
    }
  });
} finally { await db.destroy(); await app.close(); }
