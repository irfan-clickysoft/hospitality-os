import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { RecipesService } from './recipes.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;
const All = z.object({ all: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') });

@Controller('v1/properties/:propertyId')
export class RecipesController {
  constructor(@Inject(RecipesService) private readonly svc: RecipesService) {}

  @Get('stock-items') @RequirePermission('fnb.manage', P)
  stock(@Param('propertyId', uuid()) p: string, @Query() q: unknown) { return this.svc.stock(p, parse(All, q).all); }
  @Post('stock-items') @RequirePermission('fnb.manage', P)
  addStock(@Param('propertyId', uuid()) p: string, @Body() b: unknown) { return this.svc.createStock(p, me(), parse(S.CreateStock, b)); }
  @Patch('stock-items/:itemId') @RequirePermission('fnb.manage', P)
  editStock(@Param('propertyId', uuid()) p: string, @Param('itemId', uuid()) id: string, @Body() b: unknown) { return this.svc.updateStock(p, id, me(), parse(S.UpdateStock, b)); }
  @Post('stock-items/:itemId/movements') @RequirePermission('fnb.manage', P) @HttpCode(200)
  move(@Param('propertyId', uuid()) p: string, @Param('itemId', uuid()) id: string, @Body() b: unknown) { return this.svc.move(p, id, me(), parse(S.Movement, b)); }
  @Get('stock-items/:itemId/movements') @RequirePermission('fnb.manage', P)
  movements(@Param('propertyId', uuid()) p: string, @Param('itemId', uuid()) id: string) { return this.svc.movements(p, id); }

  @Get('recipes') @RequirePermission('fnb.manage', P)
  list(@Param('propertyId', uuid()) p: string) { return this.svc.list(p); }
  @Post('recipes') @RequirePermission('fnb.manage', P)
  create(@Param('propertyId', uuid()) p: string, @Body() b: unknown) { return this.svc.create(p, me(), parse(S.CreateRecipe, b)); }
  @Get('recipes/:recipeId') @RequirePermission('fnb.manage', P)
  get(@Param('propertyId', uuid()) p: string, @Param('recipeId', uuid()) id: string, @Query() q: unknown) { return this.svc.get(p, id, parse(S.Period, q).versionId); }
  @Patch('recipes/:recipeId') @RequirePermission('fnb.manage', P)
  edit(@Param('propertyId', uuid()) p: string, @Param('recipeId', uuid()) id: string, @Body() b: unknown) { return this.svc.update(p, id, me(), parse(S.UpdateRecipe, b)); }
  @Post('recipes/:recipeId/versions') @RequirePermission('fnb.manage', P)
  newVersion(@Param('propertyId', uuid()) p: string, @Param('recipeId', uuid()) id: string) { return this.svc.newVersion(p, id, me()); }

  @Put('recipe-versions/:versionId') @RequirePermission('fnb.manage', P)
  save(@Param('propertyId', uuid()) p: string, @Param('versionId', uuid()) id: string, @Body() b: unknown) { return this.svc.save(p, id, me(), parse(S.VersionContent, b)); }
  @Post('recipe-versions/:versionId/approve') @RequirePermission('recipe.approve', P) @HttpCode(200)
  approve(@Param('propertyId', uuid()) p: string, @Param('versionId', uuid()) id: string) { return this.svc.approve(p, id, me()); }
  @Get('recipe-versions/:versionId/cost') @RequirePermission('fnb.manage', P)
  cost(@Param('propertyId', uuid()) p: string, @Param('versionId', uuid()) id: string) { return this.svc.cost(p, id); }
  @Post('recipe-versions/:versionId/video') @RequirePermission('fnb.manage', P)
  async video(@Param('propertyId', uuid()) p: string, @Param('versionId', uuid()) id: string, @Req() req: FastifyRequest) {
    if (!req.isMultipart()) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Send the video as a file upload' });
    const part = await req.file(); if (!part) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'No file was sent' });
    return this.svc.addVideo(p, id, me(), await part.toBuffer());
  }
  @Delete('recipe-versions/:versionId/video') @RequirePermission('fnb.manage', P) @HttpCode(204)
  async dropVideo(@Param('propertyId', uuid()) p: string, @Param('versionId', uuid()) id: string) { await this.svc.removeVideo(p, id, me()); }

  /** What a cook sees for a dish on an order: the approved recipe, no costs. */
  @Get('menu-items/:itemId/recipe-card') @RequirePermission('fnb.order', P)
  card(@Param('propertyId', uuid()) p: string, @Param('itemId', uuid()) id: string) { return this.svc.card(p, id); }
}
