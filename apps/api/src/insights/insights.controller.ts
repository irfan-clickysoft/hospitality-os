import { Controller, Get, HttpCode, Inject, Post, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Authenticated } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { businessDate } from '../property-setup/schemas.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { InsightsService } from './insights.service.js';

const Q = z.object({ basis: z.string().max(30).optional(), from: businessDate.optional(), to: businessDate.optional(), view: z.string().max(30).optional(), group: z.string().max(30).optional(), compare: z.string().max(30).optional(), format: z.enum(['json', 'csv']).default('json') });
const split = (x: z.infer<typeof Q>) => ({ basis: x.basis, from: x.from, to: x.to, params: { ...(x.view ? { view: x.view } : {}), ...(x.group ? { group: x.group } : {}), ...(x.compare ? { compare: x.compare } : {}) } });

/** The Reporting Center. Each report checks its own permissions (any one of its list) at the property, so a cashier and a housekeeper see different catalogs. */
@Controller('v1/properties/:propertyId/insights')
export class InsightsController {
  constructor(@Inject(InsightsService) private readonly svc: InsightsService) {}
  @Authenticated() @Get()
  catalog(@Param('propertyId', new ParseUUIDPipe()) pid: string) { return this.svc.catalog(currentTenant().actorId!, pid); }
  @Authenticated() @Get('snapshots')
  snapshots(@Param('propertyId', new ParseUUIDPipe()) pid: string) { return this.svc.snapshotStatus(currentTenant().actorId!, pid); }
  @Authenticated() @Post('snapshots') @HttpCode(200)
  take(@Param('propertyId', new ParseUUIDPipe()) pid: string) { return this.svc.takeSnapshot(currentTenant().actorId!, pid); }
  @Authenticated() @Get(':id')
  async run(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Param('id') id: string, @Query() q: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const x = parse(Q, q); const me = currentTenant().actorId!;
    reply.header('cache-control', 'no-store');
    if (x.format === 'csv') { const r = await this.svc.csv(me, pid, id, split(x)); reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${r.filename}"`).header('x-content-type-options', 'nosniff'); return '﻿' + r.csv; }
    return this.svc.run(me, pid, id, split(x));
  }
}
