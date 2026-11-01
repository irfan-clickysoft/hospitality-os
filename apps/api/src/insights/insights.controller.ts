import { Body, Controller, Delete, Get, HttpCode, Inject, Patch, Post, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Authenticated } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { businessDate } from '../property-setup/schemas.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { InsightsService } from './insights.service.js';
import { ScheduledReportsService } from './scheduled.service.js';
import { ScheduleInput, ScheduleUpdate } from './schedule-schemas.js';

const Q = z.object({ basis: z.string().max(30).optional(), from: businessDate.optional(), to: businessDate.optional(), view: z.string().max(30).optional(), group: z.string().max(30).optional(), compare: z.string().max(30).optional(), format: z.enum(['json', 'csv']).default('json') });
const split = (x: z.infer<typeof Q>) => ({ basis: x.basis, from: x.from, to: x.to, params: { ...(x.view ? { view: x.view } : {}), ...(x.group ? { group: x.group } : {}), ...(x.compare ? { compare: x.compare } : {}) } });

/** The Reporting Center. Each report checks its own permissions (any one of its list) at the property, so a cashier and a housekeeper see different catalogs. */
@Controller('v1/properties/:propertyId/insights')
export class InsightsController {
  constructor(@Inject(InsightsService) private readonly svc: InsightsService, @Inject(ScheduledReportsService) private readonly sched: ScheduledReportsService) {}
  @Authenticated() @Get()
  catalog(@Param('propertyId', new ParseUUIDPipe()) pid: string) { return this.svc.catalog(currentTenant().actorId!, pid); }
  @Authenticated() @Get('snapshots')
  snapshots(@Param('propertyId', new ParseUUIDPipe()) pid: string) { return this.svc.snapshotStatus(currentTenant().actorId!, pid); }
  @Authenticated() @Post('snapshots') @HttpCode(200)
  take(@Param('propertyId', new ParseUUIDPipe()) pid: string) { return this.svc.takeSnapshot(currentTenant().actorId!, pid); }
  @Authenticated() @Get('schedules')
  schedules(@Param('propertyId', new ParseUUIDPipe()) pid: string) { return this.sched.list(currentTenant().actorId!, pid); }
  @Authenticated() @Post('schedules')
  createSchedule(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Body() b: unknown) { return this.sched.create(currentTenant().actorId!, pid, parse(ScheduleInput, b)); }
  @Authenticated() @Get('schedule-people')
  people(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Query('report') report?: string) { return this.sched.people(currentTenant().actorId!, pid, report); }
  @Authenticated() @Patch('schedules/:sid')
  updateSchedule(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Param('sid', new ParseUUIDPipe()) sid: string, @Body() b: unknown) { return this.sched.update(currentTenant().actorId!, pid, sid, parse(ScheduleUpdate, b)); }
  @Authenticated() @Delete('schedules/:sid') @HttpCode(200)
  deleteSchedule(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Param('sid', new ParseUUIDPipe()) sid: string) { return this.sched.remove(currentTenant().actorId!, pid, sid); }
  @Authenticated() @Post('schedules/:sid/run') @HttpCode(200)
  runSchedule(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Param('sid', new ParseUUIDPipe()) sid: string) { return this.sched.runNow(currentTenant().actorId!, pid, sid); }
  @Authenticated() @Get('deliveries')
  deliveries(@Param('propertyId', new ParseUUIDPipe()) pid: string) { return this.sched.mine(currentTenant().actorId!, pid); }
  @Authenticated() @Get('deliveries/:did')
  delivery(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Param('did', new ParseUUIDPipe()) did: string, @Res({ passthrough: true }) reply: FastifyReply) { reply.header('cache-control', 'no-store'); return this.sched.open(currentTenant().actorId!, pid, did); }
  @Authenticated() @Get('deliveries/:did/csv')
  async deliveryCsv(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Param('did', new ParseUUIDPipe()) did: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.sched.csv(currentTenant().actorId!, pid, did);
    reply.header('cache-control', 'no-store').header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${r.filename}"`).header('x-content-type-options', 'nosniff'); return '\uFEFF' + r.csv;
  }
  @Authenticated() @Get(':id')
  async run(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Param('id') id: string, @Query() q: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const x = parse(Q, q); const me = currentTenant().actorId!;
    reply.header('cache-control', 'no-store');
    if (x.format === 'csv') { const r = await this.svc.csv(me, pid, id, split(x)); reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${r.filename}"`).header('x-content-type-options', 'nosniff'); return '﻿' + r.csv; }
    return this.svc.run(me, pid, id, split(x));
  }
}
