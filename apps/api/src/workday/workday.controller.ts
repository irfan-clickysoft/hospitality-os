import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { Authenticated, RequirePermission } from '../authz/decorators.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { WorkdayService } from './workday.service.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();

@Controller('v1/properties/:propertyId')
export class WorkdayController {
  constructor(@Inject(WorkdayService) private readonly svc: WorkdayService) {}
  /** The front desk's queue: arrivals and departures with the problems that will stop or slow each one, worked out on the server. */
  @Get('today') @RequirePermission('reservation.view', P)
  today(@Param('propertyId', uuid()) pid: string) { return this.svc.today(pid); }
  /** What is waiting on this person at this property; each item appears only if they hold the permission to act on it. */
  @Get('inbox') @Authenticated()
  inbox(@Param('propertyId', uuid()) pid: string) { return this.svc.inbox(pid, currentTenant().actorId!); }
}
