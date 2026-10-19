import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { businessDate } from '../property-setup/schemas.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { ManagementService } from './management.service.js';

const Q = z.object({ from: businessDate.optional(), to: businessDate.optional() }).refine((v) => !v.from || !v.to || v.to >= v.from, { message: 'to cannot be before from' });

@Controller('v1/management')
export class ManagementController {
  constructor(@Inject(ManagementService) private readonly svc: ManagementService) {}
  /** The properties you may see are decided inside: a user with the permission at one property sees only that one. */
  @Get('overview') @RequirePermission('management.view', { anyScope: true })
  overview(@Query() q: unknown) { const x = parse(Q, q); return this.svc.overview(currentTenant().actorId!, x.from, x.to); }
}
