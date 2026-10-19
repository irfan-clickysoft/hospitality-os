import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import * as S from './schemas.js';
import { TaxService } from './tax.service.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

@Controller('v1')
export class TaxController {
  constructor(@Inject(TaxService) private readonly svc: TaxService) {}

  // ── configuration: one person enters, another approves ──
  @Get('tax/codes') @RequirePermission('report.view', { anyScope: true })
  codes() { return this.svc.listCodes(); }
  @Post('tax/codes') @RequirePermission('tax.configure')
  create(@Body() body: unknown) { return this.svc.createCode(me(), parse(S.CreateCode, body)); }
  @Post('tax/codes/:id/versions') @RequirePermission('tax.configure')
  addVersion(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.addVersion(me(), id, parse(S.VersionBody, body)); }
  @Patch('tax/versions/:id') @RequirePermission('tax.configure')
  edit(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.updateDraft(me(), id, parse(S.VersionBody, body)); }
  @Post('tax/versions/:id/approve') @RequirePermission('tax.approve') @HttpCode(200)
  approve(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.approve(me(), id, parse(S.Approve, body)); }
  @Post('tax/versions/:id/reject') @RequirePermission('tax.approve') @HttpCode(200)
  reject(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.reject(me(), id, parse(S.Decision, body).reason); }
  @Post('tax/versions/:id/retire') @RequirePermission('tax.approve') @HttpCode(200)
  retire(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.retire(me(), id, parse(S.Decision, body).reason); }
  @Put('properties/:propertyId/tax-jurisdiction') @RequirePermission('tax.configure')
  jurisdiction(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.setPropertyJurisdiction(pid, parse(S.SetJurisdiction, body).jurisdiction); }

  // ── use ──
  @Post('properties/:propertyId/tax/preview') @RequirePermission('reservation.view', P) @HttpCode(200)
  preview(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.preview(pid, parse(S.Preview, body)); }
  @Get('properties/:propertyId/tax/liability') @RequirePermission('report.view', P)
  liability(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { const x = parse(S.LiabilityQuery, q); return this.svc.liability(pid, x.from, x.to); }

  // ── the legal entity invoices are issued by ──
  @Get('legal-entities') @RequirePermission('tenant.manage')
  entities() { return this.svc.legalEntities(); }
  @Put('legal-entities/:id') @RequirePermission('tenant.manage')
  updateEntity(@Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.updateLegalEntity(id, parse(S.UpdateLegalEntity, body)); }
}
