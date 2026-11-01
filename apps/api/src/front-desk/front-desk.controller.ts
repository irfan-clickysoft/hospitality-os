import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { FrontDeskService } from './front-desk.service.js';
import { TimingFeesService } from './timing-fees.service.js';
import { renderRegistrationCard } from './registration-card.js';
import * as S from './schemas.js';
import { z } from 'zod';
import { businessDate } from '../property-setup/schemas.js';

const Period = z.object({ from: businessDate, to: businessDate }).refine((v) => v.from <= v.to, { message: 'The start is after the end', path: ['to'] });

const HotelEyeQuery = z.object({ state: z.enum(['pending', 'done', 'all']).default('pending'), from: businessDate.optional(), to: businessDate.optional() })
const HotelEyeMark = z.object({ ref: z.string().trim().max(60).optional() }).strict();

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

@Controller('v1/properties/:propertyId')
export class FrontDeskController {
  constructor(@Inject(FrontDeskService) private readonly svc: FrontDeskService, @Inject(TimingFeesService) private readonly timing: TimingFeesService) {}

  @Get('rack') @RequirePermission('reservation.view', P)
  rack(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.rack(pid, parse(S.RackQuery, q)); }

  @Post('reservations/:id/rooms/:lineId/check-in') @RequirePermission('frontdesk.check_in', P) @HttpCode(200)
  checkIn(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Body() body: unknown) { return this.svc.checkIn(pid, id, line, me(), parse(S.CheckIn, body)); }
  @Get('reservations/:id/rooms/:lineId/timing-fee') @RequirePermission('reservation.view', P)
  timingFee(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Query() q: unknown) { return this.timing.get(pid, id, line, parse(S.TimingFeeQuery, q).kind); }
  @Post('reservations/:id/rooms/:lineId/timing-fee') @RequirePermission('frontdesk.check_in', P) @HttpCode(200)
  decideTimingFee(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Body() body: unknown) {
    const b = parse(S.TimingFeeDecision, body); return this.timing.decide(pid, id, line, me(), b);
  }
  @Post('reservations/:id/rooms/:lineId/undo-check-in') @RequirePermission('frontdesk.check_in', P) @HttpCode(200)
  undo(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Body() body: unknown) { return this.svc.undoCheckIn(pid, id, line, me(), parse(S.UndoCheckIn, body).reason); }
  @Get('reservations/:id/rooms/:lineId/check-out-preview') @RequirePermission('frontdesk.check_out', P)
  checkOutPreview(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) lineId: string) { return this.svc.checkOutPreview(pid, id, lineId); }
  @Post('reservations/:id/rooms/:lineId/check-out') @RequirePermission('frontdesk.check_out', P) @HttpCode(200)
  checkOut(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Body() body: unknown) { return this.svc.checkOut(pid, id, line, me(), parse(S.CheckOut, body ?? {})); }
  @Post('reservations/:id/rooms/:lineId/move') @RequirePermission('frontdesk.check_in', P) @HttpCode(200)
  move(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Body() body: unknown) { return this.svc.moveRoom(pid, id, line, me(), parse(S.MoveRoom, body)); }
  /** `?reveal=true` shows full document numbers: needs the view-ID permission and a fresh second factor, and is audited. */
  /** A printable registration card with signature lines. ?reveal=true prints full ID numbers (needs the same permission and fresh second factor as seeing them). */
  @Get('reservations/:id/rooms/:lineId/registration-card') @RequirePermission('reservation.view', P)
  async card(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Query() q: unknown, @Res() reply: FastifyReply) {
    const v = await this.svc.registrationCard(pid, id, line, me(), parse(S.OccupantsQuery, q).reveal === 'true');
    reply.header('content-type', 'text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'").header('x-content-type-options', 'nosniff').send(renderRegistrationCard(v));
  }
  @Get('registration-rules') @RequirePermission('reservation.view', P)
  rules(@Param('propertyId', uuid()) pid: string) { return this.svc.rulesText(pid); }
  @Post('reservations/:id/rooms/:lineId/registration-sign') @RequirePermission('frontdesk.check_in', P) @HttpCode(200)
  sign(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string, @Body() body: unknown) { return this.svc.signCard(pid, id, line, me(), parse(S.SignCard, body)); }
  @Post('reservations/:id/rooms/:lineId/registration-sign/clear') @RequirePermission('frontdesk.check_in', P) @HttpCode(200)
  clearSign(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('lineId', uuid()) line: string) { return this.svc.clearSignature(pid, id, line, me()); }
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


  /** The foreign-guest register for the FRO / Hotel Eye: full passport numbers, so a view-ID permission and a fresh second factor are needed. */
  @Get('registration/foreign-register') @RequirePermission('frontdesk.view_id', P)
  foreignRegister(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { const x = parse(Period, q); return this.svc.foreignRegister(pid, me(), x.from, x.to); }

  /** Hotel Eye is typed in by hand on the portal: this keeps the list of who still has to be entered, and lays each person's details out ready to copy. */
  @Get('registration/hotel-eye') @RequirePermission('frontdesk.check_in', P)
  hotelEye(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.hotelEyeList(pid, parse(HotelEyeQuery, q)); }
  @Get('registration/hotel-eye/:guestId') @RequirePermission('frontdesk.view_id', P)
  hotelEyeDetail(@Param('propertyId', uuid()) pid: string, @Param('guestId', uuid()) g: string) { return this.svc.hotelEyeDetail(pid, me(), g); }
  @Post('registration/hotel-eye/:guestId/entered') @RequirePermission('frontdesk.check_in', P) @HttpCode(200)
  hotelEyeEntered(@Param('propertyId', uuid()) pid: string, @Param('guestId', uuid()) g: string, @Body() b: unknown) { return this.svc.hotelEyeMark(pid, me(), g, true, parse(HotelEyeMark, b).ref ?? null); }
  @Post('registration/hotel-eye/:guestId/undo') @RequirePermission('frontdesk.check_in', P) @HttpCode(200)
  hotelEyeUndo(@Param('propertyId', uuid()) pid: string, @Param('guestId', uuid()) g: string) { return this.svc.hotelEyeMark(pid, me(), g, false, null); }
}
