import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { RatesService } from './rates.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();

@Controller('v1/properties/:propertyId')
export class RatesController {
  constructor(@Inject(RatesService) private readonly svc: RatesService) {}

  @Get('rate-plans') @RequirePermission('reservation.view', P)
  plans(@Param('propertyId', uuid()) id: string) { return this.svc.listPlans(id).then((items) => ({ items })); }
  @Post('rate-plans') @RequirePermission('rate.manage', P)
  addPlan(@Param('propertyId', uuid()) id: string, @Body() body: unknown) { return this.svc.createPlan(id, parse(S.CreatePlan, body)); }
  @Get('rate-plans/:planId') @RequirePermission('reservation.view', P)
  plan(@Param('propertyId', uuid()) id: string, @Param('planId', uuid()) plan: string) { return this.svc.getPlan(id, plan); }
  @Patch('rate-plans/:planId') @RequirePermission('rate.manage', P)
  editPlan(@Param('propertyId', uuid()) id: string, @Param('planId', uuid()) plan: string, @Body() body: unknown) { return this.svc.updatePlan(id, plan, parse(S.UpdatePlan, body)); }

  @Put('rate-plans/:planId/base-rates') @RequirePermission('rate.manage', P)
  base(@Param('propertyId', uuid()) id: string, @Param('planId', uuid()) plan: string, @Body() body: unknown) { return this.svc.setBaseRates(id, plan, parse(S.SetBaseRates, body)); }
  @Post('rate-plans/:planId/seasons') @RequirePermission('rate.manage', P)
  season(@Param('propertyId', uuid()) id: string, @Param('planId', uuid()) plan: string, @Body() body: unknown) { return this.svc.createSeason(id, plan, parse(S.CreateSeason, body)); }
  @Delete('rate-plans/:planId/seasons/:seasonId') @RequirePermission('rate.manage', P) @HttpCode(204)
  rmSeason(@Param('propertyId', uuid()) id: string, @Param('planId', uuid()) plan: string, @Param('seasonId', uuid()) s: string) { return this.svc.deleteSeason(id, plan, s); }
  @Post('rate-plans/:planId/overrides') @RequirePermission('rate.manage', P) @HttpCode(200)
  overrides(@Param('propertyId', uuid()) id: string, @Param('planId', uuid()) plan: string, @Body() body: unknown) { return this.svc.setOverrides(id, plan, parse(S.SetOverrides, body)); }
  @Post('rate-plans/:planId/restrictions') @RequirePermission('rate.manage', P)
  restriction(@Param('propertyId', uuid()) id: string, @Param('planId', uuid()) plan: string, @Body() body: unknown) { return this.svc.createRestriction(id, plan, parse(S.CreateRestriction, body)); }
  @Delete('rate-plans/:planId/restrictions/:restrictionId') @RequirePermission('rate.manage', P) @HttpCode(204)
  rmRestriction(@Param('propertyId', uuid()) id: string, @Param('planId', uuid()) plan: string, @Param('restrictionId', uuid()) r: string) { return this.svc.deleteRestriction(id, plan, r); }

  @Get('rate-calendar') @RequirePermission('reservation.view', P)
  calendar(@Param('propertyId', uuid()) id: string, @Query() q: unknown) { const { planId, from, to } = parse(S.CalendarQuery, q); return this.svc.calendar(id, planId, from, to); }

  /** Availability + prices for a stay: every sellable room-type × rate-plan option, with a signed quote token for the bookable ones. */
  @Post('quotes') @RequirePermission('reservation.create', P) @HttpCode(200)
  quote(@Param('propertyId', uuid()) id: string, @Body() body: unknown) { return this.svc.quote(id, currentTenant().actorId!, parse(S.QuoteRequest, body)); }
}
