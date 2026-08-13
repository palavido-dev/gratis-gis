// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { AdminGuard } from './admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from '../common/net-guards.js';

/**
 * Admin-only read / write for org-scoped third-party-integration
 * settings. Currently surfaces a single knob (#103: Overpass
 * endpoint); the shape exists so future integration toggles
 * (org-level geocoder URL, AGO portal default, etc.) can land
 * in the same controller without sprawling new files.
 *
 * Null clears the override, an empty string is rejected (would
 * confuse the OSM resolver with "user explicitly chose blank").
 * Any non-empty value is stored verbatim; we do NOT validate that
 * the URL points at a working Overpass instance because that
 * check belongs in a probe button, not the PATCH handler.
 */
class UpdateIntegrationsDto {
  /**
   * #103: per-org Overpass API endpoint. Null clears the override;
   * a non-empty URL takes precedence over the global env-var when
   * OSM recipes run on behalf of users in this org. Bounded length
   * keeps the field within sensible URL limits.
   */
  @IsOptional() @IsString() @MaxLength(2048)
  osmOverpassEndpoint?: string | null;
}

@ApiTags('admin', 'integrations')
@ApiBearerAuth()
@Controller('admin/integrations')
@UseGuards(AdminGuard)
export class AdminIntegrationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get(@CurrentUser() user: AuthUser) {
    const org = await this.prisma.organization.findUnique({
      where: { id: user.orgId },
      select: { id: true, osmOverpassEndpoint: true },
    });
    return {
      osmOverpassEndpoint: org?.osmOverpassEndpoint ?? null,
      // Surface the effective fallback so the admin UI can render
      // "Currently using https://overpass-api.de/... (default)"
      // when osmOverpassEndpoint is null.
      osmOverpassEndpointDefault:
        process.env.GRATIS_GIS_OSM_OVERPASS_ENDPOINT ??
        'https://overpass-api.de/api/interpreter',
    };
  }

  @Patch()
  async update(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateIntegrationsDto,
  ) {
    const data: Record<string, unknown> = {};
    if (dto.osmOverpassEndpoint !== undefined) {
      if (dto.osmOverpassEndpoint === null) {
        data.osmOverpassEndpoint = null;
      } else {
        const trimmed = dto.osmOverpassEndpoint.trim();
        if (trimmed.length === 0) {
          throw new BadRequestException(
            'osmOverpassEndpoint must be a non-empty URL or null. Use null to clear.',
          );
        }
        // Validate the URL shape, then SSRF-check it. The OSM resolver
        // now fetches through safeFetch so it is guarded at query time
        // too, but a private/loopback/metadata endpoint should be
        // refused at save so the admin gets an error now, not a silent
        // failure when a recipe runs.
        try {
          const url = new URL(trimmed);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error('protocol must be http or https');
          }
        } catch (err) {
          throw new BadRequestException(
            `osmOverpassEndpoint is not a valid URL: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        try {
          await assertSafeOutboundUrl(trimmed);
        } catch (err) {
          if (err instanceof UnsafeOutboundUrlError) {
            throw new BadRequestException(err.message);
          }
          throw err;
        }
        data.osmOverpassEndpoint = trimmed;
      }
    }
    await this.prisma.organization.update({
      where: { id: user.orgId },
      data,
    });
    return this.get(user);
  }
}
