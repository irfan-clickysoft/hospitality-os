import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { ArService } from '../companies/ar.service.js';
import * as CS from '../companies/schemas.js';
import { InvoiceService } from '../invoices/invoice.service.js';
import * as IS from '../invoices/schemas.js';
import { SpacesService } from './spaces.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

@Controller('v1/properties/:propertyId/spaces')
export class SpacesController {
  constructor(@Inject(SpacesService) private readonly svc: SpacesService, @Inject(InvoiceService) private readonly invoices: InvoiceService, @Inject(ArService) private readonly ar: ArService) {}
  @Get() @RequirePermission('space.view', P)
  list(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.list(pid, parse(S.SpacesQuery, q).all); }
  @Post() @RequirePermission('space.manage', P)
  create(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.create(pid, me(), parse(S.CreateSpace, body)); }
  @Get('bookings') @RequirePermission('space.view', P)
  calendar(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.calendar(pid, parse(S.CalendarQuery, q)); }
  @Post('bookings') @RequirePermission('space.book', P)
  book(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.book(pid, me(), parse(S.CreateBooking, body)); }
  @Get('stays') @RequirePermission('space.book', P)
  stays(@Param('propertyId', uuid()) pid: string) { return this.svc.stays(pid); }
  @Patch('bookings/:bookingId') @RequirePermission('space.book', P)
  reschedule(@Param('propertyId', uuid()) pid: string, @Param('bookingId', uuid()) id: string, @Body() body: unknown) { return this.svc.reschedule(pid, id, me(), parse(S.UpdateBooking, body)); }
  @Post('bookings/:bookingId/complete') @RequirePermission('space.book', P) @HttpCode(200)
  complete(@Param('propertyId', uuid()) pid: string, @Param('bookingId', uuid()) id: string) { return this.svc.complete(pid, id, me()); }
  @Post('bookings/:bookingId/cancel') @RequirePermission('space.book', P) @HttpCode(200)
  cancel(@Param('propertyId', uuid()) pid: string, @Param('bookingId', uuid()) id: string, @Body() body: unknown) { return this.svc.cancel(pid, id, me(), parse(S.Cancel, body).reason); }
  /** Tax invoice for a hire that has a bill of its own. Same rules as a stay's invoice; it names the host (or a company) and the hire. */
  @Post('bookings/:bookingId/invoices') @RequirePermission('invoice.issue', P)
  invoice(@Param('propertyId', uuid()) pid: string, @Param('bookingId', uuid()) id: string, @Body() body: unknown) { return this.invoices.issueForHire(pid, id, me(), parse(IS.IssueInvoice, body ?? {})); }
  @Get('bookings/:bookingId/invoices') @RequirePermission('folio.view', P)
  invoicesOf(@Param('propertyId', uuid()) pid: string, @Param('bookingId', uuid()) id: string) { return this.svc.invoices(pid, id); }
  /** Moves what is owing on the hire's own bill onto a company's account (credit limit and manager override rules as for a stay). Needs an Idempotency-Key. */
  @Post('bookings/:bookingId/bill-to-company') @RequirePermission('ar.bill', P)
  async billCompany(@Param('propertyId', uuid()) pid: string, @Param('bookingId', uuid()) id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    if (!key) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send an Idempotency-Key header' });
    const r = await this.ar.billHire(pid, id, me(), key, parse(CS.BillToCompany, body ?? {}));
    reply.status(r.replayed ? 200 : 201);
    return r;
  }
  @Patch(':spaceId') @RequirePermission('space.manage', P)
  update(@Param('propertyId', uuid()) pid: string, @Param('spaceId', uuid()) id: string, @Body() body: unknown) { return this.svc.update(pid, id, me(), parse(S.UpdateSpace, body)); }
}
