import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { FnbService } from './fnb.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

@Controller('v1/properties/:propertyId/fnb')
export class FnbController {
  constructor(@Inject(FnbService) private readonly svc: FnbService) {}
  @Get('menu') @RequirePermission('fnb.order', P)
  menu(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.menu(pid, parse(S.MenuQuery, q).all); }
  @Post('menu') @RequirePermission('fnb.manage', P)
  addItem(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.createItem(pid, me(), parse(S.CreateItem, body)); }
  @Patch('menu/:itemId') @RequirePermission('fnb.manage', P)
  editItem(@Param('propertyId', uuid()) pid: string, @Param('itemId', uuid()) id: string, @Body() body: unknown) { return this.svc.updateItem(pid, id, me(), parse(S.UpdateItem, body)); }
  @Get('in-house') @RequirePermission('fnb.order', P)
  inHouse(@Param('propertyId', uuid()) pid: string) { return this.svc.inHouse(pid); }
  @Get('orders') @RequirePermission('fnb.order', P)
  queue(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.queue(pid, parse(S.QueueQuery, q)); }
  @Post('orders') @RequirePermission('fnb.order', P)
  create(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.create(pid, me(), parse(S.CreateOrder, body)); }
  @Get('reservations/:id/orders') @RequirePermission('folio.view', P)
  forReservation(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.forReservation(pid, id); }
  @Post('orders/:orderId/prepare') @RequirePermission('fnb.order', P) @HttpCode(200)
  prepare(@Param('propertyId', uuid()) pid: string, @Param('orderId', uuid()) id: string) { return this.svc.prepare(pid, id, me()); }
  @Post('orders/:orderId/ready') @RequirePermission('fnb.order', P) @HttpCode(200)
  ready(@Param('propertyId', uuid()) pid: string, @Param('orderId', uuid()) id: string) { return this.svc.ready(pid, id, me()); }
  @Post('orders/:orderId/deliver') @RequirePermission('fnb.order', P) @HttpCode(200)
  deliver(@Param('propertyId', uuid()) pid: string, @Param('orderId', uuid()) id: string) { return this.svc.deliver(pid, id, me()); }
  @Post('orders/:orderId/cancel') @RequirePermission('fnb.order', P) @HttpCode(200)
  cancel(@Param('propertyId', uuid()) pid: string, @Param('orderId', uuid()) id: string, @Body() body: unknown) { return this.svc.cancel(pid, id, me(), parse(S.Cancel, body).reason); }
}
