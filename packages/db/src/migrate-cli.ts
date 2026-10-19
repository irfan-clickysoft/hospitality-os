import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL_OWNER;
if (!url) throw new Error('DATABASE_URL_OWNER is required');
const applied = await migrate(url);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
