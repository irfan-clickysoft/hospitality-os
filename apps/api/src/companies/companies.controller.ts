import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { ArService } from './ar.service.js';
import { CompaniesService } from './companies.service.js';
import { renderStatementHtml } from './render.js';
import * as S from './schemas.js';
import { BadRequestException } from '@nestjs/common';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const ANY = { anyScope: true } as const;
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;
const needKey = (key: string | undefined) => { if (!key) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send an Idempotency-Key header (8–200 characters) with every money request' }); return key; };

@Controller('v1')
export class CompaniesController {
  constructor(
    @Inject(CompaniesService) private readonly companies: CompaniesService,
    @Inject(ArService) private readonly ar: ArService,
    @Inject(TenantDb) private readonly tdb: TenantDb,
  ) {}

  // ── accounts ──
  @Get('companies') @RequirePermission('company.view', ANY)
  list(@Query() q: unknown) { return this.companies.list(parse(S.ListCompanies, q)); }
  @Post('companies') @RequirePermission('company.manage', ANY)
  create(@Body() body: unknown) { return this.companies.create(me(), parse(S.CreateCompany, body)); }
  @Get('companies/:id') @RequirePermission('company.view', ANY)
  get(@Param('id', uuid()) id: string) { return this.companies.get(id); }
  @Patch('companies/:id') @RequirePermission('company.manage', ANY)
  update(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.companies.update(me(), id, parse(S.UpdateCompany, body)); }
  @Put('companies/:id/status') @RequirePermission('company.manage', ANY)
  status(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.companies.setStatus(me(), id, parse(S.SetStatus, body)); }

  // ── what they owe ──
  @Get('companies/:id/items') @RequirePermission('company.view', ANY)
  items(@Param('id', uuid()) id: string, @Query('open') open?: string) { return this.ar.items({ companyId: id, openOnly: open === 'true' }); }
  @Get('companies/:id/statement') @RequirePermission('company.view', ANY)
  statement(@Param('id', uuid()) id: string, @Query() q: unknown) { const x = parse(S.StatementQuery, q); return this.ar.statement(id, x.from, x.to); }
  /** A printable page. Open it in a browser tab and print or save as PDF. */
  @Get('companies/:id/statement/print') @RequirePermission('company.view', ANY)
  async print(@Param('id', uuid()) id: string, @Query() q: unknown, @Res() reply: FastifyReply) {
    const x = parse(S.StatementQuery, q);
    const v = await this.ar.statement(id, x.from, x.to);
    const issuer = await this.tdb.tx(async (trx) => (await trx.selectFrom('legal_entity').select(['name', 'ntn', 'strn']).orderBy('name').limit(1).executeTakeFirst()) ?? { name: '' });
    reply.header('content-type', 'text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'").header('x-content-type-options', 'nosniff').send(renderStatementHtml(v as never, issuer));
  }
  @Get('ar/aging') @RequirePermission('company.view', ANY)
  aging(@Query() q: unknown) { return this.ar.aging(parse(S.AgingQuery, q).asOf); }

  // ── money in ──
  @Post('companies/:id/receipts') @RequirePermission('ar.receipt', ANY)
  receipt(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.ar.recordReceipt(id, me(), parse(S.RecordReceipt, body)); }
  @Get('ar/receipts') @RequirePermission('company.view', ANY)
  receipts(@Query('companyId') companyId?: string, @Query('status') status?: string) { return this.ar.receipts({ companyId, status }); }
  @Post('ar/receipts/:receiptId/verify') @RequirePermission('ar.verify', ANY) @HttpCode(200)
  verify(@Param('receiptId', uuid()) id: string, @Body() body: unknown) { return this.ar.verifyReceipt(id, me(), parse(S.VerifyReceipt, body)); }

  // ── billing a stay to a company ──
  @Post('properties/:propertyId/reservations/:id/bill-to-company') @RequirePermission('ar.bill', P)
  async bill(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.ar.bill(pid, id, me(), needKey(key), parse(S.BillToCompany, body));
    reply.status(r.replayed ? 200 : 201);
    return r;
  }
  @Get('properties/:propertyId/reservations/:id/company-billings') @RequirePermission('folio.view', P)
  billings(@Param('id', uuid()) id: string) { return this.ar.items({ reservationId: id }); }
  @Post('properties/:propertyId/ar-items/:itemId/void') @RequirePermission('folio.adjust', P) @HttpCode(200)
  voidItem(@Param('propertyId', uuid()) pid: string, @Param('itemId', uuid()) id: string, @Body() body: unknown) { return this.ar.voidItem(pid, id, me(), parse(S.VoidItem, body).reason); }
}
