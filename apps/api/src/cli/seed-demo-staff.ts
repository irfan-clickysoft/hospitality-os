import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createDb } from '@hos/db';
import { AppModule } from '../app.module.js';
import { HousekeepingService } from '../housekeeping/housekeeping.service.js';
import { PasswordService } from '../identity/password.service.js';
import { runWithTenant } from '../tenancy/tenant-context.js';

/**
 * Development only. Adds a housekeeping team, a front-desk agent and a property admin to the seeded Sunset Boulevard property, with a shared dev password, and queues a few rooms so the staff app has
 * something to show. Run after `seed:sunset`. Refuses to run in production.
 */
if (process.env.NODE_ENV === 'production') throw new Error('seed-demo-staff is for local development only');
const SLUG = process.env.SEED_TENANT_SLUG ?? 'sunset';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'sunset-demo-passphrase';
const TEAM = [
  { email: 'sana@sunset.local', name: 'Sana Khan (supervisor)', role: 'housekeeping_supervisor', locale: 'en' },
  { email: 'bilal@sunset.local', name: 'Bilal Ahmed', role: 'housekeeper', locale: 'en' },
  { email: 'ayesha@sunset.local', name: 'عائشہ بی بی', role: 'housekeeper', locale: 'ur' },
  { email: 'hira@sunset.local', name: 'Hira Malik (front desk)', role: 'front_desk_agent', locale: 'en' },
  { email: 'manager@sunset.local', name: 'Omar Sheikh (property admin)', role: 'property_admin', locale: 'en' },
  { email: 'gate@sunset.local', name: 'گیٹ سیکیورٹی (Imtiaz)', role: 'gate_security', locale: 'ur' },
  { email: 'accountant@sunset.local', name: 'Farah Siddiqui (accountant)', role: 'accountant', locale: 'en' },
] as const;

const admin = createDb(process.env.DATABASE_URL_ADMIN!, 2);
const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
try {
  const tenant = await admin.selectFrom('tenant').select('id').where('slug', '=', SLUG).executeTakeFirstOrThrow();
  const prop = await admin.selectFrom('property').select(['id', 'business_date']).where('tenant_id', '=', tenant.id).where('code', '=', 'BLVD').executeTakeFirstOrThrow();
  const owner = await admin.selectFrom('staff_user').select('id').where('tenant_id', '=', tenant.id).orderBy('created_at').executeTakeFirstOrThrow();
  const hash = await app.get(PasswordService).hash(PASSWORD);
  // the owner (created by seed:sunset with a one-time link) gets the same dev password so local work needs no invite step; set up the second factor under My account to use the sensitive screens
  await admin.updateTable('staff_user').set({ password_hash: hash, status: 'ACTIVE' } as never).where('id', '=', owner.id).where('password_hash', 'is', null).execute();
  const ids: Record<string, string> = {};
  for (const m of TEAM) {
    let u = await admin.selectFrom('staff_user').select('id').where('tenant_id', '=', tenant.id).where('email', '=', m.email).executeTakeFirst();
    if (!u) u = await admin.insertInto('staff_user').values({ tenant_id: tenant.id, email: m.email, full_name: m.name, password_hash: hash, status: 'ACTIVE', preferred_locale: m.locale } as never).returning('id').executeTakeFirstOrThrow();
    const role = await admin.selectFrom('role').select('id').where('tenant_id', '=', tenant.id).where('key', '=', m.role).executeTakeFirstOrThrow();
    const has = await admin.selectFrom('role_assignment').select('id').where('tenant_id', '=', tenant.id).where('user_id', '=', u.id).where('role_id', '=', role.id).executeTakeFirst();
    if (!has) await admin.insertInto('role_assignment').values({ tenant_id: tenant.id, user_id: u.id, role_id: role.id, ...(m.role === 'accountant' ? { scope_type: 'TENANT', scope_id: null } : { scope_type: 'PROPERTY', scope_id: prop.id }), limits: '{}' } as never).execute();
    ids[m.email] = u.id;
  }
  // rooms in type order (cheapest type first): the first four stay clean, so the front-desk demo always has a clean Standard room to sell
  const rooms = await admin.selectFrom('room').innerJoin('room_type', 'room_type.id', 'room.room_type_id').select(['room.id as id', 'room.number as number']).where('room.property_id', '=', prop.id).orderBy('room_type.sort_order').orderBy('room.number').execute();
  const hk = app.get(HousekeepingService);
  await runWithTenant({ tenantId: tenant.id, actorId: owner.id, requestId: 'seed-demo-staff' }, async () => {
    const existing = await admin.selectFrom('housekeeping_task').select('id').where('property_id', '=', prop.id).executeTakeFirst();
    if (existing) { console.log('Tasks already exist — leaving them alone.'); return; }
    const plan: Array<[number, 'ON_DEMAND' | 'DEEP_CLEAN', number, string | null]> = [[5, 'ON_DEMAND', 2, 'bilal@sunset.local'], [6, 'ON_DEMAND', 3, 'bilal@sunset.local'], [7, 'DEEP_CLEAN', 3, 'ayesha@sunset.local'], [8, 'ON_DEMAND', 1, 'ayesha@sunset.local'], [4, 'ON_DEMAND', 3, null]];
    for (const [i, type, priority, who] of plan) {
      const room = rooms[i]; if (!room) continue;
      await admin.updateTable('room').set({ hk_status: 'DIRTY' }).where('id', '=', room.id).execute();
      await hk.createManual(prop.id, owner.id, { roomId: room.id, taskType: type, priority, notes: priority === 1 ? 'VIP arriving this afternoon' : null, assignTo: who ? ids[who] : undefined });
    }
  });
  console.log(`\nDemo housekeeping team created for ${SLUG} / Sunset BnB Boulevard (password for all: ${PASSWORD}):`);
  for (const m of TEAM) console.log(`  ${m.email.padEnd(22)} ${m.role}`);
  console.log(`  ${'owner@sunset.local'.padEnd(22)} group_owner (whole business; set up the second factor under My account)`);
  console.log('\nStart the API (pnpm --filter @hos/api dev) and the staff app (pnpm --filter @hos/staff-web dev), then open http://localhost:3001');
} finally {
  await app.close(); await admin.destroy();
}
