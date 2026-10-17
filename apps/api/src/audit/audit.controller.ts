import { Controller, Get, Inject, Query } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { TenantDb } from '../db/tenant-db.js';

@Controller('v1/audit-log')
export class AuditController {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb) {}

  /** Tenant audit trail, newest first. Sensitive: requires audit.view and a fresh second-factor verification. */
  @Get()
  @RequirePermission('audit.view')
  async list(@Query('limit') limit?: string) {
    const n = Math.min(Math.max(Number.parseInt(limit ?? '50', 10) || 50, 1), 200);
    const rows = await this.tdb.tx((trx) => trx.selectFrom('audit_log')
      .select(['id', 'occurred_at', 'actor_type', 'actor_id', 'action', 'resource_type', 'resource_id', 'property_id', 'reason_code', 'request_id'])
      .orderBy('occurred_at', 'desc').orderBy('id').limit(n).execute());
    return { items: rows };
  }
}
