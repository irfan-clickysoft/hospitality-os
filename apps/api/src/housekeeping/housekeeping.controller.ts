import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { HousekeepingService } from './housekeeping.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

@Controller('v1/properties/:propertyId/housekeeping')
export class HousekeepingController {
  constructor(@Inject(HousekeepingService) private readonly svc: HousekeepingService) {}

  // supervisor
  @Get('board') @RequirePermission('housekeeping.view', P)
  board(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.board(pid, parse(S.BoardQuery, q)); }
  @Get('attendants') @RequirePermission('housekeeping.assign', P)
  attendants(@Param('propertyId', uuid()) pid: string) { return this.svc.attendants(pid); }
  @Post('generate') @RequirePermission('housekeeping.assign', P) @HttpCode(200)
  generate(@Param('propertyId', uuid()) pid: string) { return this.svc.generate(pid, me()); }
  @Post('tasks') @RequirePermission('housekeeping.assign', P)
  create(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.createManual(pid, me(), parse(S.CreateTask, body)); }
  @Post('tasks/assign') @RequirePermission('housekeeping.assign', P) @HttpCode(200)
  assign(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.assign(pid, me(), parse(S.AssignTasks, body)); }
  @Post('tasks/:taskId/cancel') @RequirePermission('housekeeping.assign', P) @HttpCode(200)
  cancel(@Param('propertyId', uuid()) pid: string, @Param('taskId', uuid()) id: string, @Body() body: unknown) { return this.svc.cancel(pid, id, me(), parse(S.CancelTask, body).reason); }
  @Post('tasks/:taskId/inspect') @RequirePermission('housekeeping.assign', P) @HttpCode(200)
  inspect(@Param('propertyId', uuid()) pid: string, @Param('taskId', uuid()) id: string, @Body() body: unknown) { return this.svc.inspect(pid, id, me(), parse(S.InspectTask, body)); }
  @Post('rooms/:roomId/prioritise') @RequirePermission('frontdesk.check_in', P) @HttpCode(200)
  prioritise(@Param('propertyId', uuid()) pid: string, @Param('roomId', uuid()) roomId: string) { return this.svc.prioritise(pid, roomId, me()); }
  @Put('settings') @RequirePermission('property.manage', P)
  settings(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.setSettings(pid, parse(S.Settings, body)); }
  @Put('rooms/:roomId/status') @RequirePermission('housekeeping.assign', P)
  override(@Param('propertyId', uuid()) pid: string, @Param('roomId', uuid()) roomId: string, @Body() body: unknown) {
    return this.svc.overrideStatus(pid, roomId, me(), parse(S.OverrideStatus, body).status);
  }

  // attendant
  @Get('my-tasks') @RequirePermission('housekeeping.update', P)
  mine(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.myTasks(pid, me(), parse(S.MyTasksQuery, q).includeDone === 'true'); }
  @Post('tasks/:taskId/start') @RequirePermission('housekeeping.update', P) @HttpCode(200)
  start(@Param('propertyId', uuid()) pid: string, @Param('taskId', uuid()) id: string, @Body() body: unknown) { return this.svc.start(pid, id, me(), parse(S.StartTask, body ?? {})); }
  @Post('tasks/:taskId/finish') @RequirePermission('housekeeping.update', P) @HttpCode(200)
  finish(@Param('propertyId', uuid()) pid: string, @Param('taskId', uuid()) id: string, @Body() body: unknown) { return this.svc.finish(pid, id, me(), parse(S.FinishTask, body ?? {})); }
  @Post('tasks/:taskId/release') @RequirePermission('housekeeping.update', P) @HttpCode(200)
  release(@Param('propertyId', uuid()) pid: string, @Param('taskId', uuid()) id: string) { return this.svc.release(pid, id, me()); }
  @Post('tasks/:taskId/skip') @RequirePermission('housekeeping.update', P) @HttpCode(200)
  skip(@Param('propertyId', uuid()) pid: string, @Param('taskId', uuid()) id: string, @Body() body: unknown) { return this.svc.skip(pid, id, me(), parse(S.SkipTask, body)); }
  @Put('rooms/:roomId/dnd') @RequirePermission('housekeeping.update', P)
  dnd(@Param('propertyId', uuid()) pid: string, @Param('roomId', uuid()) roomId: string, @Body() body: unknown) { return this.svc.setDnd(pid, roomId, me(), parse(S.SetDnd, body).dnd); }

  // issues and lost & found
  @Post('issues') @RequirePermission('housekeeping.update', P)
  report(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.reportIssue(pid, me(), parse(S.ReportIssue, body)); }
  @Get('issues') @RequirePermission('housekeeping.view', P)
  issues(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.issues(pid, parse(S.IssuesQuery, q).status); }
  @Post('issues/:issueId/resolve') @RequirePermission('housekeeping.assign', P) @HttpCode(200)
  resolve(@Param('propertyId', uuid()) pid: string, @Param('issueId', uuid()) id: string, @Body() body: unknown) { return this.svc.resolveIssue(pid, id, me(), parse(S.ResolveIssue, body ?? {}).note); }
}
