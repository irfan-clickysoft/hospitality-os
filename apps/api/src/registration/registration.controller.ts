import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { RequirePermission } from '../authz/decorators.js';
import { TenantDb } from '../db/tenant-db.js';
import { FOREIGN_DETAIL_KEYS, GUEST_TYPES, MINORS, NEEDS_FOREIGN_DETAILS, requirementsFor, suggestGuestType, type GuestType } from './rules.js';

const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };

/** The document matrix as this property applies it, for the check-in screens to show (they never keep a copy of the rules). */
@Controller('v1/properties/:propertyId/registration')
export class RegistrationController {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb) {}

  @Get('requirements') @RequirePermission('reservation.view', P)
  async requirements(@Param('propertyId', new ParseUUIDPipe()) pid: string) {
    const p = await this.tdb.tx((trx) => trx.selectFrom('property').select(['registration_strict', 'nicop_alone_ok']).where('id', '=', pid).executeTakeFirst());
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return {
      strict: p.registration_strict, nicopAloneOk: p.nicop_alone_ok, foreignDetailKeys: FOREIGN_DETAIL_KEYS,
      types: GUEST_TYPES.map((type: GuestType) => ({ type, minor: MINORS.includes(type), foreignDetails: NEEDS_FOREIGN_DETAILS.includes(type), requirements: requirementsFor(type, { nicopAloneOk: p.nicop_alone_ok }), requirementsCorporate: requirementsFor(type, { nicopAloneOk: p.nicop_alone_ok, corporate: true }) })),
      suggest: Object.fromEntries((['PK', 'XX'] as const).flatMap((n) => (['ADULT', 'CHILD'] as const).map((a) => [`${n}:${a}`, suggestGuestType({ nationality: n, ageGroup: a })]))),
    };
  }
}
