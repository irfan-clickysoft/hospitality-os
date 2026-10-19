import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { ChargeReviewService } from './charge-review.service.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const Q = z.object({ status: z.enum(['OPEN', 'DONE', 'ALL']).default('OPEN') });
const Resolve = z.object({ note: z.string().trim().min(3).max(300) });

@Controller('v1/properties/:propertyId/charge-reviews')
export class ChargeReviewController {
  constructor(@Inject(ChargeReviewService) private readonly svc: ChargeReviewService) {}
  @Get() @RequirePermission('compliance.view', P)
  list(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.list(pid, parse(Q, q).status); }
  @Post(':id/resolve') @RequirePermission('compliance.task', P) @HttpCode(200)
  resolve(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.resolve(pid, id, currentTenant().actorId!, parse(Resolve, body).note); }
}
