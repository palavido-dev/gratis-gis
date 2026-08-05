// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';

import { JwtStrategy } from './jwt.strategy.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { AuthSyncService } from './auth-sync.service.js';
import { ApiKeyService } from './api-key.service.js';
import { ApiKeysController } from './api-keys.controller.js';

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  controllers: [ApiKeysController],
  // ApiKeyService is exported because the globally-registered
  // JwtAuthGuard resolves keys through it (#219).
  providers: [JwtStrategy, JwtAuthGuard, AuthSyncService, ApiKeyService],
  exports: [AuthSyncService, ApiKeyService],
})
export class AuthModule {}
