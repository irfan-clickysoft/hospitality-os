import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { PaymentAccountsService } from './payment-accounts.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

@Controller('v1')
export class PaymentAccountsController {
  constructor(@Inject(PaymentAccountsService) private readonly svc: PaymentAccountsService) {}
  /** The accounts a clerk can choose at this property when recording money received. */
  @Get('properties/:propertyId/payment-accounts') @RequirePermission('folio.view', P)
  forProperty(@Param('propertyId', uuid()) pid: string) { return this.svc.list(pid); }
  @Get('payment-accounts') @RequirePermission('paymentaccount.view', { anyScope: true })
  list(@Query() q: unknown) { return this.svc.list(null, parse(S.ListQuery, q).includeClosed); }
  @Get('payment-accounts/summary') @RequirePermission('paymentaccount.view', { anyScope: true })
  summary(@Query() q: unknown) { const x = parse(S.SummaryQuery, q); return this.svc.summary(x.from, x.to); }
  @Post('payment-accounts') @RequirePermission('paymentaccount.manage')
  create(@Body() body: unknown) { return this.svc.create(me(), parse(S.CreateAccount, body)); }
  @Patch('payment-accounts/:id') @RequirePermission('paymentaccount.manage')
  update(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.update(me(), id, parse(S.UpdateAccount, body)); }
  @Post('payment-accounts/:id/close') @RequirePermission('paymentaccount.manage') @HttpCode(200)
  close(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.close(me(), id, parse(S.CloseAccount, body)); }
}
