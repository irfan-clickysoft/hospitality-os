import { resetDatabaseForTests } from '@hos/db';
import { URLS } from './env.js';

export default async function setup() { await resetDatabaseForTests(URLS.owner); }
