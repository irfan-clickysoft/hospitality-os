import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { ProvisioningService } from '../provisioning/provisioning.service.js';

/**
 * Creates a business (tenant) with its owner and built-in roles, and prints the owner's one-time sign-up link. Use it once per customer on a real server:
 *   node apps/api/dist/cli/provision-tenant.js --slug sunset --name "Sunset Hospitality" --owner-email owner@example.com --owner-name "Owner Name" --site https://hos.example.com
 * The link is shown once and only its hash is stored; send it to the owner yourself.
 */
const { values: v } = parseArgs({ options: { slug: { type: 'string' }, name: { type: 'string' }, 'owner-email': { type: 'string' }, 'owner-name': { type: 'string' }, 'legal-entity': { type: 'string' }, site: { type: 'string' } } });
if (!v.slug || !v.name || !v['owner-email'] || !v['owner-name']) { console.error('usage: provision-tenant --slug <slug> --name <business name> --owner-email <email> --owner-name <name> [--legal-entity <name>] [--site https://your.domain]'); process.exit(2); }
if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(v.slug)) { console.error('slug: lower-case letters, digits and dashes (2–41 characters)'); process.exit(2); }

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
try {
  const t = await app.get(ProvisioningService).createTenant({ name: v.name, slug: v.slug, ownerEmail: v['owner-email'], ownerName: v['owner-name'], legalEntityName: v['legal-entity'] ?? v.name });
  const base = (v.site ?? '').replace(/\/$/, '');
  console.log(`Business "${v.name}" created (tenant ${t.tenantId}).`);
  console.log(`Owner sign-up link (valid 7 days, shown once):\n${base}/?invite=${encodeURIComponent(t.ownerInviteToken)}&tenant=${encodeURIComponent(v.slug)}`);
} finally { await app.close(); }
