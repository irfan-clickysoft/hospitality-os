import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Req, Res, StreamableFile, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import multipart from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Public, RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { MAX_VIDEO, MediaService } from './media.service.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const uuid = () => new ParseUUIDPipe();
const Patch_ = z.object({ caption: z.string().max(160).nullable().optional(), makeFirst: z.boolean().optional() }).strict();

@Controller('v1')
export class MediaController implements OnModuleInit {
  constructor(@Inject(MediaService) private readonly svc: MediaService, @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost) {}

  /** Teaches the web server to accept file uploads (before it starts listening). */
  async onModuleInit() {
    const app = this.host.httpAdapter.getInstance();
    if (!app.hasContentTypeParser('multipart/form-data')) await app.register(multipart, { limits: { fileSize: MAX_VIDEO + 1, files: 1, fields: 4 } });
  }

  @Get('properties/:propertyId/room-types/:roomTypeId/media') @RequirePermission('property.view', P)
  list(@Param('propertyId', uuid()) p: string, @Param('roomTypeId', uuid()) rt: string) { return this.svc.list(p, rt); }

  @Post('properties/:propertyId/room-types/:roomTypeId/media') @RequirePermission('property.manage', P)
  async add(@Param('propertyId', uuid()) p: string, @Param('roomTypeId', uuid()) rt: string, @Req() req: FastifyRequest) {
    if (!req.isMultipart()) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Send the picture or video as a file upload' });
    const part = await req.file();
    if (!part) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'No file was sent' });
    return this.svc.add(p, rt, await part.toBuffer(), null);
  }

  @Patch('properties/:propertyId/room-types/:roomTypeId/media/:mediaId') @RequirePermission('property.manage', P)
  edit(@Param('propertyId', uuid()) p: string, @Param('roomTypeId', uuid()) rt: string, @Param('mediaId', uuid()) id: string, @Body() body: unknown) { return this.svc.update(p, rt, id, parse(Patch_, body)); }

  @Delete('properties/:propertyId/room-types/:roomTypeId/media/:mediaId') @RequirePermission('property.manage', P) @HttpCode(204)
  async remove(@Param('propertyId', uuid()) p: string, @Param('roomTypeId', uuid()) rt: string, @Param('mediaId', uuid()) id: string) { await this.svc.remove(p, rt, id); }

  /** The file itself. Public on purpose: it is what the guest's email points at. The name is unguessable and nothing here lists or searches. */
  @Public() @Get('media/:tenantId/:file')
  async file(@Param('tenantId') tenantId: string, @Param('file') file: string, @Headers('range') range: string | undefined, @Res({ passthrough: true }) reply: FastifyReply) {
    const f = await this.svc.open(tenantId, file);
    reply.header('Content-Type', f.type).header('Accept-Ranges', 'bytes').header('Cache-Control', 'public, max-age=86400').header('X-Content-Type-Options', 'nosniff');
    const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, f.size - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), f.size - 1) : f.size - 1;
      if (start > end || start >= f.size) { reply.status(416).header('Content-Range', `bytes */${f.size}`); return; }
      reply.status(206).header('Content-Range', `bytes ${start}-${end}/${f.size}`).header('Content-Length', end - start + 1);
      return new StreamableFile(f.stream({ start, end }));
    }
    reply.header('Content-Length', f.size);
    return new StreamableFile(f.stream());
  }
}
