import { BadRequestException, Body, Controller, Headers, HttpCode, Inject, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { ImportsService } from './imports.service.js';
import * as S from './schemas.js';

const ANY = { anyScope: true } as const;
const needKey = (key: string | undefined) => { if (!key) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send an Idempotency-Key header (8–200 characters) with every import' }); return key; };

/** Spreadsheets are read in the browser; the server gets rows. A preview changes nothing; a commit checks every row again. */
@Controller('v1/imports')
export class ImportsController {
  constructor(@Inject(ImportsService) private readonly svc: ImportsService) {}
  @Post('guests/preview') @RequirePermission('data.import', ANY) @HttpCode(200)
  previewGuests(@Body() body: unknown) { return this.svc.previewGuests(parse(S.GuestImport, body)); }
  @Post('guests') @RequirePermission('data.import', ANY)
  async guests(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.svc.commitGuests(currentTenant().actorId!, needKey(key), parse(S.GuestImport, body)); reply.status(r.replayed ? 200 : 201); return r;
  }
  @Post('companies/preview') @RequirePermission('data.import', ANY) @HttpCode(200)
  previewCompanies(@Body() body: unknown) { return this.svc.previewCompanies(parse(S.CompanyImport, body)); }
  @Post('companies') @RequirePermission('data.import', ANY)
  async companies(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.svc.commitCompanies(currentTenant().actorId!, needKey(key), parse(S.CompanyImport, body)); reply.status(r.replayed ? 200 : 201); return r;
  }
}
