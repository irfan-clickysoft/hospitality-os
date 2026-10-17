import type { Kysely, Transaction } from 'kysely';
import { withTenant, type DB } from '@hos/db';
import { currentTenant } from '../tenancy/tenant-context.js';

/** The only sanctioned way for services to touch tenant data: a transaction pinned to the request's tenant (RLS applies). */
export class TenantDb {
  constructor(private readonly db: Kysely<DB>) {}
  tx<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return withTenant(this.db, currentTenant().tenantId, fn);
  }
}
