import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { z } from 'zod';
import { GateService, LogVisit } from './gate.service.js';

const Register = z.object({ nationality: z.string().regex(/^[A-Za-z]{2}$/).transform((v) => v.toUpperCase()).nullish(), allowDuplicate: z.boolean().default(false) });

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();

@Controller('v1/properties/:propertyId/gate')
export class GateController {
  constructor(@Inject(GateService) private readonly svc: GateService) {}
  /** Today's expected arrivals with the guest's name shortened and nothing else about them. */
  @Get('arrivals') @RequirePermission('arrivals.view_masked', P)
  arrivals(@Param('propertyId', uuid()) pid: string) { return this.svc.arrivals(pid); }
  @Get('visits') @RequirePermission('visitor.log', P)
  visits(@Param('propertyId', uuid()) pid: string) { return this.svc.list(pid); }
  @Post('visits') @RequirePermission('visitor.log', P) @HttpCode(201)
  log(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.log(pid, currentTenant().actorId!, parse(LogVisit, body)); }
  @Post('visits/:visitId/out') @RequirePermission('visitor.log', P) @HttpCode(200)
  out(@Param('propertyId', uuid()) pid: string, @Param('visitId', uuid()) id: string) { return this.svc.out(pid, id, currentTenant().actorId!); }
  /** Staying the night: the visitor becomes a registered guest. Needs the permission to manage guests, which the gate itself does not have. */
  @Post('visits/:visitId/register') @RequirePermission('guest.manage', { anyScope: true }) @HttpCode(201)
  register(@Param('propertyId', uuid()) pid: string, @Param('visitId', uuid()) id: string, @Body() body: unknown) { const x = parse(Register, body ?? {}); return this.svc.register(pid, id, currentTenant().actorId!, x.nationality ?? null, x.allowDuplicate); }
}
