// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { AdminGuard } from '../admin/admin.guard.js';
import { ItemsModule } from '../items/items.module.js';
import { AiAdminController } from './ai-admin.controller.js';
import { AiConfigService } from './ai-config.service.js';
import { AiController } from './ai.controller.js';
import { AiBuildService } from './ai-build.service.js';
import { AiDraftService } from './ai-draft.service.js';
import { AiProviderClient } from './ai-provider.client.js';

/**
 * Opt-in model calls. AdminGuard is provided here because a guard
 * referenced by class is constructed in this module's context.
 * It has no dependencies; listing it keeps that explicit.
 */
@Module({
  imports: [ItemsModule],
  controllers: [AiController, AiAdminController],
  providers: [
    AdminGuard,
    AiConfigService,
    AiDraftService,
    AiBuildService,
    AiProviderClient,
  ],
})
export class LlmModule {}
