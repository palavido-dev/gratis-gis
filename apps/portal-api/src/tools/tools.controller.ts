// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { IsObject, IsOptional } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { Public } from '../auth/public.decorator.js';
import {
  RecipeRunnerService,
  type ToolRunRequest,
} from './recipe-runner.service.js';

/**
 * Wire-shape for POST /api/tools/:id/run.  The parameter map is left
 * as a free-form object since each recipe declares its own slots;
 * the runner validates every name against the recipe's parameter
 * schema before doing anything.
 */
class ToolRunDto {
  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;
}

/**
 * Tool recipe HTTP surface (#90).  POST /api/tools/:id/run executes
 * the tool's recipe and returns the output sink shape.
 *
 * The endpoint is `@Public()` so a public Custom Web App can run
 * an embedded public Tool without a sign-in -- the typical
 * "self-service OSM query inside a published map viewer" shape.
 * Authorisation isn't bypassed: the runner short-circuits to
 * "public only" when no user is present, refuses tool items that
 * aren't `access='public'`, and refuses recipe sinks that would
 * touch private data layers (the selection sink, etc.) without
 * an authenticated principal.
 *
 * Authenticated callers still get the full surface: full ACL
 * gating, all output sinks, layer reads scoped to their session.
 *
 * Rate limit is tighter than the global 300/min default (matches
 * anonymous drawings writes): public Overpass-backed tools are an
 * easy egress burn if left at the global ceiling.
 */
@ApiTags('tools')
@ApiBearerAuth()
@Controller('tools')
export class ToolsController {
  constructor(private readonly runner: RecipeRunnerService) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post(':id/run')
  @HttpCode(200)
  async run(
    @CurrentUser() user: AuthUser | null,
    @Param('id') toolId: string,
    @Body() body: ToolRunDto,
  ) {
    const request: ToolRunRequest = {
      parameters: (body.parameters ?? {}) as ToolRunRequest['parameters'],
    };
    // run() branches on the action kind AND on whether a user is
    // present.  Anonymous callers can run pure-Overpass tools
    // (osm-features-overlay, osm-relational-query) bound to inline-
    // geojson AOIs against public Tool items; everything else
    // requires auth.
    return this.runner.run(user, toolId, request);
  }
}
