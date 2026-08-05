// SPDX-License-Identifier: AGPL-3.0-or-later
import { Global, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';

import { JwtStrategy } from './jwt.strategy.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { AuthSyncService } from './auth-sync.service.js';
import { ApiKeyService } from './api-key.service.js';
import { ApiKeysController } from './api-keys.controller.js';

/**
 * Global, for the same reason PrismaModule is: `JwtAuthGuard` is
 * applied all over the codebase as `@UseGuards(JwtAuthGuard)`, and
 * Nest instantiates a guard referenced by CLASS inside the module
 * context of the controller using it. Once the guard gained an
 * ApiKeyService dependency (#219), every one of those modules needed
 * that provider in scope, and the ones that did not have it failed
 * at boot rather than at compile time. (Prod outage, 2026-08-05: the
 * first module to trip was GeocodingModule.)
 *
 * Making auth global is the honest shape here. Authentication is
 * cross-cutting infrastructure, not a feature dependency, and the
 * alternative is importing AuthModule into a couple of dozen feature
 * modules and remembering to do it again for every future one.
 */
@Global()
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  controllers: [ApiKeysController],
  providers: [JwtStrategy, JwtAuthGuard, AuthSyncService, ApiKeyService],
  exports: [AuthSyncService, ApiKeyService],
})
export class AuthModule {}
