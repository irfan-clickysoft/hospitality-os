import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { LostFoundService } from './lost-found.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;

/** Anyone in housekeeping can log what they find; handing it back or disposing of it needs the manager-level right. */
@Controller('v1/properties/:propertyId/lost-found')
export class LostFoundController {
  constructor(@Inject(LostFoundService) private readonly svc: LostFoundService) {}
  @Get() @RequirePermission('housekeeping.view', P)
  list(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.list(pid, parse(S.ListQuery, q)); }
  @Post() @RequirePermission('housekeeping.update', P)
  create(@Param('propertyId', uuid()) pid: string, @Body() body: unknown) { return this.svc.create(pid, me(), parse(S.Create, body)); }
  @Get('suggest-owner') @RequirePermission('housekeeping.view', P)
  suggest(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.suggest(pid, parse(S.SuggestQuery, q)); }
  @Get(':id') @RequirePermission('housekeeping.view', P)
  get(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.get(pid, id); }
  @Patch(':id') @RequirePermission('housekeeping.update', P)
  update(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.update(pid, id, me(), parse(S.Update, body)); }
  @Post(':id/contact') @RequirePermission('housekeeping.update', P) @HttpCode(200)
  contact(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.contact(pid, id, me(), parse(S.Contact, body ?? {})); }
  @Post(':id/return') @RequirePermission('housekeeping.update', P) @HttpCode(200)
  handBack(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.handBack(pid, id, me(), parse(S.Return, body)); }
  @Post(':id/dispose') @RequirePermission('housekeeping.update', P) @HttpCode(200)
  dispose(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.dispose(pid, id, me(), parse(S.Dispose, body)); }
  @Post(':id/reopen') @RequirePermission('housekeeping.update', P) @HttpCode(200)
  reopen(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.reopen(pid, id, me(), parse(S.Reopen, body)); }
  @Post(':id/notes') @RequirePermission('housekeeping.update', P) @HttpCode(200)
  note(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() body: unknown) { return this.svc.addNote(pid, id, me(), parse(S.AddNote, body)); }
  @Post(':id/message') @RequirePermission('housekeeping.view', P) @HttpCode(200)
  message(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.message(pid, id, me()); }

  @Post(':id/photos') @RequirePermission('housekeeping.update', P)
  async addPhoto(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Query('phase') phase: string | undefined, @Req() req: FastifyRequest) {
    if (!req.isMultipart()) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Send the picture as a file upload' });
    const part = await req.file();
    if (!part) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'No picture was sent' });
    return this.svc.addPhoto(pid, id, me(), await part.toBuffer(), phase === 'HANDOVER' ? 'HANDOVER' : 'FOUND');
  }
  @Get(':id/photos/:photoId') @RequirePermission('housekeeping.view', P)
  async photo(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('photoId', uuid()) photoId: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const f = await this.svc.photoFile(pid, id, photoId);
    reply.header('Content-Type', f.type).header('Cache-Control', 'private, max-age=300').header('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(f.data);
  }
  @Delete(':id/photos/:photoId') @RequirePermission('housekeeping.update', P) @HttpCode(204)
  async removePhoto(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('photoId', uuid()) photoId: string) { await this.svc.removePhoto(pid, id, me(), photoId); }
}
