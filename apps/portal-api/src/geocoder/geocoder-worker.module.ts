// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { GeocoderWorker } from './geocoder.worker.js';

/**
 * Worker-only: builds and serves the managed geocoder. Kept out of the
 * API graph so API replicas never run open-geocode themselves.
 */
@Module({
  imports: [PrismaModule],
  providers: [GeocoderWorker],
})
export class GeocoderWorkerModule {}
