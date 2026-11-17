// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { AdminAuditService } from './admin-audit.service.js';

/** Prisma-only so items and backup can record events without a cycle. */
@Module({
  providers: [AdminAuditService],
  exports: [AdminAuditService],
})
export class AdminAuditModule {}
