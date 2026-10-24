import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Public, RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { MailFeedbackService } from './feedback.service.js';
import { MailService } from './mail.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();

@Controller('v1/properties/:propertyId/email')
export class MailController {
  constructor(@Inject(MailService) private readonly svc: MailService) {}
  @Get('suppressed') @RequirePermission('report.view', P)
  suppressed() { return this.svc.suppressions(); }
  @Delete('suppressed/:address') @RequirePermission('property.manage', P) @HttpCode(200)
  allow(@Param('propertyId', uuid()) p: string, @Param('address') a: string) { return this.svc.allow(p, a); }

  /** Whether email is switched on, so screens can offer the button. */
  @Get('status') @RequirePermission('property.view', P)
  status() { return this.svc.status(); }
  @Get('recent') @RequirePermission('report.view', P)
  recent(@Param('propertyId', uuid()) p: string, @Query('limit') limit?: string) { return this.svc.recent(p, Math.min(Math.max(Number(limit) || 50, 1), 200)); }

  @Post('guest') @RequirePermission('reservation.view', P) @HttpCode(200)
  guest(@Param('propertyId', uuid()) p: string, @Body() b: unknown) { const x = parse(S.GuestSend, b); return this.svc.send(p, currentTenant().actorId!, { purpose: 'GUEST', refId: x.reservationId, to: x.to, subject: x.subject, text: x.text }); }
  @Post('company/:companyId') @RequirePermission('company.view', P) @HttpCode(200)
  company(@Param('propertyId', uuid()) p: string, @Param('companyId', uuid()) c: string, @Body() b: unknown) { const x = parse(S.CompanySend, b); return this.svc.send(p, currentTenant().actorId!, { purpose: 'COMPANY', refId: c, ...x }); }
  @Post('quotation/:quotationId') @RequirePermission('reservation.create', P) @HttpCode(200)
  quotation(@Param('propertyId', uuid()) p: string, @Param('quotationId', uuid()) q: string, @Body() b: unknown) { const x = parse(S.QuotationSend, b); return this.svc.send(p, currentTenant().actorId!, { purpose: 'QUOTATION', refId: q, ...x }); }
}

/** Where Amazon reports what became of each email. Public, but nothing is believed unless Amazon signed it for our own topic. */
@Controller('v1/hooks')
export class MailHooksController {
  constructor(@Inject(MailFeedbackService) private readonly fb: MailFeedbackService) {}

  @Public() @Post('ses') @HttpCode(200)
  async ses(@Body() body: unknown) {
    let m: unknown = body;
    if (typeof body === 'string') { try { m = JSON.parse(body); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Not a notification' }); } }
    if (!m || typeof m !== 'object') throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Not a notification' });
    if (!(await this.fb.receive(m as never))) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Not accepted' });
    return { ok: true };
  }
}
