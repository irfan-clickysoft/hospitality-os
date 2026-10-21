import { randomBytes } from 'node:crypto';
import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public, RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { GuestPortalService } from '../guest-portal/guest-portal.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { DocumentsService } from './documents.service.js';
import { PAGE_NOT_FOUND } from './render.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;
const page = (reply: FastifyReply, html: string, status = 200, nonce = '') => reply.status(status).type('text/html; charset=utf-8').header('Cache-Control', 'private, no-store').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff')
  .header('Content-Security-Policy', `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`).send(html);
const nonce = () => randomBytes(16).toString('base64');
const upload = async (req: FastifyRequest) => {
  if (!req.isMultipart()) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Send the file as an upload' });
  const part = await req.file(); if (!part) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'No file was sent' });
  const fields: Record<string, string> = {}; for (const [k, v] of Object.entries(part.fields ?? {})) { const x = v as { value?: unknown }; if (x && typeof x.value === 'string') fields[k] = x.value; }
  return { data: await part.toBuffer(), fields };
};

@Controller('v1/properties/:propertyId')
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly svc: DocumentsService) {}

  @Get('documents/payment/:id') @RequirePermission('folio.view', P)
  async payment(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Res() reply: FastifyReply) { const n = nonce(); return page(reply, await this.svc.html(p, 'PAYMENT', id, n), 200, n); }
  @Get('documents/statement/:id') @RequirePermission('folio.view', P)
  async statement(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Res() reply: FastifyReply) { const n = nonce(); return page(reply, await this.svc.html(p, 'STATEMENT', id, n), 200, n); }
  @Get('documents/order/:id') @RequirePermission('fnb.order', P)
  async order(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Res() reply: FastifyReply) { const n = nonce(); return page(reply, await this.svc.html(p, 'ORDER', id, n), 200, n); }
  @Post('documents/links') @RequirePermission('folio.view', P) @HttpCode(200)
  link(@Param('propertyId', uuid()) p: string, @Body() b: unknown, @Headers('origin') origin?: string) { return this.svc.linkFor(p, parse(S.LinkBody, b), me(), origin); }
  @Post('documents/links/revoke') @RequirePermission('folio.view', P) @HttpCode(200)
  revoke(@Param('propertyId', uuid()) p: string, @Body() b: unknown) { return this.svc.revoke(p, parse(S.LinkBody, b)); }

  @Post('branding/logo') @RequirePermission('property.manage', P)
  async logo(@Param('propertyId', uuid()) p: string, @Req() req: FastifyRequest) { return this.svc.setLogo(p, me(), (await upload(req)).data); }
  @Delete('branding/logo') @RequirePermission('property.manage', P) @HttpCode(204)
  async dropLogo(@Param('propertyId', uuid()) p: string) { await this.svc.removeLogo(p); }

  @Get('payment-slips') @RequirePermission('folio.view', P)
  slips(@Param('propertyId', uuid()) p: string, @Query() q: unknown) { return this.svc.slips(p, parse(S.SlipQuery, q)); }
  @Get('payment-slips/:id/file') @RequirePermission('folio.view', P)
  async slipFile(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const f = await this.svc.slipFile(p, id);
    reply.header('Content-Type', f.type).header('Content-Disposition', 'inline').header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(f.stream());
  }
  @Post('payment-slips/:id/record') @RequirePermission('payment.take', P) @HttpCode(200)
  record(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.recordFromSlip(p, id, me(), parse(S.SlipRecord, b)); }
  @Post('payment-slips/:id/reject') @RequirePermission('payment.take', P) @HttpCode(200)
  reject(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.rejectSlip(p, id, me(), parse(S.SlipReject, b).reason); }
  @Post('payments/:paymentId/slip') @RequirePermission('payment.take', P)
  async attach(@Param('propertyId', uuid()) p: string, @Param('paymentId', uuid()) id: string, @Req() req: FastifyRequest) { return this.svc.attachToPayment(p, id, me(), (await upload(req)).data); }
  @Get('payments/:paymentId/slips') @RequirePermission('folio.view', P)
  ofPayment(@Param('propertyId', uuid()) p: string, @Param('paymentId', uuid()) id: string) { return this.svc.slipsOfPayment(p, id); }
}

/** What a guest does with their private link: open a receipt or statement, and send the slip of a bank transfer. */
@Controller('v1/guest')
export class GuestDocumentsController {
  constructor(@Inject(DocumentsService) private readonly svc: DocumentsService, @Inject(GuestPortalService) private readonly portal: GuestPortalService) {}

  @Public() @Get('doc/:token')
  async doc(@Param('token') token: string, @Res() reply: FastifyReply) {
    const n = nonce(); const html = await this.svc.htmlByToken(token, n);
    return html ? page(reply, html, 200, n) : page(reply, PAGE_NOT_FOUND, 404, n);
  }
  @Public() @Post('booking/:token/slips') @HttpCode(201)
  async slip(@Param('token') token: string, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    const { data, fields } = await upload(req);
    const f = parse(S.SlipFields, fields);
    return this.portal.withToken(token, (id) => this.svc.submitGuest(id, data, f));
  }
}
