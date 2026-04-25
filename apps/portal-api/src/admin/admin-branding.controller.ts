import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import { AdminGuard } from './admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Admin-only read/write for the five landing-page knobs on
 * Organization. Kept tiny on purpose: the page isn't a CMS, it's a
 * handful of branding fields an admin might touch a few times in
 * the lifetime of an org.
 *
 * - landingTitle       : short org-facing title (defaults to org.name)
 * - landingSubtitle    : one-line tagline
 * - landingHeroImageUrl: optional hero band image; empty falls back to a
 *                         muted fill
 * - landingShowPublicItems: toggle the content grid
 * - landingFeaturedItemIds: ordered ids to feature ahead of the rest
 *
 * GET returns the current config so the editor can prefill. PATCH
 * accepts any subset of the five fields; omitted keys are left
 * untouched, null values explicitly clear.
 */
class UpdateBrandingDto {
  @IsOptional() @IsString() @MaxLength(200)
  landingTitle?: string | null;

  @IsOptional() @IsString() @MaxLength(500)
  landingSubtitle?: string | null;

  @IsOptional() @IsString() @MaxLength(2048)
  landingHeroImageUrl?: string | null;

  @IsOptional() @IsBoolean()
  landingShowPublicItems?: boolean;

  /**
   * Items to feature at the top of the grid, in authored order.
   * Capped at a reasonable number so a misclick can't stage a
   * thousand uuids into the row.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('loose', { each: true })
  landingFeaturedItemIds?: string[];
}

@ApiTags('admin', 'branding')
@ApiBearerAuth()
@Controller('admin/branding')
@UseGuards(AdminGuard)
export class AdminBrandingController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get(@CurrentUser() user: AuthUser) {
    const org = await this.prisma.organization.findUnique({
      where: { id: user.orgId },
      select: {
        id: true,
        slug: true,
        name: true,
        landingTitle: true,
        landingSubtitle: true,
        landingHeroImageUrl: true,
        landingShowPublicItems: true,
        landingFeaturedItemIds: true,
      },
    });
    return org;
  }

  @Patch()
  async update(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateBrandingDto,
  ) {
    // Build a sparse update so omitted fields are left untouched.
    // Explicit null through the DTO resolves to Prisma's null write
    // (Prisma accepts null for nullable columns).
    const data: Record<string, unknown> = {};
    if (dto.landingTitle !== undefined) {
      data.landingTitle = dto.landingTitle;
    }
    if (dto.landingSubtitle !== undefined) {
      data.landingSubtitle = dto.landingSubtitle;
    }
    if (dto.landingHeroImageUrl !== undefined) {
      data.landingHeroImageUrl = dto.landingHeroImageUrl;
    }
    if (dto.landingShowPublicItems !== undefined) {
      data.landingShowPublicItems = dto.landingShowPublicItems;
    }
    if (dto.landingFeaturedItemIds !== undefined) {
      // Featured ids must belong to the caller's org. Orphan /
      // cross-org ids are filtered out silently rather than
      // rejecting the whole patch.
      const valid = await this.prisma.item.findMany({
        where: {
          id: { in: dto.landingFeaturedItemIds },
          orgId: user.orgId,
          deletedAt: null,
        },
        select: { id: true },
      });
      const validSet = new Set(valid.map((v) => v.id));
      data.landingFeaturedItemIds = dto.landingFeaturedItemIds.filter((id) =>
        validSet.has(id),
      );
    }
    return this.prisma.organization.update({
      where: { id: user.orgId },
      data,
      select: {
        id: true,
        slug: true,
        name: true,
        landingTitle: true,
        landingSubtitle: true,
        landingHeroImageUrl: true,
        landingShowPublicItems: true,
        landingFeaturedItemIds: true,
      },
    });
  }
}
