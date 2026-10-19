import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { URLS } from './env.js';

/** Recreates the schema from scratch so tests always run against the real migrations. */
export default async function setup() {
  const c = new pg.Client({ connectionString: URLS.owner });
  await c.connect();
  await c.query('DROP OWNED BY hos_owner CASCADE');
  await c.end();
  await migrate(URLS.owner);
}
