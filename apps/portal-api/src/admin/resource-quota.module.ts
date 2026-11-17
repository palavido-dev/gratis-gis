// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { ResourceQuotaService } from './resource-quota.service.js';

@Module({
  providers: [ResourceQuotaService],
  exports: [ResourceQuotaService],
})
export class ResourceQuotaModule {}
