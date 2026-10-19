import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { businessDate } from '../property-setup/schemas.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { ReportsService, type Report } from './reports.service.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const Q = z.object({ from: businessDate.optional(), to: businessDate.optional() });
const send = (reply: FastifyReply, r: Report) => reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${r.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`).header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').send(r.csv);

@Controller('v1')
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly svc: ReportsService) {}
  @Get('properties/:propertyId/reports/:name') @RequirePermission('report.view', P)
  async property(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Param('name') name: string, @Query() q: unknown, @Res() reply: FastifyReply) {
    const x = parse(Q, q); return send(reply, await this.svc.forProperty(currentTenant().actorId!, pid, name, x.from, x.to));
  }
  @Get('reports/:name') @RequirePermission('report.view', { anyScope: true })
  async tenant(@Param('name') name: string, @Query() q: unknown, @Res() reply: FastifyReply) {
    const x = parse(Q, q); return send(reply, await this.svc.forTenant(currentTenant().actorId!, name, x.from, x.to));
  }
}
