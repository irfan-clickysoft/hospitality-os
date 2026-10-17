import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { ProvisioningService } from '../provisioning/provisioning.service.js';
import { PropertySetupService } from '../property-setup/property-setup.service.js';
import { runWithTenant } from '../tenancy/tenant-context.js';

/**
 * Seeds the Sunset pilot for local development: one tenant, three properties (Boulevard 9 rooms, Creek 10, Ramna 8), three room types each.
 * The split of rooms across types is a PLACEHOLDER (counts per property are real; the per-type split must be corrected after the observation week).
 * Safe to run once per database; it refuses if the tenant slug already exists.
 */
const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL ?? 'owner@sunset.local';
const SLUG = process.env.SEED_TENANT_SLUG ?? 'sunset';

const PROPERTIES = [
  { code: 'BLVD', name: 'Sunset BnB Boulevard', city: 'Karachi', tz: 'Asia/Karachi', rooms: { STD: 3, DLX: 3, EXE: 3 }, firstRoom: 101 },
  { code: 'CREEK', name: 'Sunset BnB Creek', city: 'Karachi', tz: 'Asia/Karachi', rooms: { STD: 4, DLX: 3, EXE: 3 }, firstRoom: 101 },
  { code: 'RAMNA', name: 'Sunset BnB Ramna', city: 'Islamabad', tz: 'Asia/Karachi', rooms: { STD: 3, DLX: 3, EXE: 2 }, firstRoom: 101 },
] as const;
const TYPES = [
  { code: 'STD', name: 'Standard', maxAdults: 2, maxOccupancy: 3, floor: 'Ground' },
  { code: 'DLX', name: 'Deluxe', maxAdults: 2, maxOccupancy: 3, floor: 'First' },
  { code: 'EXE', name: 'Executive', maxAdults: 2, maxOccupancy: 3, floor: 'Second' },
] as const;

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
try {
  const t = await app.get(ProvisioningService).createTenant({ name: 'Sunset Hospitality', slug: SLUG, ownerEmail: OWNER_EMAIL, ownerName: 'Irfan A Rehman', legalEntityName: 'Sunset Hospitality' });
  const svc = app.get(PropertySetupService);
  await runWithTenant({ tenantId: t.tenantId, actorId: t.ownerUserId, requestId: 'seed-sunset' }, async () => {
    for (const p of PROPERTIES) {
      const prop = await svc.createProperty({ legalEntityId: t.legalEntityId, code: p.code, name: p.name, timezone: p.tz, currency: 'PKR' });
      let n = p.firstRoom;
      for (const ty of TYPES) {
        const floor = await svc.createFloor(prop.id, { name: ty.floor, sortOrder: TYPES.indexOf(ty), buildingId: null }).catch(() => null);
        const rt = await svc.createRoomType(prop.id, { code: ty.code, name: ty.name, maxAdults: ty.maxAdults, maxChildren: 1, maxOccupancy: ty.maxOccupancy, baseOccupancy: 2, defaultOverbookLimit: 0, sortOrder: TYPES.indexOf(ty) });
        const count = p.rooms[ty.code];
        await svc.bulkRooms(prop.id, { roomTypeId: rt.id, floorId: floor?.id ?? null, from: n, to: n + count - 1, prefix: '', smoking: false, accessible: false });
        n += count;
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
