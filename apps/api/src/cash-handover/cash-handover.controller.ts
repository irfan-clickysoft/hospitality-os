import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { CashHandoverService, Handover } from './cash-handover.service.js';
import { renderHandoverHtml } from './render.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();

@Controller('v1/properties/:propertyId/cash-safe')
export class CashHandoverController {
  constructor(@Inject(CashHandoverService) private readonly svc: CashHandoverService) {}
  /** What the safe should hold (from the closed registers' envelopes, less what has been handed over), the envelopes by day and register, and the handovers so far. */
  @Get() @RequirePermission('cashier.review', P)
  safe(@Param('propertyId', uuid()) pid: string) { return this.svc.safe(pid); }
  /** Cash leaving the safe for head office. Manager action with a fresh second factor; the amount, who received it and any difference from the safe balance are recorded for good. */
  @Post('handovers') @RequirePermission('cashier.handover', P) @HttpCode(201)
  handOver(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.handOver(pid, currentTenant().actorId!, parse(Handover, body)); }
  /** A printable receipt with lines for both signatures. Open it in a browser tab and print or save as PDF. */
  @Get('handovers/:id/print') @RequirePermission('cashier.review', P)
  async print(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Res() reply: FastifyReply) {
    const v = await this.svc.receipt(pid, id);
    reply.header('content-type', 'text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'").header('x-content-type-options', 'nosniff').send(renderHandoverHtml(v));
  }
}
