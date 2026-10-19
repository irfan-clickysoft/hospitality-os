import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDb } from '@hos/db';

/**
 * A hosted TEST copy: fills an empty database with the Sunset demo business (rooms, rate card, bank accounts, tax drafts, demo users) so a partner such as PayFast can try the system.
 * Only runs when HOS_TEST_COPY=1, needs DEMO_PASSWORD (12+ characters, chosen by the host), and does nothing if the business already exists, so restarting never resets it.
 * NEVER for real guest data: the demo users share one password.
 */
if (process.env.HOS_TEST_COPY !== '1') { console.log('[hos] test copy seeding is off (HOS_TEST_COPY is not 1)'); process.exit(0); }
if ((process.env.DEMO_PASSWORD ?? '').length < 12) { console.error('[hos] HOS_TEST_COPY=1 needs DEMO_PASSWORD (at least 12 characters)'); process.exit(1); }
const slug = process.env.SEED_TENANT_SLUG ?? 'sunset';
const admin = createDb(process.env.DATABASE_URL_ADMIN!, 1);
const exists = await admin.selectFrom('tenant').select('id').where('slug', '=', slug).executeTakeFirst();
await admin.destroy();
if (exists) { console.log(`[hos] test copy: "${slug}" already exists, leaving it alone`); process.exit(0); }
for (const script of ['seed-sunset', 'seed-sunset-rates', 'seed-demo-staff', 'seed-sunset-accounts', 'seed-sunset-tax']) {
  console.log(`[hos] test copy: ${script}`);
  // seed-sunset prints a one-time owner invite token; it is not needed here (the demo password is used) and must not end up in logs
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(`./${script}.js`, import.meta.url))], { stdio: script === 'seed-sunset' ? 'ignore' : 'inherit', env: process.env });
  if (r.status !== 0) { console.error(`[hos] test copy: ${script} failed`); process.exit(1); }
}
console.log('[hos] test copy ready. Sign in with company code "sunset" and the demo users (see docs/hosting.md). The tax rates are DRAFTS until approved.');
