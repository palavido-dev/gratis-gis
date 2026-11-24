// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { AreaOfInterestController } from './area-of-interest.controller.js';
import { AreaOfInterestService } from './area-of-interest.service.js';

/** Areas of interest for What's Here (#796). See the service. */
@Module({
  controllers: [AreaOfInterestController],
  providers: [AreaOfInterestService],
  exports: [AreaOfInterestService],
})
export class AreaOfInterestModule {}
