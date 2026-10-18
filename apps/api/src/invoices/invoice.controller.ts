import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { InvoiceService } from './invoice.service.js';
import { renderInvoiceHtml } from './render.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();

@Controller('v1/properties/:propertyId')
export class InvoiceController {
  constructor(@Inject(InvoiceService) private readonly svc: InvoiceService) {}

  @Post('reservations/:id/invoices') @RequirePermission('invoice.issue', P)
  issue(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.issue(pid, id, currentTenant().actorId!, parse(S.IssueInvoice, body ?? {})); }
  @Get('reservations/:id/invoices') @RequirePermission('folio.view', P)
  forReservation(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.forReservation(pid, id); }
  @Get('invoices') @RequirePermission('folio.view', P)
  find(@Param('propertyId', uuid()) pid: string, @Query('number') number = '') { return this.svc.search(pid, number); }
  @Get('invoices/:invoiceId') @RequirePermission('folio.view', P)
  get(@Param('propertyId', uuid()) pid: string, @Param('invoiceId', uuid()) id: string) { return this.svc.get(pid, id); }
  /** A printable page. Open it in a browser tab and print or save as PDF. */
  @Get('invoices/:invoiceId/print') @RequirePermission('folio.view', P)
  async print(@Param('propertyId', uuid()) pid: string, @Param('invoiceId', uuid()) id: string, @Res() reply: FastifyReply) {
    const v = await this.svc.get(pid, id);
    reply.header('content-type', 'text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'").header('x-content-type-options', 'nosniff').send(renderInvoiceHtml(v as never));
  }
  /** Reverses the whole invoice; the items can then be invoiced again. Manager action (second factor). */
  @Post('invoices/:invoiceId/credit') @RequirePermission('invoice.credit', P) @HttpCode(200)
  credit(@Param('propertyId', uuid()) pid: string, @Param('invoiceId', uuid()) id: string, @Body() body: unknown) { return this.svc.credit(pid, id, currentTenant().actorId!, parse(S.CreditInvoice, body).reason); }
}
