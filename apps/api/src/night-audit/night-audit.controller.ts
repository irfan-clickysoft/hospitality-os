import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { businessDate } from '../property-setup/schemas.js';
import { NightAuditService } from './night-audit.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();

@Controller('v1/properties/:propertyId/night-audit')
export class NightAuditController {
  constructor(@Inject(NightAuditService) private readonly svc: NightAuditService) {}

  /** What stands between us and closing the day: blocking and warning exceptions, the last audit, any run in progress. */
  @Get('status') @RequirePermission('nightaudit.run', P)
  status(@Param('propertyId', uuid()) pid: string) { return this.svc.status(pid); }
  /** Starts the audit for the current business date, or resumes a failed one. Runs to the end before it answers. */
  @Post('runs') @RequirePermission('nightaudit.run', P) @HttpCode(200)
  start(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.start(pid, currentTenant().actorId!, parse(S.StartRun, body ?? {})); }
  @Get('runs') @RequirePermission('report.view', P)
  runs(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.runs(pid, parse(S.RunsQuery, q).limit); }
  @Get('runs/:runId') @RequirePermission('report.view', P)
  run(@Param('propertyId', uuid()) pid: string, @Param('runId', uuid()) id: string) { return this.svc.runView(pid, id); }
  @Get('reports') @RequirePermission('report.view', P)
  reports(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.reports(pid, parse(S.ReportsQuery, q)); }
  @Get('reports/:date') @RequirePermission('report.view', P)
  report(@Param('propertyId', uuid()) pid: string, @Param('date') date: string) { return this.svc.report(pid, parse(businessDate, date)); }
}
