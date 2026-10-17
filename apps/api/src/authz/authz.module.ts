import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthorizationService } from './authorization.service.js';
import { PermissionGuard } from './permission.guard.js';
import { NullPrincipalResolver, PRINCIPAL_RESOLVER } from '../tenancy/principal.js';

@Global()
@Module({
  providers: [
    AuthorizationService,
    { provide: PRINCIPAL_RESOLVER, useClass: NullPrincipalResolver },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [AuthorizationService, PRINCIPAL_RESOLVER],
})
export class AuthzModule {}
