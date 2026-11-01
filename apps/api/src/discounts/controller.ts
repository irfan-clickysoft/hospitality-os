import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { DiscountApprovalsService } from './approvals.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

/** A discount above what the person at the desk may give goes to a manager: request it, the manager approves or rejects with a note, and the approval is used once on exactly that price. */
@Controller('v1/properties/:propertyId/discount-approvals')
export class DiscountApprovalsController {
  constructor(@Inject(DiscountApprovalsService) private readonly svc: DiscountApprovalsService) {}
  @Get() @RequirePermission('reservation.create', P) list(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.list(pid, me(), parse(S.ApprovalList, q)); }
  @Post() @RequirePermission('reservation.create', P) request(@Param('propertyId', uuid()) pid: string, @Body() b: unknown) { return this.svc.request(pid, me(), parse(S.ApprovalRequest, b)); }
  @Get(':id') @RequirePermission('reservation.create', P) get(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.get(pid, me(), id); }
  @Post(':id/approve') @RequirePermission('reservation.approve_discount', P) @HttpCode(200) approve(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.approve(pid, me(), id, parse(S.Decision, b ?? {}).note); }
  @Post(':id/reject') @RequirePermission('reservation.approve_discount', P) @HttpCode(200) reject(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.reject(pid, me(), id, parse(S.RejectDecision, b).note); }
  @Post(':id/withdraw') @RequirePermission('reservation.create', P) @HttpCode(200) withdraw(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.withdraw(pid, me(), id); }
}
