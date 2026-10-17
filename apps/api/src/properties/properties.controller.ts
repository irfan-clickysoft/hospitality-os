import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { TenantDb } from '../db/tenant-db.js';

@Controller('v1/properties')
export class PropertiesController {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb) {}

  @Get(':propertyId')
  @RequirePermission('property.view', { scope: (req) => ({ propertyId: req.params.propertyId }) })
  async get(@Param('propertyId', new ParseUUIDPipe()) propertyId: string) {
    const p = await this.tdb.tx((trx) => trx.selectFrom('property')
      .select(['id', 'code', 'name', 'timezone', 'currency', 'business_date', 'status']).where('id', '=', propertyId).executeTakeFirst());
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return p;
  }
}
