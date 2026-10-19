import { Global, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { createDb, type DB } from '@hos/db';
import { loadConfig } from '../config.js';
import { TenantDb } from './tenant-db.js';

export const DB_APP = Symbol('DB_APP');
/** BYPASSRLS connection. Only platform jobs (provisioning, outbox relay) may inject this. Never expose through request handlers. */
export const DB_ADMIN = Symbol('DB_ADMIN');

@Global()
@Module({
  providers: [
    { provide: DB_APP, useFactory: (): Kysely<DB> => createDb(loadConfig().databaseUrlApp) },
    {
      provide: DB_ADMIN,
      useFactory: (): Kysely<DB> | null => {
        const url = loadConfig().databaseUrlAdmin;
        return url ? createDb(url, 4) : null;
      },
    },
    { provide: TenantDb, useFactory: (db: Kysely<DB>) => new TenantDb(db), inject: [DB_APP] },
  ],
  exports: [DB_APP, DB_ADMIN, TenantDb],
})
export class DbModule {}
