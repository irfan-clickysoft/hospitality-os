import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { IdentityService } from './identity.service.js';
import { PasswordService } from './password.service.js';
import { RateLimiter } from './rate-limiter.js';
import { SessionPrincipalResolver } from './session.principal-resolver.js';
import { SessionService } from './session.service.js';
import { TotpService } from './totp.service.js';

@Global()
@Module({
  controllers: [AuthController],
  providers: [SessionService, PasswordService, TotpService, IdentityService, RateLimiter, SessionPrincipalResolver],
  exports: [SessionService, PasswordService, TotpService, IdentityService, SessionPrincipalResolver],
})
export class IdentityModule {}
