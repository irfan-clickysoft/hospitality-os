import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { MenuService } from './menu.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

@Controller('v1/properties/:propertyId')
export class MenuController {
  constructor(@Inject(MenuService) private readonly svc: MenuService) {}

  @Get('outlets') @RequirePermission('fnb.order', P)
  outlets(@Param('propertyId', uuid()) p: string) { return this.svc.outlets(p); }
  @Post('outlets') @RequirePermission('fnb.manage', P)
  addOutlet(@Param('propertyId', uuid()) p: string, @Body() b: unknown) { return this.svc.createOutlet(p, me(), parse(S.CreateOutlet, b)); }
  @Patch('outlets/:outletId') @RequirePermission('fnb.manage', P)
  editOutlet(@Param('propertyId', uuid()) p: string, @Param('outletId', uuid()) id: string, @Body() b: unknown) { return this.svc.updateOutlet(p, id, me(), parse(S.UpdateOutlet, b)); }
  @Get('outlets/:outletId/menu') @RequirePermission('fnb.order', P)
  tree(@Param('propertyId', uuid()) p: string, @Param('outletId', uuid()) id: string, @Query() q: unknown) { return this.svc.tree(p, id, parse(S.TreeQuery, q).all); }

  @Post('outlets/:outletId/menus') @RequirePermission('fnb.manage', P)
  addMenu(@Param('propertyId', uuid()) p: string, @Param('outletId', uuid()) o: string, @Body() b: unknown) { return this.svc.createMenu(p, o, me(), parse(S.CreateMenu, b)); }
  @Patch('menus/:menuId') @RequirePermission('fnb.manage', P)
  editMenu(@Param('propertyId', uuid()) p: string, @Param('menuId', uuid()) id: string, @Body() b: unknown) { return this.svc.updateMenu(p, id, me(), parse(S.UpdateMenu, b)); }

  @Post('menus/:menuId/categories') @RequirePermission('fnb.manage', P)
  addCategory(@Param('propertyId', uuid()) p: string, @Param('menuId', uuid()) m: string, @Body() b: unknown) { return this.svc.createCategory(p, m, me(), parse(S.CreateCategory, b)); }
  @Patch('categories/:categoryId') @RequirePermission('fnb.manage', P)
  editCategory(@Param('propertyId', uuid()) p: string, @Param('categoryId', uuid()) id: string, @Body() b: unknown) { return this.svc.updateCategory(p, id, me(), parse(S.UpdateCategory, b)); }
  @Delete('categories/:categoryId') @RequirePermission('fnb.manage', P) @HttpCode(200)
  dropCategory(@Param('propertyId', uuid()) p: string, @Param('categoryId', uuid()) id: string) { return this.svc.deleteCategory(p, id, me()); }

  @Post('menu-items') @RequirePermission('fnb.manage', P)
  addItem(@Param('propertyId', uuid()) p: string, @Body() b: unknown) { return this.svc.createItem(p, me(), parse(S.CreateItem, b)); }
  @Get('menu-items/:itemId') @RequirePermission('fnb.order', P)
  item(@Param('propertyId', uuid()) p: string, @Param('itemId', uuid()) id: string) { return this.svc.item(p, id); }
  @Patch('menu-items/:itemId') @RequirePermission('fnb.manage', P)
  editItem(@Param('propertyId', uuid()) p: string, @Param('itemId', uuid()) id: string, @Body() b: unknown) { return this.svc.updateItem(p, id, me(), parse(S.UpdateItem, b)); }

  @Post('menu-items/:itemId/variants') @RequirePermission('fnb.manage', P)
  addVariant(@Param('propertyId', uuid()) p: string, @Param('itemId', uuid()) i: string, @Body() b: unknown) { return this.svc.createVariant(p, i, me(), parse(S.CreateVariant, b)); }
  @Patch('menu-items/:itemId/variants/:variantId') @RequirePermission('fnb.manage', P)
  editVariant(@Param('propertyId', uuid()) p: string, @Param('itemId', uuid()) i: string, @Param('variantId', uuid()) id: string, @Body() b: unknown) { return this.svc.updateVariant(p, i, id, me(), parse(S.UpdateVariant, b)); }

  @Put('menu-items/:itemId/modifier-groups') @RequirePermission('fnb.manage', P)
  attach(@Param('propertyId', uuid()) p: string, @Param('itemId', uuid()) i: string, @Body() b: unknown) { return this.svc.attachGroups(p, i, me(), parse(S.AttachGroups, b).groupIds); }

  @Get('modifier-groups') @RequirePermission('fnb.order', P)
  groups(@Param('propertyId', uuid()) p: string) { return this.svc.groups(p); }
  @Post('modifier-groups') @RequirePermission('fnb.manage', P)
  addGroup(@Param('propertyId', uuid()) p: string, @Body() b: unknown) { return this.svc.createGroup(p, me(), parse(S.CreateGroup, b)); }
  @Patch('modifier-groups/:groupId') @RequirePermission('fnb.manage', P)
  editGroup(@Param('propertyId', uuid()) p: string, @Param('groupId', uuid()) id: string, @Body() b: unknown) { return this.svc.updateGroup(p, id, me(), parse(S.UpdateGroup, b)); }
  @Post('modifier-groups/:groupId/options') @RequirePermission('fnb.manage', P)
  addOption(@Param('propertyId', uuid()) p: string, @Param('groupId', uuid()) g: string, @Body() b: unknown) { return this.svc.createOption(p, g, me(), parse(S.CreateOption, b)); }
  @Patch('modifier-groups/:groupId/options/:optionId') @RequirePermission('fnb.manage', P)
  editOption(@Param('propertyId', uuid()) p: string, @Param('groupId', uuid()) g: string, @Param('optionId', uuid()) id: string, @Body() b: unknown) { return this.svc.updateOption(p, g, id, me(), parse(S.UpdateOption, b)); }

  @Post('menu-items/:itemId/media') @RequirePermission('fnb.manage', P)
  async addMedia(@Param('propertyId', uuid()) p: string, @Param('itemId', uuid()) i: string, @Req() req: FastifyRequest) {
    if (!req.isMultipart()) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Send the picture or video as a file upload' });
    const part = await req.file();
    if (!part) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'No file was sent' });
    return this.svc.addMedia(p, i, me(), await part.toBuffer());
  }
  @Patch('menu-items/:itemId/media/:mediaId') @RequirePermission('fnb.manage', P)
  editMedia(@Param('propertyId', uuid()) p: string, @Param('itemId', uuid()) i: string, @Param('mediaId', uuid()) id: string, @Body() b: unknown) { return this.svc.updateMedia(p, i, id, me(), parse(S.UpdateMedia, b)); }
  @Delete('menu-items/:itemId/media/:mediaId') @RequirePermission('fnb.manage', P) @HttpCode(204)
  async dropMedia(@Param('propertyId', uuid()) p: string, @Param('itemId', uuid()) i: string, @Param('mediaId', uuid()) id: string) { await this.svc.removeMedia(p, i, id, me()); }
}
