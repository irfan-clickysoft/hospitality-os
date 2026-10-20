import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public, RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { GuestPortalService } from './guest-portal.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();

/** The guest's own booking page. No sign-in: the long random link is the key, and every answer is limited to that one booking. */
@Controller('v1/guest')
export class GuestPortalController {
  constructor(@Inject(GuestPortalService) private readonly svc: GuestPortalService) {}

  @Public() @Get('booking/:token')
  page(@Param('token') token: string, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex').header('Referrer-Policy', 'no-referrer');
    return this.svc.withToken(token, (id) => this.svc.page(id));
  }

  @Public() @Post('booking/:token/requests') @HttpCode(201)
  request(@Param('token') token: string, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    const input = parse(S.GuestRequest, body);
    return this.svc.withToken(token, (id) => this.svc.request(id, input));
  }
}

/** What hotel staff see and do. */
@Controller('v1')
export class GuestRequestsController {
  constructor(@Inject(GuestPortalService) private readonly svc: GuestPortalService) {}

  @Get('properties/:propertyId/reservations/:reservationId/guest-link') @RequirePermission('reservation.view', P)
  link(@Param('propertyId', uuid()) p: string, @Param('reservationId', uuid()) r: string) { return this.svc.tokenFor(p, r); }

  @Get('properties/:propertyId/guest-requests') @RequirePermission('reservation.view', P)
  list(@Param('propertyId', uuid()) p: string, @Query() q: unknown) { return this.svc.list(p, parse(S.ListRequests, q)); }

  @Patch('properties/:propertyId/guest-requests/:requestId') @RequirePermission('reservation.modify', P)
  handle(@Param('propertyId', uuid()) p: string, @Param('requestId', uuid()) id: string, @Body() body: unknown) { return this.svc.handle(p, id, parse(S.HandleRequest, body)); }
}
