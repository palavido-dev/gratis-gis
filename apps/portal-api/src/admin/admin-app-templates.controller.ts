// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

import { STARTERS, type StarterKind } from '@gratis-gis/shared-types';
import { AdminGuard } from './admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Status of one starter for this org.  Drives the housekeeping UI
 * (rendered as a row per starter with present/missing badge + the
 * single Restore button).
 */
interface StarterStatus {
  kind: StarterKind;
  label: string;
  description: string;
  /** UUID of the existing seeded item, when present. */
  itemId: string | null;
}

class RestoreStartersDto {
  /**
   * Subset of starter kinds to restore.  Omit (or leave empty) to
   * mean "restore every starter that is currently missing."
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  kinds?: string[];

  /**
   * When true, create a fresh item even if a starter with the same
   * seedKind already exists in the org.  Useful for "I edited it
   * and want a clean copy alongside."  Default false.
   */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/**
 * #22 Admin "Restore starter templates" surface.
 *
 * The four starter app templates (sidebar-explorer / showcase-map
 * / compact-drawer / blank-canvas) are seeded into every org on
 * first sign-in via AuthSyncService.ensureBuiltinAppTemplates.
 * After that, admins are free to edit / delete / replace them
 * like any other item.  This controller provides the explicit
 * "factory reset" path: an admin who deleted a starter a year ago
 * and now wants it back can click one button and the missing
 * starters are re-seeded.
 *
 * Behaviour mirrors the seeder:
 *
 *   - Skip kinds that already exist (matched by seed_kind),
 *     unless `force=true`, in which case create alongside with a
 *     suffix on the title to disambiguate.
 *   - Owner of the new item is the first admin in the org (same
 *     as the bootstrap path), so it survives admin churn.
 *   - Default access is 'org' so every member can read.
 *
 * GET returns the status of each starter in this org so the UI
 * can render its checklist before issuing the POST.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/app-templates')
export class AdminAppTemplatesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('starter-status')
  async starterStatus(
    @CurrentUser() user: AuthUser,
  ): Promise<{ starters: StarterStatus[] }> {
    const present = await this.prisma.item.findMany({
      where: {
        orgId: user.orgId,
        type: 'app_template',
        seedKind: { not: null },
        deletedAt: null,
      },
      select: { id: true, seedKind: true },
    });
    const byKind = new Map<string, string>();
    for (const row of present) {
      if (row.seedKind && !byKind.has(row.seedKind)) {
        byKind.set(row.seedKind, row.id);
      }
    }
    return {
      starters: STARTERS.map((s) => ({
        kind: s.kind,
        label: s.label,
        description: s.description,
        itemId: byKind.get(s.kind) ?? null,
      })),
    };
  }

  @Post('restore-starters')
  async restoreStarters(
    @CurrentUser() user: AuthUser,
    @Body() dto: RestoreStartersDto,
  ): Promise<{ restored: StarterKind[]; skipped: StarterKind[] }> {
    const requested = new Set<string>(dto.kinds ?? STARTERS.map((s) => s.kind));
    const force = dto.force === true;

    // Look up which starters are already present in this org.
    const present = await this.prisma.item.findMany({
      where: {
        orgId: user.orgId,
        type: 'app_template',
        seedKind: { not: null },
        deletedAt: null,
      },
      select: { seedKind: true },
    });
    const presentKinds = new Set(
      present.map((p) => p.seedKind).filter((k): k is string => k !== null),
    );

    // Owner falls back to the requesting admin when no other admin
    // exists; matches the bootstrap pattern.  This is more robust
    // than always using user.id because it preserves the original
    // bootstrap-owner convention on orgs that already have one.
    const adminRow = await this.prisma.user.findFirst({
      // A removed or disabled admin keeps orgRole 'admin'; skip them.
      where: { orgId: user.orgId, orgRole: 'admin', deletedAt: null, disabledAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const ownerId = adminRow?.id ?? user.id;

    const restored: StarterKind[] = [];
    const skipped: StarterKind[] = [];
    const rowsToInsert: Array<{
      orgId: string;
      ownerId: string;
      type: 'app_template';
      title: string;
      description: string;
      tags: string[];
      data: object;
      access: 'org';
      seedKind: string | null;
    }> = [];

    for (const starter of STARTERS) {
      if (!requested.has(starter.kind)) continue;
      const alreadyHere = presentKinds.has(starter.kind);
      if (alreadyHere && !force) {
        skipped.push(starter.kind);
        continue;
      }
      // When force=true and a copy already exists, suffix the
      // title so the admin can tell the two apart, and DROP the
      // seed_kind on the new copy.  The partial unique index on
      // (org, type, seed_kind) only allows one starter per org;
      // the alongside copy is a fresh reference, not a "starter"
      // anymore, so it stores as a regular user-saved template
      // and the existing customized starter stays Present.
      const titleSuffix = alreadyHere
        ? ` (restored ${new Date().toISOString().slice(0, 10)})`
        : '';
      rowsToInsert.push({
        orgId: user.orgId,
        ownerId,
        type: 'app_template',
        title: starter.label + titleSuffix,
        description: starter.description,
        tags: ['built-in', ...starter.tags],
        data: starter.seed() as unknown as object,
        access: 'org',
        seedKind: alreadyHere ? null : starter.kind,
      });
      restored.push(starter.kind);
    }

    if (rowsToInsert.length > 0) {
      await this.prisma.item.createMany({ data: rowsToInsert });
    }

    return { restored, skipped };
  }
}
