import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { ComplianceService } from './compliance.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const ANY = { anyScope: true } as const;
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

@Controller('v1')
export class ComplianceController {
  constructor(@Inject(ComplianceService) private readonly svc: ComplianceService) {}
  @Get('compliance/rules') @RequirePermission('compliance.view', ANY)
  list() { return this.svc.list(); }
  @Post('compliance/rules') @RequirePermission('compliance.manage', ANY)
  create(@Body() body: unknown) { return this.svc.create(me(), parse(S.CreateRule, body)); }
  @Patch('compliance/rules/:id') @RequirePermission('compliance.manage', ANY)
  update(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.update(me(), id, parse(S.UpdateRule, body)); }
  @Put('compliance/rules/:id/status') @RequirePermission('compliance.manage', ANY)
  status(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.setStatus(me(), id, parse(S.SetStatus, body)); }
  /** What would apply to this kind of guest and stay? Nothing is saved. */
  @Post('compliance/check') @RequirePermission('compliance.view', ANY) @HttpCode(200)
  check(@Body() body: unknown) { return this.svc.check(parse(S.Check, body)); }
  @Get('properties/:propertyId/reservations/:id/compliance') @RequirePermission('compliance.view', P)
  forReservation(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.forReservation(pid, id); }
  @Get('properties/:propertyId/compliance-tasks') @RequirePermission('compliance.view', P)
  tasks(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.tasks(pid, parse(S.TaskQuery, q).status); }
  @Post('properties/:propertyId/compliance-tasks/:taskId/complete') @RequirePermission('compliance.task', P) @HttpCode(200)
  complete(@Param('propertyId', uuid()) pid: string, @Param('taskId', uuid()) id: string, @Body() body: unknown) { return this.svc.completeTask(pid, id, me(), parse(S.CompleteTask, body).note); }
}
