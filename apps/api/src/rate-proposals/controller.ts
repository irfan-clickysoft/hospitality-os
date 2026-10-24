import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public, RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { PAGE_NOT_FOUND } from '../documents/render.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { RateProposalsService } from './service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;
const nonce = () => randomBytes(16).toString('base64');
const page = (reply: FastifyReply, html: string, status = 200, n = '') => reply.status(status).type('text/html; charset=utf-8').header('Cache-Control', 'private, no-store').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff')
  .header('Content-Security-Policy', `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${n}'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`).send(html);

@Controller('v1/properties/:propertyId/rate-proposals')
export class RateProposalsController {
  constructor(@Inject(RateProposalsService) private readonly svc: RateProposalsService) {}
  @Get('defaults') @RequirePermission('company.view', P)
  defaults(@Param('propertyId', uuid()) p: string) { return this.svc.defaults(p); }
  @Get() @RequirePermission('company.view', P)
  list(@Param('propertyId', uuid()) p: string, @Query() q: unknown) { return this.svc.list(p, parse(S.ListQuery, q)); }
  @Post() @RequirePermission('company.manage', P)
  create(@Param('propertyId', uuid()) p: string, @Body() b: unknown) { return this.svc.create(p, me(), parse(S.ProposalBody, b)); }
  @Get(':id') @RequirePermission('company.view', P)
  get(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string) { return this.svc.get(p, id); }
  @Put(':id') @RequirePermission('company.manage', P)
  update(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.update(p, id, parse(S.UpdateProposal, b)); }
  @Post(':id/duplicate') @RequirePermission('company.manage', P) @HttpCode(200)
  duplicate(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string) { return this.svc.duplicate(p, me(), id); }
  @Post(':id/archive') @RequirePermission('company.manage', P) @HttpCode(200)
  archive(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string) { return this.svc.archive(p, id); }
  @Get(':id/page') @RequirePermission('company.view', P)
  async preview(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Res() reply: FastifyReply) { const n = nonce(); return page(reply, await this.svc.html(p, id, n), 200, n); }
  @Post(':id/link') @RequirePermission('company.manage', P) @HttpCode(200)
  link(@Param('propertyId', uuid()) p: string, @Param('id', uuid()) id: string, @Headers('origin') origin?: string) { return this.svc.linkFor(p, me(), id, origin); }
}

/** What the company opens from its private link. */
@Controller('v1/guest/rates')
export class GuestRateProposalController {
  constructor(@Inject(RateProposalsService) private readonly svc: RateProposalsService) {}
  @Public() @Get(':token')
  async open(@Param('token') token: string, @Res() reply: FastifyReply) { const n = nonce(); const html = await this.svc.htmlByToken(token, n); return html ? page(reply, html, 200, n) : page(reply, PAGE_NOT_FOUND, 404, n); }
}
