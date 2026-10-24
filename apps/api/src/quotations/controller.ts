import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public, RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { PAGE_NOT_FOUND } from '../documents/render.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { QuoteSettingsBody } from './defaults.js';
import { QuotationsService } from './service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;
const nonce = () => randomBytes(16).toString('base64');
const page = (reply: FastifyReply, html: string, status = 200, n = '') => reply.status(status).type('text/html; charset=utf-8').header('Cache-Control', 'private, no-store').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff')
  .header('Content-Security-Policy', `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${n}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`).send(html);

@Controller('v1/properties/:propertyId/quotations')
export class QuotationsController {
  constructor(@Inject(QuotationsService) private readonly svc: QuotationsService) {}

  /** The wording around the figures (greeting, closing, contacts, terms): the property's own, or the built-in one. */
  @Get('settings') @RequirePermission('reservation.view', P)
  settings(@Param('propertyId', uuid()) p: string) { return this.svc.settings(p); }
  @Put('settings') @RequirePermission('property.manage', P)
  saveSettings(@Param('propertyId', uuid()) p: string, @Body() b: unknown) { return this.svc.saveSettings(p, parse(QuoteSettingsBody, b)); }
  @Post('settings/reset') @RequirePermission('property.manage', P) @HttpCode(200)
  resetSettings(@Param('propertyId', uuid()) p: string) { return this.svc.resetSettings(p); }
  @Get() @RequirePermission('reservation.view', P)
  list(@Param('propertyId', uuid()) p: string, @Query() q: unknown) { return this.svc.list(p, parse(S.ListQuery, q)); }
  /** Works out the figures for what is on the screen, without saving. */
  @Post('price') @RequirePermission('reservation.create', P) @HttpCode(200)
  price(@Param('propertyId', uuid()) p: string, @Body() b: unknown) { return this.svc.priceOnly(p, me(), parse(S.QuotationBody, b)); }
  @Post() @RequirePermission('reservation.create', P)
  create(@Param('propertyId', uuid()) p: string, @Body() b: unknown) { return this.svc.create(p, me(), parse(S.QuotationBody, b)); }
  @Get(':id') @RequirePermission('reservation.view', P)
  get(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string) { return this.svc.get(p, id); }
  @Put(':id') @RequirePermission('reservation.create', P)
  update(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.update(p, me(), id, parse(S.UpdateQuotation, b)); }
  @Get(':id/page') @RequirePermission('reservation.view', P)
  async preview(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Res() reply: FastifyReply) { const n = nonce(); return page(reply, await this.svc.html(p, id, n), 200, n); }
  @Post(':id/link') @RequirePermission('reservation.create', P) @HttpCode(200)
  link(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Headers('origin') origin?: string) { return this.svc.linkFor(p, me(), id, origin); }
  @Post(':id/revise') @RequirePermission('reservation.create', P) @HttpCode(200)
  revise(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string) { return this.svc.revise(p, id); }
  @Post(':id/cancel') @RequirePermission('reservation.create', P) @HttpCode(200)
  cancel(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string) { return this.svc.cancel(p, id); }
  @Post(':id/mark') @RequirePermission('reservation.create', P) @HttpCode(200)
  mark(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.mark(p, id, parse(S.Mark, b), me()); }
  @Post(':id/seen') @RequirePermission('reservation.view', P) @HttpCode(200)
  seen(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string) { return this.svc.seen(p, id); }
  @Post(':id/convert') @RequirePermission('reservation.create', P) @HttpCode(200)
  convert(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.convert(p, me(), id, parse(S.Convert, b ?? {})); }
}

/** What the customer does with their private link: read the quotation, and accept or decline it. */
@Controller('v1/guest/quote')
export class GuestQuotationController {
  constructor(@Inject(QuotationsService) private readonly svc: QuotationsService) {}

  @Public() @Get(':token')
  async open(@Param('token') token: string, @Res() reply: FastifyReply) {
    const n = nonce(); const html = await this.svc.htmlByToken(token, n);
    return html ? page(reply, html, 200, n) : page(reply, PAGE_NOT_FOUND, 404, n);
  }
  @Public() @Post(':token/respond') @HttpCode(200)
  respond(@Param('token') token: string, @Body() b: unknown, @Res({ passthrough: true }) reply: FastifyReply) { reply.header('Cache-Control', 'no-store'); return this.svc.respond(token, parse(S.Respond, b)); }
}
