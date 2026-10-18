import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { SpacesService } from './spaces.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

@Controller('v1/properties/:propertyId/spaces')
export class SpacesController {
  constructor(@Inject(SpacesService) private readonly svc: SpacesService) {}
  @Get() @RequirePermission('space.view', P)
  list(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.list(pid, parse(S.SpacesQuery, q).all); }
  @Post() @RequirePermission('space.manage', P)
  create(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.create(pid, me(), parse(S.CreateSpace, body)); }
  @Get('bookings') @RequirePermission('space.view', P)
  calendar(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.calendar(pid, parse(S.CalendarQuery, q)); }
  @Post('bookings') @RequirePermission('space.book', P)
  book(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.book(pid, me(), parse(S.CreateBooking, body)); }
  @Get('stays') @RequirePermission('space.book', P)
  stays(@Param('propertyId', uuid()) pid: string) { return this.svc.stays(pid); }
  @Post('bookings/:bookingId/complete') @RequirePermission('space.book', P) @HttpCode(200)
  complete(@Param('propertyId', uuid()) pid: string, @Param('bookingId', uuid()) id: string) { return this.svc.complete(pid, id, me()); }
  @Post('bookings/:bookingId/cancel') @RequirePermission('space.book', P) @HttpCode(200)
  cancel(@Param('propertyId', uuid()) pid: string, @Param('bookingId', uuid()) id: string, @Body() body: unknown) { return this.svc.cancel(pid, id, me(), parse(S.Cancel, body).reason); }
  @Patch(':spaceId') @RequirePermission('space.manage', P)
  update(@Param('propertyId', uuid()) pid: string, @Param('spaceId', uuid()) id: string, @Body() body: unknown) { return this.svc.update(pid, id, me(), parse(S.UpdateSpace, body)); }
}
