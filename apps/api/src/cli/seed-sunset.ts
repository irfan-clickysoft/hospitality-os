import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { ProvisioningService } from '../provisioning/provisioning.service.js';
import { PropertySetupService } from '../property-setup/property-setup.service.js';
import { runWithTenant } from '../tenancy/tenant-context.js';
import { PROPERTIES } from './sunset-data.js';

/**
 * Seeds the Sunset pilot for local development: one tenant, three properties (Boulevard 9 rooms, Creek 10, Ramna 8) with the room types each one sells (see sunset-data.ts).
 * The split of rooms across types is a PLACEHOLDER (counts per property and the types are real; the per-type split must be corrected after the observation week).
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
      let n = p.firstRoom;
      for (const [i, ty] of p.types.entries()) {
        const floor = await svc.createFloor(prop.id, { name: ty.floor, sortOrder: i, buildingId: null }).catch(() => null);
        const rt = await svc.createRoomType(prop.id, { code: ty.code, name: ty.name, maxAdults: ty.maxAdults, maxChildren: 1, maxOccupancy: ty.maxOccupancy, baseOccupancy: Math.min(2, ty.maxOccupancy), defaultOverbookLimit: 0, sortOrder: i });
        await svc.bulkRooms(prop.id, { roomTypeId: rt.id, floorId: floor?.id ?? null, from: n, to: n + ty.rooms - 1, prefix: '', smoking: false, accessible: false });
        n += ty.rooms;
      }
      const live = await svc.goLive(prop.id, {});
      console.log(`✔ ${p.name} (${p.city}): ${n - p.firstRoom} rooms, live from ${live.businessDate}`);
    }
  });
  console.log(`\nTenant "${SLUG}" created.\nOwner: ${OWNER_EMAIL}\nOne-time invite token (valid 7 days):\n  ${t.ownerInviteToken}\n`);
  console.log(`Set the password:\n  curl -sS -X POST localhost:3000/v1/auth/accept-invite -H 'content-type: application/json' \\\n    -d '{"tenant":"${SLUG}","token":"${t.ownerInviteToken}","password":"<choose a 12+ character passphrase>"}'`);
} finally {
  await app.close();
}
