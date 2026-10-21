import 'reflect-metadata';
import { createDb } from '@hos/db';
import { ACCOUNTS } from './sunset-data.js';

/** Development convenience: records the owner's bank accounts (see sunset-data.ts). Safe to re-run. In real use these are entered on the Accounts screen. */
const SLUG = process.env.SEED_TENANT_SLUG ?? 'sunset';
const admin = createDb(process.env.DATABASE_URL_ADMIN!, 2);
try {
  const tenant = await admin.selectFrom('tenant').select('id').where('slug', '=', SLUG).executeTakeFirstOrThrow();
  const owner = await admin.selectFrom('staff_user').select('id').where('tenant_id', '=', tenant.id).orderBy('created_at').executeTakeFirstOrThrow();
  for (const a of ACCOUNTS) {
    const prop = a.propertyCode ? await admin.selectFrom('property').select('id').where('tenant_id', '=', tenant.id).where('code', '=', a.propertyCode).executeTakeFirstOrThrow() : null;
    const has = await admin.selectFrom('payment_account').select('id').where('tenant_id', '=', tenant.id).where('name', '=', a.name).executeTakeFirst();
    if (has) { console.log(`• ${a.name}: already recorded, skipped`); continue; }
    await admin.insertInto('payment_account').values({ tenant_id: tenant.id, property_id: prop?.id ?? null, kind: 'BANK', name: a.name, bank_name: a.bankName, account_title: a.accountTitle, owner_type: a.ownerType, owner_name: a.ownerName, currency: 'PKR', note: a.note, created_by: owner.id } as never).execute();
    console.log(`✔ ${a.name} (${a.ownerType === 'COMPANY' ? 'company' : `PERSONAL — ${a.ownerName}`})`);
  }
} finally { await admin.destroy(); }
