import { Controller, Get, Inject } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { ReadinessService } from './readiness.service.js';

@Controller('v1/readiness')
export class ReadinessController {
  constructor(@Inject(ReadinessService) private readonly svc: ReadinessService) {}
  /** What is set up and what is still missing, for the properties you may see in the management view (the business-wide items need the whole business). */
  @Get() @RequirePermission('management.view', { anyScope: true })
  report() { return this.svc.report(currentTenant().actorId!); }
}
