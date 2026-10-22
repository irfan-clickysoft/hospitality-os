import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import * as S from './schemas.js';
import { StaffService } from './staff.service.js';

const ANY = { anyScope: true } as const;
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

@Controller('v1')
export class StaffController {
  constructor(@Inject(StaffService) private readonly svc: StaffService) {}
  @Get('roles') @RequirePermission('user.manage', ANY)
  roles() { return this.svc.roles(); }
  @Get('users') @RequirePermission('user.manage', ANY)
  list() { return this.svc.list(); }
  @Post('users') @RequirePermission('user.manage', ANY)
  create(@Body() body: unknown) { return this.svc.create(me(), parse(S.CreateUser, body)); }
  @Post('users/:id/invite') @RequirePermission('user.manage', ANY) @HttpCode(200)
  reinvite(@Param('id', uuid()) id: string) { return this.svc.reinvite(me(), id); }
  @Post('users/:id/disable') @RequirePermission('user.manage', ANY) @HttpCode(200)
  disable(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.setDisabled(me(), id, true, parse(S.Reason, body).reason); }
  @Post('users/:id/enable') @RequirePermission('user.manage', ANY) @HttpCode(200)
  enable(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.setDisabled(me(), id, false, parse(S.Reason, body).reason); }
  @Post('users/:id/reset-mfa') @RequirePermission('user.manage', ANY) @HttpCode(200)
  resetMfa(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.resetMfa(me(), id, parse(S.Reason, body).reason); }
  @Post('users/:id/roles') @RequirePermission('role.manage', ANY)
  assign(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.assign(me(), id, parse(S.AssignRole, body)); }
  @Post('users/:id/roles/bulk') @RequirePermission('role.manage', ANY)
  assignMany(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.assignMany(me(), id, parse(S.AssignRoles, body)); }
  @Post('users/:id/roles/remove') @RequirePermission('role.manage', ANY) @HttpCode(200)
  revokeMany(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.revokeMany(me(), id, parse(S.RevokeRoles, body)); }
  @Delete('users/:id/roles/:assignmentId') @RequirePermission('role.manage', ANY)
  revoke(@Param('id', uuid()) id: string, @Param('assignmentId', uuid()) a: string, @Query('reason') reason?: string) { return this.svc.revoke(me(), id, a, parse(S.Reason, { reason }).reason); }
  @Get('audit') @RequirePermission('audit.view', ANY)
  audit(@Query() q: unknown) { return this.svc.auditTrail(parse(S.AuditQuery, q)); }
}
