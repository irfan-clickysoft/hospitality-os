import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', 'migrations');

/** Applies pending SQL migrations in filename order, each in its own transaction. Verifies checksums of applied ones. */
export async function migrate(ownerUrl: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('SELECT pg_advisory_lock(727274)');
    const done = new Map<string, string>(
      (await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map((r) => [r.filename, r.checksum]),
    );
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1,$2)', [file, checksum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    await client.end();
  }
  return applied;
}

/** TEST ONLY: drops everything owned by the migration role and re-applies all migrations. Refuses to touch non-test databases. */
export async function resetDatabaseForTests(ownerUrl: string): Promise<void> {
  const dbName = new URL(ownerUrl).pathname.replace(/^\//, '');
  if (!/_test$/.test(dbName)) throw new Error(`Refusing to reset "${dbName}": database name must end with _test`);
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try { await c.query('DROP OWNED BY hos_owner CASCADE'); } finally { await c.end(); }
  await migrate(ownerUrl);
}
