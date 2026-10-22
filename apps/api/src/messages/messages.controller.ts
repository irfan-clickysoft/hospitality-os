import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { MessagesService } from './messages.service.js';
import * as S from './schemas.js';
import { CHANNELS, EVENTS, type Channel, type MessageEvent } from './templates.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const ev = (v: string): MessageEvent => { if (!(EVENTS as readonly string[]).includes(v)) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Unknown message' }); return v as MessageEvent; };
const ch = (v: string): Channel => { if (!(CHANNELS as readonly string[]).includes(v)) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Unknown channel' }); return v as Channel; };

@Controller('v1')
export class MessagesController {
  constructor(@Inject(MessagesService) private readonly svc: MessagesService) {}

  /** The owner / super admin edits the wording. */
  @Get('message-templates') @RequirePermission('tenant.manage')
  list() { return this.svc.list(); }
  @Put('message-templates/:event/:channel') @RequirePermission('tenant.manage')
  save(@Param('event') e: string, @Param('channel') c: string, @Body() body: unknown) { return this.svc.save(ev(e), ch(c), parse(S.SaveTemplate, body)); }
  @Delete('message-templates/:event/:channel') @RequirePermission('tenant.manage') @HttpCode(204)
  async reset(@Param('event') e: string, @Param('channel') c: string) { await this.svc.reset(ev(e), ch(c)); }

  /** Staff get a message ready to send for a booking. */
  @Post('properties/:propertyId/messages/compose') @RequirePermission('reservation.view', P) @HttpCode(200)
  compose(@Param('propertyId', new ParseUUIDPipe()) p: string, @Body() body: unknown) { return this.svc.compose(p, parse(S.Compose, body)); }

  /** Tells a technician or contractor about a job. */
  @Post('properties/:propertyId/work-orders/:workOrderId/message') @RequirePermission('maintenance.view', P) @HttpCode(200)
  workOrder(@Param('propertyId', new ParseUUIDPipe()) p: string, @Param('workOrderId', new ParseUUIDPipe()) w: string) { return this.svc.composeWorkOrder(p, w); }

  /** Sends a company its statement with a private link. */
  @Post('properties/:propertyId/companies/:companyId/message') @RequirePermission('company.view', P) @HttpCode(200)
  company(@Param('propertyId', new ParseUUIDPipe()) p: string, @Param('companyId', new ParseUUIDPipe()) c: string, @Query('channel') channel?: string, @Headers('origin') origin?: string) { return this.svc.composeCompany(p, c, origin, channel ? ch(channel) : 'WHATSAPP'); }
}
