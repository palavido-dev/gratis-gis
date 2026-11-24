// SPDX-License-Identifier: AGPL-3.0-or-later
import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../auth/public.decorator.js';
import { AreaOfInterestService } from './area-of-interest.service.js';

@ApiTags('areas-of-interest')
@Controller('areas-of-interest')
export class AreaOfInterestController {
  constructor(private readonly areas: AreaOfInterestService) {}

  /**
   * Resolve an area for What's Here (#796) and return the id the
   * aggregate reads take as `?area=`.
   *
   * Public, because a public app screens for anonymous visitors and
   * its reads go through the public aggregate mirror. What keeps that
   * safe, in place of the honeypot the feedback form uses:
   *   - it stores a shape and nothing else, and reads no table;
   *   - the body is held to the shared geometry limits (256 KiB,
   *     50,000 vertices) before PostGIS sees it, and so is the result;
   *   - rows are content addressed, so repeating a request adds
   *     nothing, and unused rows are pruned after a week;
   *   - this throttle, tighter than the global one.
   * A screen registers once per edit of the area, not once per layer,
   * so 60 a minute is far above what a person drawing produces.
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Post()
  register(@Body() body: unknown) {
    return this.areas.register(body);
  }
}
