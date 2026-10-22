import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MediaService } from '../media/media.service.js';
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
  constructor(@Inject(PaymentAccountsService) private readonly svc: PaymentAccountsService, @Inject(MediaService) private readonly media: MediaService) {}
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

  @Post('payment-accounts/:id/qr') @RequirePermission('paymentaccount.manage')
  async uploadQr(@Param('id', uuid()) id: string, @Req() req: FastifyRequest) {
    if (!req.isMultipart()) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Send the QR code as a picture upload' });
    const part = await req.file();
    if (!part) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'No picture was sent' });
    const file = await this.media.savePrivateImage(await part.toBuffer());
    try { await this.media.removePrivate(await this.svc.setQr(id, file)); } catch (e) { await this.media.removePrivate(file); throw e; }
    return { hasQr: true };
  }
  @Delete('payment-accounts/:id/qr') @RequirePermission('paymentaccount.manage') @HttpCode(204)
  async removeQr(@Param('id', uuid()) id: string) { await this.media.removePrivate(await this.svc.setQr(id, null)); }
  /** Staff who may see payment accounts, and clerks recording a payment, can show the QR code to a guest. */
  @Get('payment-accounts/:id/qr') @RequirePermission('paymentaccount.view', { anyScope: true })
  async qr(@Param('id', uuid()) id: string, @Res({ passthrough: true }) reply: FastifyReply) { return this.sendQr(id, reply); }
  @Get('properties/:propertyId/payment-accounts/:id/qr') @RequirePermission('folio.view', P)
  async qrForProperty(@Param('id', uuid()) id: string, @Res({ passthrough: true }) reply: FastifyReply) { return this.sendQr(id, reply); }
  private async sendQr(id: string, reply: FastifyReply) {
    const f = await this.media.readPrivate(await this.svc.qrFile(id));
    reply.header('Content-Type', f.type).header('Cache-Control', 'private, max-age=300').header('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(f.data);
  }
}
