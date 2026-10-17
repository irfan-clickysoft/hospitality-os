import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../authz/decorators.js';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@hos/db';
import { DB_APP } from '../db/db.module.js';

@Public()
@Controller()
export class HealthController {
  constructor(@Inject(DB_APP) private readonly db: Kysely<DB>) {}

  /** Liveness: process is up. */
  @Get('healthz')
  healthz() { return { status: 'ok' }; }

  /** Readiness: dependencies reachable. */
  @Get('readyz')
  async readyz() {
    await sql`SELECT 1`.execute(this.db);
    return { status: 'ready', db: 'ok' };
  }
}
