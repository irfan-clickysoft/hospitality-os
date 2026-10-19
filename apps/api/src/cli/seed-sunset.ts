import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { ProvisioningService } from '../provisioning/provisioning.service.js';
import { PropertySetupService } from '../property-setup/property-setup.service.js';
import { runWithTenant } from '../tenancy/tenant-context.js';
import { PROPERTIES } from './sunset-data.js';

/**
 * Seeds the Sunset pilot for local development: one tenant, three properties (Boulevard 9 rooms, Creek 10, Ramna 8) with the room types each one sells (see sunset-data.ts),
 * with the real room numbers and floors (from the owner).
 * Safe to run once per database; it refuses if the tenant slug already exists.
 */
const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL ?? 'owner@sunset.local';
const SLUG = process.env.SEED_TENANT_SLUG ?? 'sunset';

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
try {
  const t = await app.get(ProvisioningService).createTenant({ name: 'Sunset Hospitality', slug: SLUG, ownerEmail: OWNER_EMAIL, ownerName: 'Irfan A Rehman', legalEntityName: 'Sunset Hospitality' });
  const svc = app.get(PropertySetupService);
  await runWithTenant({ tenantId: t.tenantId, actorId: t.ownerUserId, requestId: 'seed-sunset' }, async () => {
    for (const p of PROPERTIES) {
      const prop = await svc.createProperty({ legalEntityId: t.legalEntityId, code: p.code, name: p.name, timezone: p.tz, currency: 'PKR' });
      const floors = new Map<string, string>();
      for (const [i, name] of p.floorOrder.entries()) floors.set(name, (await svc.createFloor(prop.id, { name, sortOrder: i, buildingId: null })).id);
      let count = 0;
      for (const [i, ty] of p.types.entries()) {
        const rt = await svc.createRoomType(prop.id, { code: ty.code, name: ty.name, maxAdults: ty.maxAdults, maxChildren: 1, maxOccupancy: ty.maxOccupancy, baseOccupancy: Math.min(2, ty.maxOccupancy), defaultOverbookLimit: 0, sortOrder: i });
        for (const [floor, numbers] of ty.floors) for (const number of numbers) { await svc.createRoom(prop.id, { roomTypeId: rt.id, number, floorId: floors.get(floor)!, smoking: false, accessible: false }); count++; }
      }
      const live = await svc.goLive(prop.id, {});
      console.log(`✔ ${p.name} (${p.city}): ${count} rooms, live from ${live.businessDate}`);
    }
  });
  console.log(`\nTenant "${SLUG}" created.\nOwner: ${OWNER_EMAIL}\nOne-time invite token (valid 7 days):\n  ${t.ownerInviteToken}\n`);
  console.log(`Set the password:\n  curl -sS -X POST localhost:3000/v1/auth/accept-invite -H 'content-type: application/json' \\\n    -d '{"tenant":"${SLUG}","token":"${t.ownerInviteToken}","password":"<choose a 12+ character passphrase>"}'`);
} finally {
  await app.close();
}
