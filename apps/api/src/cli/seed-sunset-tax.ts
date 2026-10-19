import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createDb } from '@hos/db';
import { AppModule } from '../app.module.js';
import { TaxService } from '../tax/tax.service.js';
import { runWithTenant } from '../tenancy/tenant-context.js';
import { TAX_MATRIX } from './sunset-data.js';

/**
 * Enters the owner's tax matrix as DRAFTS (the accountant is the author) and points each property at its tax area. Nothing is charged until a different person
 * with the right permission approves each draft, with the advisor's reference and the legal basis, and a fresh second factor — that is the rule for every rate.
 * Also sets up the charge reviews (withholding-tax review in Islamabad, vendor verification in Karachi). Safe to re-run.
 * Development convenience: run after seed:demo-staff, which creates accountant@sunset.local (the author) — the owner then approves.
 */
const SLUG = process.env.SEED_TENANT_SLUG ?? 'sunset';
const EFFECTIVE_FROM = process.env.SEED_TAX_EFFECTIVE_FROM ?? '2026-01-01';          // PLACEHOLDER — edit the draft to the real effective date before approving

const admin = createDb(process.env.DATABASE_URL_ADMIN!, 2);
const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
try {
  const tenant = await admin.selectFrom('tenant').select('id').where('slug', '=', SLUG).executeTakeFirstOrThrow();
  const author = await admin.selectFrom('staff_user').select('id').where('tenant_id', '=', tenant.id).where('email', '=', 'accountant@sunset.local').executeTakeFirst();
  if (!author) throw new Error('accountant@sunset.local not found — run seed:demo-staff first (it creates the author of the drafts)');
  const owner = await admin.selectFrom('staff_user').select('id').where('tenant_id', '=', tenant.id).orderBy('created_at').executeTakeFirstOrThrow();
  const tax = app.get(TaxService);
  await runWithTenant({ tenantId: tenant.id, actorId: author.id, requestId: 'seed-tax' }, async () => {
    for (const area of TAX_MATRIX) {
      for (const c of area.codes) {
        const exists = await admin.selectFrom('tax_code').select('id').where('tenant_id', '=', tenant.id).where('code', '=', c.code).executeTakeFirst();
        if (exists) { console.log(`• ${c.code}: already entered, skipped`); continue; }
        await tax.createCode(author.id, { code: c.code, name: c.name, jurisdiction: area.jurisdiction, version: { rateBp: c.rateBp, appliesTo: c.appliesTo as never, effectiveFrom: EFFECTIVE_FROM, determinationPoint: 'ON_POSTING', inputTaxTreatment: 'NOT_APPLICABLE', legalBasis: null, advisorRef: null } });
        console.log(`✔ ${c.code}: ${c.rateBp / 100}% on ${c.appliesTo.join(', ')} — DRAFT`);
      }
      const props = await admin.selectFrom('property').select(['id', 'name']).where('tenant_id', '=', tenant.id).where('code', 'in', area.propertyCodes as never).execute();
      for (const p of props) { await tax.setPropertyJurisdiction(p.id, area.jurisdiction); console.log(`✔ ${p.name} → ${area.jurisdiction}`); }
      for (const r of area.reviews) {
        await admin.insertInto('charge_review_rule').values({ tenant_id: tenant.id, jurisdiction: area.jurisdiction, txn_code: r.txnCode, kind: r.kind, message: r.message, created_by: owner.id } as never).onConflict((oc) => oc.columns(['tenant_id', 'jurisdiction', 'txn_code', 'kind']).doNothing()).execute();
        console.log(`✔ ${area.jurisdiction}: ${r.kind} on ${r.txnCode}`);
      }
    }
  });
  console.log('\nThe tax rates are DRAFTS. Sign in as owner@sunset.local (second factor set up), open Tax, set the real effective date and approve each rate with the advisor\'s reference.');
} finally { await app.close(); await admin.destroy(); }
