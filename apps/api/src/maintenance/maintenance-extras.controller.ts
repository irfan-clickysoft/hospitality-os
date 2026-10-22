import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { MaintenanceExtrasService } from './maintenance-extras.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;
const file = async (req: FastifyRequest) => {
  if (!req.isMultipart()) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Send the file as an upload' });
  const part = await req.file(); if (!part) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'No file was sent' });
  return part.toBuffer();
};

/** Pictures and videos on a job, the bills that come from it, and the recurring jobs that create jobs. Who may do what is decided inside. */
@Controller('v1/properties/:propertyId')
export class MaintenanceExtrasController {
  constructor(@Inject(MaintenanceExtrasService) private readonly svc: MaintenanceExtrasService) {}

  @Post('work-orders/:id/media') @RequirePermission('maintenance.view', P)
  addMedia(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Req() req: FastifyRequest) { return file(req).then((b) => this.svc.addMedia(p, id, me(), b)); }
  @Delete('work-orders/:id/media/:mediaId') @RequirePermission('maintenance.view', P) @HttpCode(204)
  async removeMedia(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Param('mediaId', uuid()) m: string) { await this.svc.removeMedia(p, id, m, me()); }

  @Post('work-orders/:id/bills') @RequirePermission('maintenance.view', P)
  addBill(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.addBill(p, id, me(), parse(S.BillCreate, b)); }
  @Post('work-orders/:id/bills/:billId/file') @RequirePermission('maintenance.view', P)
  attach(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Param('billId', uuid()) b: string, @Req() req: FastifyRequest) { return file(req).then((d) => this.svc.attachBill(p, id, b, me(), d)); }
  @Get('work-orders/:id/bills/:billId/file') @RequirePermission('maintenance.view', P)
  async billFile(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Param('billId', uuid()) b: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const f = await this.svc.billFile(p, id, b, me());
    reply.header('Content-Type', f.type).header('Content-Disposition', `inline; filename="bill-${f.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(f.stream());
  }
  @Post('work-orders/:id/bills/:billId/approve') @RequirePermission('maintenance.approve', P) @HttpCode(200)
  approve(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Param('billId', uuid()) b: string, @Body() body: unknown) { return this.svc.approveBill(p, id, b, me(), parse(S.BillApprove, body ?? {}).note ?? null); }
  @Post('work-orders/:id/bills/:billId/reject') @RequirePermission('maintenance.approve', P) @HttpCode(200)
  reject(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Param('billId', uuid()) b: string, @Body() body: unknown) { return this.svc.rejectBill(p, id, b, me(), parse(S.BillReject, body).reason); }
  @Post('work-orders/:id/bills/:billId/pay') @RequirePermission('maintenance.pay', P) @HttpCode(200)
  pay(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Param('billId', uuid()) b: string, @Body() body: unknown) { return this.svc.payBill(p, id, b, me(), parse(S.BillPay, body)); }
  @Get('maintenance-bills') @RequirePermission('maintenance.view', P)
  bills(@Param('propertyId', uuid()) p: string, @Query() q: unknown) { return this.svc.bills(p, me(), parse(S.BillQuery, q)); }

  @Get('maintenance-schedules') @RequirePermission('maintenance.view', P)
  schedules(@Param('propertyId', uuid()) p: string) { return this.svc.schedules(p); }
  @Post('maintenance-schedules') @RequirePermission('maintenance.approve', P)
  createSchedule(@Param('propertyId', uuid()) p: string, @Body() b: unknown) { return this.svc.createSchedules(p, me(), parse(S.ScheduleCreate, b)); }
  @Patch('maintenance-schedules/:scheduleId') @RequirePermission('maintenance.approve', P)
  updateSchedule(@Param('propertyId', uuid()) p: string, @Param('scheduleId', uuid()) id: string, @Body() b: unknown) { return this.svc.updateSchedule(p, id, me(), parse(S.ScheduleUpdate, b)); }
  @Post('maintenance-schedules/run') @RequirePermission('maintenance.approve', P) @HttpCode(200)
  run(@Param('propertyId', uuid()) p: string) { return this.svc.runDue(p, me()); }
}
