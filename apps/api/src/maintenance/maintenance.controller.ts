import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { MaintenanceService } from './maintenance.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

/** Who may do what is decided inside (a technician works only their own jobs; managers create, assign, check and cancel). */
@Controller('v1/properties/:propertyId')
export class MaintenanceController {
  constructor(@Inject(MaintenanceService) private readonly svc: MaintenanceService) {}
  @Get('work-orders') @RequirePermission('maintenance.view', P)
  list(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.list(pid, me(), parse(S.ListQuery, q)); }
  @Get('work-orders/technicians') @RequirePermission('maintenance.view', P)
  technicians(@Param('propertyId', uuid()) pid: string) { return this.svc.technicians(pid); }
  @Get('work-orders/summary') @RequirePermission('maintenance.view', P)
  summary(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.summary(pid, parse(S.SummaryQuery, q)); }
  @Post('work-orders') @RequirePermission('maintenance.request', P)
  create(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.create(pid, me(), parse(S.CreateOrder, body)); }
  @Get('work-orders/:id') @RequirePermission('maintenance.view', P)
  get(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.get(pid, id); }
  @Post('work-orders/:id/assign') @RequirePermission('maintenance.manage', P) @HttpCode(200)
  assign(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.assign(pid, id, me(), parse(S.Assign, body)); }
  @Post('work-orders/:id/approve') @RequirePermission('maintenance.approve', P) @HttpCode(200)
  approve(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.approve(pid, id, me(), parse(S.Approve, body ?? {})); }
  @Post('work-orders/:id/reject') @RequirePermission('maintenance.approve', P) @HttpCode(200)
  reject(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.reject(pid, id, me(), parse(S.Reject, body)); }
  @Post('work-orders/:id/start') @RequirePermission('maintenance.work', P) @HttpCode(200)
  start(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.start(pid, id, me()); }
  @Post('work-orders/:id/wait') @RequirePermission('maintenance.work', P) @HttpCode(200)
  wait(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.wait(pid, id, me(), parse(S.Wait, body)); }
  @Post('work-orders/:id/done') @RequirePermission('maintenance.work', P) @HttpCode(200)
  done(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.done(pid, id, me(), parse(S.Done, body)); }
  @Post('work-orders/:id/verify') @RequirePermission('maintenance.manage', P) @HttpCode(200)
  verify(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.verify(pid, id, me(), parse(S.Verify, body)); }
  @Post('work-orders/:id/reopen') @RequirePermission('maintenance.manage', P) @HttpCode(200)
  reopen(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.reopen(pid, id, me(), parse(S.Reopen, body)); }
  @Post('work-orders/:id/cancel') @RequirePermission('maintenance.request', P) @HttpCode(200)
  cancel(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.cancel(pid, id, me(), parse(S.Cancel, body)); }
  @Post('work-orders/:id/notes') @RequirePermission('maintenance.view', P) @HttpCode(200)
  note(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.addNote(pid, id, me(), parse(S.AddNote, body)); }
}

/** Third-party contractors are a business-wide list: one contract may serve several properties. */
@Controller('v1/maintenance/vendors')
export class MaintenanceVendorsController {
  constructor(@Inject(MaintenanceService) private readonly svc: MaintenanceService) {}
  @Get() @RequirePermission('maintenance.view', { anyScope: true })
  list(@Query('all') all?: string) { return this.svc.vendors(all === 'true'); }
  @Post() @RequirePermission('maintenance.vendor', { anyScope: true })
  create(@Body() body: unknown) { return this.svc.createVendor(parse(S.CreateVendor, body)); }
  @Patch(':id') @RequirePermission('maintenance.vendor', { anyScope: true })
  update(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.updateVendor(id, parse(S.UpdateVendor, body)); }
}
