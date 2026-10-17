import { Global, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { createDb, type DB } from '@hos/db';
import { loadConfig } from '../config.js';
import { TenantDb } from './tenant-db.js';

export const DB_APP = Symbol('DB_APP');

@Global()
@Module({
  providers: [
    { provide: DB_APP, useFactory: (): Kysely<DB> => createDb(loadConfig().databaseUrlApp) },
    { provide: TenantDb, useFactory: (db: Kysely<DB>) => new TenantDb(db), inject: [DB_APP] },
  ],
  exports: [DB_APP, TenantDb],
})
export class DbModule {}
