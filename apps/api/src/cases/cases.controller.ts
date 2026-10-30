import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { CaseService } from './case.service.js';
import { DamageService } from './damage.service.js';
import * as S from './schemas.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const me = () => currentTenant().actorId!;
const upload = async (req: FastifyRequest) => {
  if (!req.isMultipart()) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Send the picture as a file upload' });
  const part = await req.file(); if (!part) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'No picture was sent' });
  return part.toBuffer();
};
const send = (reply: FastifyReply, f: { type: string; data: Buffer }) => { reply.header('Content-Type', f.type).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff'); return new StreamableFile(f.data); };
const Reopen = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

/** Damage to rooms and property, tied to the guest and (when charged) to the guest's bill. Evidence is private to those who may see the case. */
@Controller('v1/properties/:propertyId/damage')
export class DamageController {
  constructor(@Inject(DamageService) private readonly svc: DamageService) {}
  @Get() @RequirePermission('damage.view', P) list(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.list(pid, parse(S.DamageList, q)); }
  @Post() @RequirePermission('damage.report', P) create(@Param('propertyId', uuid()) pid: string, @Body() b: unknown) { return this.svc.create(pid, me(), parse(S.DamageCreate, b)); }
  @Get(':id') @RequirePermission('damage.view', P) get(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.get(pid, id, me()); }
  @Patch(':id') @RequirePermission('damage.manage', P) update(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.update(pid, id, me(), parse(S.DamageUpdate, b)); }
  @Post(':id/note') @RequirePermission('damage.report', P) @HttpCode(200) note(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.addNote(pid, id, me(), parse(S.Note, b)); }
  @Post(':id/verify') @RequirePermission('damage.manage', P) @HttpCode(200) verify(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.verify(pid, id, me(), parse(S.Verify, b ?? {})); }
  @Post(':id/dismiss') @RequirePermission('damage.manage', P) @HttpCode(200) dismiss(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.dismiss(pid, id, me(), parse(S.Reason, b)); }
  @Post(':id/notify-guest') @RequirePermission('damage.manage', P) @HttpCode(200) notify(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.notifyGuest(pid, id, me()); }
  @Post(':id/guest-response') @RequirePermission('damage.manage', P) @HttpCode(200) response(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.guestResponse(pid, id, me(), parse(S.GuestResponse, b)); }
  @Post(':id/approve-charge') @RequirePermission('damage.charge', P) @HttpCode(200) approve(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.approveCharge(pid, id, me(), parse(S.ApproveCharge, b)); }
  @Post(':id/charge') @RequirePermission('damage.charge', P) @HttpCode(200) charge(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.charge(pid, id, me()); }
  @Post(':id/waive') @RequirePermission('damage.charge', P) @HttpCode(200) waive(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.waive(pid, id, me(), parse(S.Waive, b)); }
  @Post(':id/resolve') @RequirePermission('damage.manage', P) @HttpCode(200) resolve(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.resolve(pid, id, me(), parse(S.Resolve, b)); }
  @Post(':id/photos') @RequirePermission('damage.report', P) async addPhoto(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Req() req: FastifyRequest) { return this.svc.addPhoto(pid, id, me(), await upload(req)); }
  @Get(':id/photos/:photoId') @RequirePermission('damage.view', P) async photo(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('photoId', uuid()) photoId: string, @Res({ passthrough: true }) reply: FastifyReply) { return send(reply, await this.svc.photoFile(pid, id, photoId)); }
}

/** Guest complaints, service failures and incidents. Safety, security and medical cases (and any marked confidential) are invisible without the restricted permission. */
@Controller('v1/properties/:propertyId/cases')
export class CasesController {
  constructor(@Inject(CaseService) private readonly svc: CaseService) {}
  @Get() @RequirePermission('case.view', P) list(@Param('propertyId', uuid()) pid: string, @Query() q: unknown) { return this.svc.list(pid, me(), parse(S.CaseList, q)); }
  @Get('people') @RequirePermission('case.manage', P) people() { return this.svc.people(); }
  @Post() @RequirePermission('case.report', P) create(@Param('propertyId', uuid()) pid: string, @Body() b: unknown) { return this.svc.create(pid, me(), parse(S.CaseCreate, b)); }
  @Get(':id') @RequirePermission('case.view', P) get(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.get(pid, id, me()); }
  @Patch(':id') @RequirePermission('case.manage', P) update(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.update(pid, id, me(), parse(S.CaseUpdate, b)); }
  @Post(':id/note') @RequirePermission('case.report', P) @HttpCode(200) note(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.addNote(pid, id, me(), parse(S.Note, b).note); }
  @Post(':id/resolve') @RequirePermission('case.manage', P) @HttpCode(200) resolve(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.resolve(pid, id, me(), parse(S.Resolve, b).note); }
  @Post(':id/close') @RequirePermission('case.manage', P) @HttpCode(200) close(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string) { return this.svc.close(pid, id, me()); }
  @Post(':id/reopen') @RequirePermission('case.manage', P) @HttpCode(200) reopen(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Body() b: unknown) { return this.svc.reopen(pid, id, me(), parse(Reopen, b).reason); }
  @Post(':id/photos') @RequirePermission('case.report', P) async addPhoto(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Req() req: FastifyRequest) { return this.svc.addPhoto(pid, id, me(), await upload(req)); }
  @Get(':id/photos/:photoId') @RequirePermission('case.view', P) async photo(@Param('propertyId', uuid()) pid: string, @Param('id', uuid()) id: string, @Param('photoId', uuid()) photoId: string, @Res({ passthrough: true }) reply: FastifyReply) { return send(reply, await this.svc.photoFile(pid, id, photoId, me())); }
}
