import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { FrontDeskService } from './front-desk.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

@Controller('v1/properties/:propertyId')
export class FrontDeskController {
  constructor(@Inject(FrontDeskService) private readonly svc: FrontDeskService) {}

  @Get('rack') @RequirePermission('reservation.view', P)
  rack(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.rack(pid, parse(S.RackQuery, q)); }

  @Post('reservations/:id/rooms/:lineId/check-in') @RequirePermission('frontdesk.check_in', P) @HttpCode(200)
  checkIn(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Body() body: unknown) { return this.svc.checkIn(pid, id, line, me(), parse(S.CheckIn, body)); }
  @Post('reservations/:id/rooms/:lineId/undo-check-in') @RequirePermission('frontdesk.check_in', P) @HttpCode(200)
  undo(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Body() body: unknown) { return this.svc.undoCheckIn(pid, id, line, me(), parse(S.UndoCheckIn, body).reason); }
  @Post('reservations/:id/rooms/:lineId/check-out') @RequirePermission('frontdesk.check_out', P) @HttpCode(200)
  checkOut(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Body() body: unknown) { return this.svc.checkOut(pid, id, line, me(), parse(S.CheckOut, body ?? {})); }
  @Post('reservations/:id/rooms/:lineId/move') @RequirePermission('frontdesk.check_in', P) @HttpCode(200)
  move(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Body() body: unknown) { return this.svc.moveRoom(pid, id, line, me(), parse(S.MoveRoom, body)); }
  /** `?reveal=true` shows full document numbers: needs the view-ID permission and a fresh second factor, and is audited. */
  @Get('reservations/:id/rooms/:lineId/guests') @RequirePermission('reservation.view', P)
  occupants(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Query() q: unknown) { return this.svc.occupants(pid, id, line, me(), parse(S.OccupantsQuery, q).reveal === 'true'); }

  /** Requires an Idempotency-Key header: prices at today's walk-in rate, books, and checks the guest in — all or nothing. */
  @Post('front-desk/walk-ins') @RequirePermission('frontdesk.check_in', P)
  async walkIn(@Param('propertyId', uuid()) pid: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    if (!key) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send an Idempotency-Key header (8–200 characters) with every walk-in' });
    const r = await this.svc.walkIn(pid, me(), key, parse(S.WalkIn, body));
    reply.status(r.replayed ? 200 : 201);
    return r.body;
  }

}
