import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Authenticated } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { businessDate } from '../property-setup/schemas.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { PortfolioService } from './portfolio.service.js';

const Q = z.object({ from: businessDate.optional(), to: businessDate.optional(), view: z.string().max(30).optional(), group: z.string().max(30).optional(), format: z.enum(['json', 'csv']).optional() });

/** Reports across all the properties a person may see reports for. */
@Controller('v1/insights/portfolio')
export class PortfolioController {
  constructor(@Inject(PortfolioService) private readonly svc: PortfolioService) {}
  @Authenticated() @Get()
  catalog() { return this.svc.catalog(currentTenant().actorId!); }
  @Authenticated() @Get(':id')
  async run(@Param('id') id: string, @Query() q: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const x = parse(Q, q); const me = currentTenant().actorId!; reply.header('cache-control', 'no-store');
    const input = { from: x.from, to: x.to, params: { ...(x.view ? { view: x.view } : {}), ...(x.group ? { group: x.group } : {}) } };
    if (x.format === 'csv') { const r = await this.svc.csv(me, id, input); reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${r.filename}"`).header('x-content-type-options', 'nosniff'); return '﻿' + r.csv; }
    return this.svc.run(me, id, input);
  }
}
