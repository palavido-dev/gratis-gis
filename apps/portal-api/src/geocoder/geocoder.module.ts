// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { AdminAuditModule } from '../admin/admin-audit.module.js';
import { AdminGuard } from '../admin/admin.guard.js';
import { OperatorOrgGuard } from '../backup/operator-org.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { GeocoderAdminController } from './geocoder-admin.controller.js';

/** Admin -> Geocoding (API side). The worker side is GeocoderWorkerModule. */
@Module({
  imports: [PrismaModule, AdminAuditModule],
  controllers: [GeocoderAdminController],
  providers: [AdminGuard, OperatorOrgGuard],
})
export class GeocoderModule {}
