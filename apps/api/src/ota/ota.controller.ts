import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { OtaService } from './ota.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;
const needKey = (key: string | undefined) => { if (!key) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send an Idempotency-Key header (8–200 characters) with every money request' }); return key; };

@Controller('v1/properties/:propertyId')
export class OtaController {
  constructor(@Inject(OtaService) private readonly svc: OtaService) {}

  @Post('reservations/:id/ota-claim') @RequirePermission('ota.claim', P)
  async claim(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.svc.claim(pid, id, me(), needKey(key), parse(S.ClaimFee, body));
    reply.status(r.replayed ? 200 : 201);
    return r;
  }
  @Get('reservations/:id/ota-claims') @RequirePermission('folio.view', P)
  forReservation(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.forReservation(pid, id); }
  @Get('ota-receivables') @RequirePermission('folio.view', P)
  list(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.list(pid, parse(S.ListQuery, q)); }
  @Get('ota-receivables/ageing') @RequirePermission('folio.view', P)
  ageing(@Param('propertyId', uuid()) pid: string) { return this.svc.ageing(pid); }
  @Get('ota-receivables/:rid') @RequirePermission('folio.view', P)
  history(@Param('propertyId', uuid()) pid: string, @Param('rid', uuid()) id: string) { return this.svc.history(pid, id); }
  @Post('ota-receivables/:rid/claimed') @RequirePermission('ota.claim', P) @HttpCode(200)
  claimed(@Param('propertyId', uuid()) pid: string, @Param('rid', uuid()) id: string, @Body() body: unknown) { return this.svc.markClaimed(pid, id, me(), parse(S.MarkClaimed, body)); }
  @Post('ota-receivables/:rid/receive') @RequirePermission('ota.claim', P) @HttpCode(200)
  receive(@Param('propertyId', uuid()) pid: string, @Param('rid', uuid()) id: string, @Body() body: unknown) { return this.svc.receive(pid, id, me(), parse(S.Receive, body)); }
  @Post('ota-receivables/:rid/dispute') @RequirePermission('ota.claim', P) @HttpCode(200)
  dispute(@Param('propertyId', uuid()) pid: string, @Param('rid', uuid()) id: string, @Body() body: unknown) { return this.svc.dispute(pid, id, me(), parse(S.Dispute, body).reason); }
  @Post('ota-receivables/:rid/resolve') @RequirePermission('ota.claim', P) @HttpCode(200)
  resolve(@Param('propertyId', uuid()) pid: string, @Param('rid', uuid()) id: string, @Body() body: unknown) { return this.svc.resolve(pid, id, me(), parse(S.Resolve, body).note); }
  @Post('ota-receivables/:rid/write-off') @RequirePermission('ota.writeoff', P) @HttpCode(200)
  writeOff(@Param('propertyId', uuid()) pid: string, @Param('rid', uuid()) id: string, @Body() body: unknown) { return this.svc.writeOff(pid, id, me(), parse(S.WriteOff, body)); }
  @Post('ota-receivables/:rid/void') @RequirePermission('folio.adjust', P) @HttpCode(200)
  voidClaim(@Param('propertyId', uuid()) pid: string, @Param('rid', uuid()) id: string, @Body() body: unknown) { return this.svc.voidClaim(pid, id, me(), parse(S.VoidClaim, body).reason); }
}
