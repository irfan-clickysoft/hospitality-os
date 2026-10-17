import pg from 'pg';
import { URLS } from './env.js';

export const appPool = new pg.Pool({ connectionString: URLS.app, max: 4 });
export const adminPool = new pg.Pool({ connectionString: URLS.admin, max: 4 });
export const ownerPool = new pg.Pool({ connectionString: URLS.owner, max: 2 });

/** Run SQL as the runtime role inside a transaction scoped to `tenantId` (or no tenant when null). Always rolls back. */
export async function asTenant<T>(tenantId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    if (tenantId) await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

export interface Seeded { tenantId: string; legalEntityId: string; propertyId: string; userId: string }

/** Seeds one tenant with a legal entity, property, user and an audit row, via the provisioning role. */
export async function seedTenant(slug: string): Promise<Seeded> {
  const t = (await adminPool.query(`INSERT INTO tenant (name, slug) VALUES ($1,$2) RETURNING id`, [slug, slug])).rows[0].id as string;
  const le = (await adminPool.query(`INSERT INTO legal_entity (tenant_id, name) VALUES ($1,$2) RETURNING id`, [t, `${slug} LLC`])).rows[0].id as string;
  const p = (await adminPool.query(
    `INSERT INTO property (tenant_id, legal_entity_id, code, name, business_date) VALUES ($1,$2,'MAIN',$3,'2026-10-20') RETURNING id`, [t, le, `${slug} Main`])).rows[0].id as string;
  const u = (await adminPool.query(`INSERT INTO staff_user (tenant_id, email, full_name) VALUES ($1,$2,'Test User') RETURNING id`, [t, `u@${slug}.test`])).rows[0].id as string;
  await adminPool.query(`INSERT INTO audit_log (tenant_id, actor_type, action, resource_type) VALUES ($1,'SYSTEM','seed','tenant')`, [t]);
  return { tenantId: t, legalEntityId: le, propertyId: p, userId: u };
}
