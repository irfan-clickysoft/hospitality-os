import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { ReservationsService } from './reservations.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

@Controller('v1/properties/:propertyId')
export class ReservationsController {
  constructor(@Inject(ReservationsService) private readonly svc: ReservationsService) {}

  /** Requires an Idempotency-Key header: a retry (flaky network, double click) returns the same reservation and never books twice. */
  @Post('reservations') @RequirePermission('reservation.create', P)
  async create(@Param('propertyId', uuid()) pid: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    if (!key) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send an Idempotency-Key header (8–200 characters) with every booking request' });
    const r = await this.svc.create(pid, me(), key, parse(S.CreateReservation, body));
    reply.status(r.replayed ? 200 : 201);
    return r;
  }
  @Get('reservations') @RequirePermission('reservation.view', P)
  list(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.list(pid, parse(S.ListQuery, q)); }
  @Get('reservations/:id') @RequirePermission('reservation.view', P)
  get(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.get(pid, id); }
  @Patch('reservations/:id') @RequirePermission('reservation.modify', P)
  update(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.update(pid, id, parse(S.UpdateReservation, body)); }

  @Post('reservations/:id/confirm') @RequirePermission('reservation.modify', P) @HttpCode(200)
  confirm(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.confirm(pid, id, me()); }
  @Post('reservations/:id/cancel') @RequirePermission('reservation.cancel', P) @HttpCode(200)
  cancel(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.cancel(pid, id, me(), parse(S.CancelReservation, body)); }
  @Post('reservations/:id/no-show') @RequirePermission('reservation.cancel', P) @HttpCode(200)
  noShow(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.noShow(pid, id, me(), parse(S.NoShow, body ?? {})); }
  @Post('reservations/:id/reinstate') @RequirePermission('reservation.cancel', P) @HttpCode(200)
  reinstate(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.reinstate(pid, id, me(), parse(S.Reinstate, body)); }
  @Post('reservations/:id/reconfirm') @RequirePermission('reservation.modify', P) @HttpCode(200)
  reconfirm(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.reconfirm(pid, id); }

  @Patch('reservations/:id/rooms/:lineId') @RequirePermission('reservation.modify', P)
  modify(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Body() body: unknown) { return this.svc.modify(pid, id, line, me(), parse(S.ModifyLine, body)); }
  @Put('reservations/:id/rooms/:lineId/assignment') @RequirePermission('reservation.modify', P)
  assign(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Body() body: unknown) { return this.svc.assignRoom(pid, id, line, parse(S.AssignRoom, body).roomId); }
  @Delete('reservations/:id/rooms/:lineId/assignment') @RequirePermission('reservation.modify', P)
  unassign(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string) { return this.svc.unassignRoom(pid, id, line); }
  @Get('available-rooms') @RequirePermission('reservation.view', P)
  availableRooms(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { const x = parse(S.AvailableRoomsQuery, q); return this.svc.availableRooms(pid, x.roomTypeId, x.arrival, x.departure).then((items) => ({ items })); }
}
