// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { AdminGuard } from '../admin/admin.guard.js';
import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { ItemsModule } from '../items/items.module.js';
import { AiAdminController } from './ai-admin.controller.js';
import { AiBootstrapService } from './ai-bootstrap.service.js';
import { AiConfigService } from './ai-config.service.js';
import { AiController } from './ai.controller.js';
import { AiBuildService } from './ai-build.service.js';
import { AiDraftService } from './ai-draft.service.js';
import { AiFeaturesService } from './ai-features.service.js';
import { AiProviderClient } from './ai-provider.client.js';
import { AiQuotaService } from './ai-quota.service.js';

/**
 * Opt-in model calls. AdminGuard is provided here because a guard
 * referenced by class is constructed in this module's context.
 * It has no dependencies; listing it keeps that explicit.
 */
@Module({
  imports: [ItemsModule, DataLayerFeaturesModule],
  controllers: [AiController, AiAdminController],
  providers: [
    AdminGuard,
    AiConfigService,
    AiQuotaService,
    AiBootstrapService,
    AiDraftService,
    AiBuildService,
    AiFeaturesService,
    AiProviderClient,
  ],
})
export class LlmModule {}
