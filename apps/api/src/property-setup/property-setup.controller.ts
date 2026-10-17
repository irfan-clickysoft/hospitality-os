import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Authenticated, RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { PropertySetupService } from './property-setup.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();

@Controller('v1')
export class PropertySetupController {
  constructor(@Inject(PropertySetupService) private readonly svc: PropertySetupService) {}

  // properties
  @Get('properties') @Authenticated()
  list() { return this.svc.listProperties(currentTenant().actorId!).then((items) => ({ items })); }

  /** Tenant-wide permission: property-scoped managers cannot create new properties. */
  @Post('properties') @RequirePermission('property.manage')
  create(@Body() body: unknown) { return this.svc.createProperty(parse(S.CreateProperty, body)); }

  @Get('properties/:propertyId') @RequirePermission('property.view', P)
  get(@Param('propertyId', uuid()) id: string) { return this.svc.setupStatus(id).then((s) => s.property); }

  @Patch('properties/:propertyId') @RequirePermission('property.manage', P)
  update(@Param('propertyId', uuid()) id: string, @Body() body: unknown) { return this.svc.updateProperty(id, parse(S.UpdateProperty, body)); }

  @Get('properties/:propertyId/setup-status') @RequirePermission('property.view', P)
  status(@Param('propertyId', uuid()) id: string) { return this.svc.setupStatus(id); }

  @Post('properties/:propertyId/go-live') @RequirePermission('property.manage', P) @HttpCode(200)
  goLive(@Param('propertyId', uuid()) id: string, @Body() body: unknown) { return this.svc.goLive(id, parse(S.GoLive, body ?? {})); }

  // structure
  @Get('properties/:propertyId/structure') @RequirePermission('property.view', P)
  structure(@Param('propertyId', uuid()) id: string) { return this.svc.structure(id); }
  @Post('properties/:propertyId/buildings') @RequirePermission('property.manage', P)
  building(@Param('propertyId', uuid()) id: string, @Body() body: unknown) { return this.svc.createBuilding(id, parse(S.CreateBuilding, body)); }
  @Post('properties/:propertyId/floors') @RequirePermission('property.manage', P)
  floor(@Param('propertyId', uuid()) id: string, @Body() body: unknown) { return this.svc.createFloor(id, parse(S.CreateFloor, body)); }

  // room types
  @Get('properties/:propertyId/room-types') @RequirePermission('property.view', P)
  roomTypes(@Param('propertyId', uuid()) id: string) { return this.svc.listRoomTypes(id).then((items) => ({ items })); }
  @Post('properties/:propertyId/room-types') @RequirePermission('property.manage', P)
  addRoomType(@Param('propertyId', uuid()) id: string, @Body() body: unknown) { return this.svc.createRoomType(id, parse(S.CreateRoomType, body)); }
  @Patch('properties/:propertyId/room-types/:roomTypeId') @RequirePermission('property.manage', P)
  editRoomType(@Param('propertyId', uuid()) id: string, @Param('roomTypeId', uuid()) rt: string, @Body() body: unknown) { return this.svc.updateRoomType(id, rt, parse(S.UpdateRoomType, body)); }
  @Put('properties/:propertyId/room-types/:roomTypeId/amenities') @RequirePermission('property.manage', P)
  roomTypeAmenities(@Param('propertyId', uuid()) id: string, @Param('roomTypeId', uuid()) rt: string, @Body() body: unknown) { return this.svc.setRoomTypeAmenities(id, rt, parse(S.SetAmenities, body).amenityIds); }
  @Put('properties/:propertyId/room-types/:roomTypeId/overbook') @RequirePermission('inventory.overbook', P)
  overbook(@Param('propertyId', uuid()) id: string, @Param('roomTypeId', uuid()) rt: string, @Body() body: unknown) { return this.svc.setOverbook(id, rt, parse(S.SetOverbook, body)); }

  // amenities (tenant catalogue)
  @Get('amenities') @Authenticated()
  amenities() { return this.svc.listAmenities().then((items) => ({ items })); }
  @Post('amenities') @RequirePermission('property.manage')
  addAmenity(@Body() body: unknown) { return this.svc.createAmenity(parse(S.CreateAmenity, body)); }

  // rooms
  @Get('properties/:propertyId/rooms') @RequirePermission('property.view', P)
  rooms(@Param('propertyId', uuid()) id: string, @Query('roomTypeId') roomTypeId?: string, @Query('floorId') floorId?: string, @Query('status') status?: string) {
    return this.svc.listRooms(id, { roomTypeId, floorId, status }).then((items) => ({ items }));
  }
  @Post('properties/:propertyId/rooms') @RequirePermission('property.manage', P)
  addRoom(@Param('propertyId', uuid()) id: string, @Body() body: unknown) { return this.svc.createRoom(id, parse(S.CreateRoom, body)); }
  @Post('properties/:propertyId/rooms/bulk') @RequirePermission('property.manage', P)
  bulk(@Param('propertyId', uuid()) id: string, @Body() body: unknown) { return this.svc.bulkRooms(id, parse(S.BulkRooms, body)); }
  @Patch('properties/:propertyId/rooms/:roomId') @RequirePermission('property.manage', P)
  editRoom(@Param('propertyId', uuid()) id: string, @Param('roomId', uuid()) room: string, @Body() body: unknown) { return this.svc.updateRoom(id, room, parse(S.UpdateRoom, body)); }

  // blocks (out of order / out of service)
  @Get('properties/:propertyId/room-blocks') @RequirePermission('property.view', P)
  blocks(@Param('propertyId', uuid()) id: string, @Query('includeCancelled') inc?: string) { return this.svc.listBlocks(id, inc === 'true').then((items) => ({ items })); }
  @Post('properties/:propertyId/room-blocks') @RequirePermission('inventory.block', P)
  addBlock(@Param('propertyId', uuid()) id: string, @Body() body: unknown) { return this.svc.createBlock(id, currentTenant().actorId!, parse(S.CreateBlock, body)); }
  @Post('properties/:propertyId/room-blocks/:blockId/end') @RequirePermission('inventory.block', P) @HttpCode(200)
  end(@Param('propertyId', uuid()) id: string, @Param('blockId', uuid()) b: string, @Body() body: unknown) { return this.svc.endBlock(id, b, parse(S.EndBlock, body).endDate); }
  @Delete('properties/:propertyId/room-blocks/:blockId') @RequirePermission('inventory.block', P)
  cancel(@Param('propertyId', uuid()) id: string, @Param('blockId', uuid()) b: string) { return this.svc.endBlock(id, b, null); }

  // availability
  @Get('properties/:propertyId/availability') @RequirePermission('property.view', P)
  availability(@Param('propertyId', uuid()) id: string, @Query() q: unknown) { const { from, to } = parse(S.AvailabilityQuery, q); return this.svc.availability(id, from, to); }
  @Get('properties/:propertyId/inventory-check') @RequirePermission('property.manage', P)
  check(@Param('propertyId', uuid()) id: string) { return this.svc.invariants(id); }
}
