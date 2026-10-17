import { beforeAll, describe, expect, it } from 'vitest';
import { adminPool, asTenant, seedTenant, type Seeded } from './helpers.js';

let A: Seeded, B: Seeded;
beforeAll(async () => { A = await seedTenant('alpha'); B = await seedTenant('bravo'); });

const TENANT_TABLES = ['legal_entity', 'property', 'staff_user', 'audit_log'];

describe('row-level security', () => {
  it('without a tenant context, every tenant table returns zero rows', async () => {
    for (const t of TENANT_TABLES) {
      const r = await asTenant(null, (c) => c.query(`SELECT count(*)::int AS n FROM ${t}`));
      expect(r.rows[0].n, t).toBe(0);
    }
    const t = await asTenant(null, (c) => c.query(`SELECT count(*)::int AS n FROM tenant`));
    expect(t.rows[0].n).toBe(0);
  });

  it('a tenant session sees only its own rows', async () => {
    for (const t of TENANT_TABLES) {
      const r = await asTenant(A.tenantId, (c) => c.query(`SELECT DISTINCT tenant_id FROM ${t}`));
      expect(r.rows.map((x) => x.tenant_id), t).toEqual([A.tenantId]);
    }
    const t = await asTenant(A.tenantId, (c) => c.query(`SELECT id FROM tenant`));
    expect(t.rows.map((x) => x.id)).toEqual([A.tenantId]);
  });

  it("direct lookup of another tenant's row by primary key finds nothing", async () => {
    const r = await asTenant(A.tenantId, (c) => c.query(`SELECT * FROM property WHERE id = $1`, [B.propertyId]));
    expect(r.rowCount).toBe(0);
  });

  it('cannot insert a row for another tenant (WITH CHECK)', async () => {
    await expect(asTenant(A.tenantId, (c) =>
      c.query(`INSERT INTO legal_entity (tenant_id, name) VALUES ($1,'evil')`, [B.tenantId]))).rejects.toThrow(/row-level security/);
  });

  it("cannot update or delete another tenant's rows", async () => {
    const u = await asTenant(A.tenantId, (c) => c.query(`UPDATE property SET name='hacked' WHERE id=$1`, [B.propertyId]));
    expect(u.rowCount).toBe(0);
    const d = await asTenant(A.tenantId, (c) => c.query(`DELETE FROM staff_user WHERE id=$1`, [B.userId]));
    expect(d.rowCount).toBe(0);
    const still = await adminPool.query(`SELECT name FROM property WHERE id=$1`, [B.propertyId]);
    expect(still.rows[0].name).toBe('bravo Main');
  });

  it("cannot re-point a row to another tenant by updating tenant_id", async () => {
    await expect(asTenant(A.tenantId, (c) =>
      c.query(`UPDATE staff_user SET tenant_id=$1 WHERE id=$2`, [B.tenantId, A.userId]))).rejects.toThrow(/row-level security/);
  });

  it('composite foreign keys reject cross-tenant references even for the provisioning role', async () => {
    await expect(adminPool.query(
      `INSERT INTO property (tenant_id, legal_entity_id, code, name, business_date) VALUES ($1,$2,'X','x','2026-10-20')`,
      [A.tenantId, B.legalEntityId])).rejects.toThrow(/foreign key/i);
  });

  it('a malicious tenant id string cannot widen the context', async () => {
    await expect(asTenant(A.tenantId, async (c) => {
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [`${A.tenantId}' OR '1'='1`]);
      return c.query('SELECT 1 FROM property');
    })).rejects.toThrow(); // invalid uuid input
  });

  it('context does not leak between transactions on a pooled connection', async () => {
    await asTenant(A.tenantId, (c) => c.query('SELECT 1'));
    const r = await asTenant(null, (c) => c.query(`SELECT count(*)::int AS n FROM property`));
    expect(r.rows[0].n).toBe(0);
  });

  it('runtime role cannot write platform tables', async () => {
    await expect(asTenant(A.tenantId, (c) => c.query(`INSERT INTO tenant (name, slug) VALUES ('x','x')`))).rejects.toThrow(/permission denied/);
    await expect(asTenant(A.tenantId, (c) => c.query(`INSERT INTO permission (key, description) VALUES ('a.b','x')`))).rejects.toThrow(/permission denied/);
  });
});

describe('append-only audit log', () => {
  it('rejects update and delete for the runtime role', async () => {
    await expect(asTenant(A.tenantId, (c) => c.query(`UPDATE audit_log SET action='x'`))).rejects.toThrow(/permission denied/);
    await expect(asTenant(A.tenantId, (c) => c.query(`DELETE FROM audit_log`))).rejects.toThrow(/permission denied/);
  });
  it('rejects update, delete and truncate even for the provisioning role (trigger)', async () => {
    await expect(adminPool.query(`UPDATE audit_log SET action='x' WHERE tenant_id=$1`, [A.tenantId])).rejects.toThrow(/append-only/);
    await expect(adminPool.query(`DELETE FROM audit_log WHERE tenant_id=$1`, [A.tenantId])).rejects.toThrow(/append-only/);
    await expect(adminPool.query(`TRUNCATE audit_log`)).rejects.toThrow(/append-only/);
  });
  it('allows runtime role to append for its own tenant', async () => {
    const r = await asTenant(A.tenantId, (c) => c.query(
      `INSERT INTO audit_log (tenant_id, actor_type, action, resource_type) VALUES ($1,'USER','test','x')`, [A.tenantId]));
    expect(r.rowCount).toBe(1);
  });
});
