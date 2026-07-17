// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { SamplesService, type SeedSampleDataResult } from './samples.service.js';

/**
 * "Load sample data" endpoint (#147 Phase 1). Lives under the items
 * path because the button that fires it sits on the items page and
 * the effect is "items appear"; the seeding logic itself is the
 * SamplesService's job.
 *
 * POST /api/items/sample-data
 *   -> { created: string[], skipped: string[] } keyed by seedKind
 *      slug. Re-invoking on a fully seeded org reports everything
 *      skipped (idempotent by design).
 *
 * Authorization: any signed-in org admin or contributor (the
 * can_publish_items capability). Viewers get a 403 from the service.
 */
@ApiTags('items')
@ApiBearerAuth()
@Controller('items')
export class SamplesController {
  constructor(private readonly samples: SamplesService) {}

  @Post('sample-data')
  loadSampleData(@CurrentUser() user: AuthUser): Promise<SeedSampleDataResult> {
    return this.samples.seedSampleData(user);
  }
}
