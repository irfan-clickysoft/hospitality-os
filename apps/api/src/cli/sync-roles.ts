import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { ProvisioningService } from '../provisioning/provisioning.service.js';

/** Brings every tenant's built-in roles up to date with the code (new roles, newly introduced permissions). Safe to run any time; it only adds. */
const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
try {
  const r = await app.get(ProvisioningService).syncSystemRoles(process.env.TENANT_ID);
  console.log(`Synced ${r.tenants} tenant(s): ${r.rolesAdded} role(s) added, ${r.permissionsAdded} permission(s) added.`);
} finally { await app.close(); }
