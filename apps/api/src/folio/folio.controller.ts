import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { CashierService } from './cashier.service.js';
import { FolioService } from './folio.service.js';
import { PaymentsService } from './payments.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;
const needKey = (key: string | undefined) => { if (!key) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send an Idempotency-Key header (8–200 characters) with every money request' }); return key; };

@Controller('v1/properties/:propertyId')
export class FolioController {
  constructor(
    @Inject(FolioService) private readonly folios: FolioService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(CashierService) private readonly cashier: CashierService,
  ) {}

  // ── folio ──
  @Get('reservations/:id/folio') @RequirePermission('folio.view', P)
  folio(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.folios.forReservation(pid, id); }
  @Post('folios/:folioId/charges') @RequirePermission('folio.post', P)
  charge(@Param('propertyId', uuid()) pid: string, @Param('folioId', uuid()) fid: string, @Body() body: unknown) { return this.folios.charge(pid, fid, me(), parse(S.ManualCharge, body)); }
  @Post('folios/:folioId/postings/:postingId/discount') @RequirePermission('folio.post', P)
  discount(@Param('propertyId', uuid()) pid: string, @Param('folioId', uuid()) fid: string, @Param('postingId', uuid()) id: string, @Body() body: unknown) { return this.folios.discount(pid, fid, id, me(), parse(S.DiscountPosting, body)); }
  @Post('folios/:folioId/postings/:postingId/reverse') @RequirePermission('folio.adjust', P) @HttpCode(200)
  reverse(@Param('propertyId', uuid()) pid: string, @Param('folioId', uuid()) fid: string, @Param('postingId', uuid()) id: string, @Body() body: unknown) { return this.folios.reverse(pid, fid, id, me(), parse(S.ReversePosting, body).reason); }
  @Post('folios/:folioId/close') @RequirePermission('folio.post', P) @HttpCode(200)
  close(@Param('propertyId', uuid()) pid: string, @Param('folioId', uuid()) fid: string) { return this.folios.close(pid, fid, me()); }
  @Post('folios/:folioId/reopen') @RequirePermission('folio.adjust', P) @HttpCode(200)
  reopen(@Param('propertyId', uuid()) pid: string, @Param('folioId', uuid()) fid: string, @Body() body: unknown) { return this.folios.reopen(pid, fid, me(), parse(S.ReversePosting, body).reason); }
  @Get('folio-check') @RequirePermission('report.view', P)
  check(@Param('propertyId', uuid()) pid: string) { return this.folios.checkInvariants(pid).then((issues) => ({ ok: issues.length === 0, issues })); }

  // ── payments ──
  /** Needs an Idempotency-Key: a retry never takes the money twice. Cash needs your open cashier session; bank transfers wait for a second person to verify. */
  @Post('reservations/:id/payments') @RequirePermission('payment.take', P)
  async pay(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.payments.record(pid, id, me(), needKey(key), parse(S.RecordPayment, body));
    reply.status(r.replayed ? 200 : 201);
    return r;
  }
  @Get('payments/pending') @RequirePermission('payment.verify', P)
  pending(@Param('propertyId', uuid()) pid: string) { return this.payments.pending(pid); }
  @Post('payments/:paymentId/verify') @RequirePermission('payment.verify', P) @HttpCode(200)
  verify(@Param('propertyId', uuid()) pid: string, @Param('paymentId', uuid()) id: string, @Body() body: unknown) { return this.payments.verify(pid, id, me(), parse(S.VerifyPayment, body)); }
  @Post('payments/:paymentId/void') @RequirePermission('folio.adjust', P) @HttpCode(200)
  voidPayment(@Param('propertyId', uuid()) pid: string, @Param('paymentId', uuid()) id: string, @Body() body: unknown) { return this.payments.void(pid, id, me(), parse(S.VoidPayment, body).reason); }
  @Post('payments/:paymentId/refund') @RequirePermission('payment.refund', P)
  async refund(@Param('propertyId', uuid()) pid: string, @Param('paymentId', uuid()) id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.payments.refund(pid, id, me(), needKey(key), parse(S.RefundPayment, body));
    reply.status(r.replayed ? 200 : 201);
    return r;
  }

  // ── cashier ──
  @Post('cashier/sessions') @RequirePermission('cashier.operate', P)
  openSession(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.cashier.open(pid, me(), parse(S.OpenSession, body ?? {})); }
  @Get('cashier/sessions/current') @RequirePermission('cashier.operate', P)
  current(@Param('propertyId', uuid()) pid: string) { return this.cashier.current(pid, me()); }
  @Get('cashier/sessions') @RequirePermission('cashier.operate', P)
  sessions(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.cashier.list(pid, me(), parse(S.SessionsQuery, q)); }
  @Get('cashier/sessions/:sessionId') @RequirePermission('cashier.operate', P)
  session(@Param('propertyId', uuid()) pid: string, @Param('sessionId', uuid()) id: string) { return this.cashier.get(pid, id, me()); }
  @Post('cashier/sessions/:sessionId/drops') @RequirePermission('cashier.operate', P)
  drop(@Param('propertyId', uuid()) pid: string, @Param('sessionId', uuid()) id: string, @Body() body: unknown) { return this.cashier.drop(pid, id, me(), parse(S.CashDrop, body)); }
  @Post('cashier/sessions/:sessionId/close') @RequirePermission('cashier.operate', P) @HttpCode(200)
  closeSession(@Param('propertyId', uuid()) pid: string, @Param('sessionId', uuid()) id: string, @Body() body: unknown) { return this.cashier.close(pid, id, me(), parse(S.CloseSession, body)); }
  @Post('cashier/sessions/:sessionId/review') @RequirePermission('cashier.review', P) @HttpCode(200)
  reviewSession(@Param('propertyId', uuid()) pid: string, @Param('sessionId', uuid()) id: string, @Body() body: unknown) { return this.cashier.review(pid, id, me(), parse(S.ReviewSession, body ?? {})); }
}
