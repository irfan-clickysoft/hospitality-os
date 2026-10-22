import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { MailService } from './mail.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();

@Controller('v1/properties/:propertyId/email')
export class MailController {
  constructor(@Inject(MailService) private readonly svc: MailService) {}

  /** Whether email is switched on, so screens can offer the button. */
  @Get('status') @RequirePermission('property.view', P)
  status() { return this.svc.status(); }
  @Get('recent') @RequirePermission('report.view', P)
  recent(@Param('propertyId', uuid()) p: string, @Query('limit') limit?: string) { return this.svc.recent(p, Math.min(Math.max(Number(limit) || 50, 1), 200)); }

  @Post('guest') @RequirePermission('reservation.view', P) @HttpCode(200)
  guest(@Param('propertyId', uuid()) p: string, @Body() b: unknown) { const x = parse(S.GuestSend, b); return this.svc.send(p, currentTenant().actorId!, { purpose: 'GUEST', refId: x.reservationId, to: x.to, subject: x.subject, text: x.text }); }
  @Post('company/:companyId') @RequirePermission('company.view', P) @HttpCode(200)
  company(@Param('propertyId', uuid()) p: string, @Param('companyId', uuid()) c: string, @Body() b: unknown) { const x = parse(S.CompanySend, b); return this.svc.send(p, currentTenant().actorId!, { purpose: 'COMPANY', refId: c, ...x }); }
}
