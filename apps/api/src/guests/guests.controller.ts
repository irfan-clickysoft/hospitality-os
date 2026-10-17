import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { GuestsService } from './guests.service.js';
import { CreateGuest, UpdateGuest } from './schemas.js';

/** Guest profiles are tenant-wide (one profile across the group's properties), so permissions apply at any scope. */
@Controller('v1/guests')
export class GuestsController {
  constructor(@Inject(GuestsService) private readonly svc: GuestsService) {}
  @Post() @RequirePermission('guest.manage', { anyScope: true })
  create(@Body() body: unknown) { return this.svc.create(parse(CreateGuest, body)); }
  @Get('search') @RequirePermission('guest.view', { anyScope: true })
  search(@Query('q') q = '') { return this.svc.search(q).then((items) => ({ items })); }
  @Get(':id') @RequirePermission('guest.view', { anyScope: true })
  get(@Param('id', new ParseUUIDPipe()) id: string) { return this.svc.get(id); }
  @Patch(':id') @RequirePermission('guest.manage', { anyScope: true })
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) { return this.svc.update(id, parse(UpdateGuest, body)); }
}
