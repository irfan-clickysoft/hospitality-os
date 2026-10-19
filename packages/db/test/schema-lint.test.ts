import { describe, expect, it } from 'vitest';
import { adminPool, appPool } from './helpers.js';

/** Tables intentionally without tenant_id. Adding a table here needs a security review. */
const GLOBAL_ALLOWLIST = new Set(['permission', 'schema_migrations']);
/** Platform table: no tenant_id column but must still have RLS. */
const SELF_SCOPED = new Set(['tenant']);

describe('tenant-isolation schema lint', () => {
  it('every table with tenant_id has RLS enabled, forced, and a policy', async () => {
    const { rows } = await adminPool.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname}: RLS not enabled`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname}: RLS not forced`).toBe(true);
      expect(Number(r.policies), `${r.relname}: no policy`).toBeGreaterThan(0);
    }
  });

  it('every table without tenant_id is explicitly allow-listed, and self-scoped ones have RLS', async () => {
    const { rows } = await adminPool.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
    for (const r of rows) {
      const ok = GLOBAL_ALLOWLIST.has(r.relname) || SELF_SCOPED.has(r.relname);
      expect(ok, `table "${r.relname}" has no tenant_id and is not allow-listed`).toBe(true);
      if (SELF_SCOPED.has(r.relname)) {
        expect(r.relrowsecurity && r.relforcerowsecurity, `${r.relname} must have forced RLS`).toBe(true);
      }
    }
  });

  it('foreign keys between tenant tables include tenant_id (no cross-tenant references)', async () => {
    const { rows } = await adminPool.query(`
      SELECT con.conname, rel.relname AS child, ref.relname AS parent,
             (SELECT array_agg(a.attname) FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)) AS cols
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_class ref ON ref.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = rel.oid AND a.attname = 'tenant_id')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = ref.oid AND a.attname = 'tenant_id')`);
    for (const r of rows) {
      expect(r.cols, `FK ${r.conname} (${r.child} -> ${r.parent}) must include tenant_id`).toContain('tenant_id');
    }
  });

  it('the runtime role cannot bypass RLS and owns nothing', async () => {
    const { rows } = await appPool.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await adminPool.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE r.rolname = 'hos_app' AND c.relnamespace = 'public'::regnamespace`);
    expect(owned.rows[0].n).toBe(0);
  });
});
