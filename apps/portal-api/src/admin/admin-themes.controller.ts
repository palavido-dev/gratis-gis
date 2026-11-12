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

import {
  THEME_STARTERS,
  type ThemeStarterKind,
} from '@gratis-gis/shared-types';
import { AdminGuard } from './admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

interface ThemeStarterStatus {
  kind: ThemeStarterKind;
  label: string;
  description: string;
  swatch: string;
  itemId: string | null;
}

class RestoreThemesDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  kinds?: string[];

  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/**
 * #22 Admin "Restore starter themes" surface.  Mirrors the admin
 * app-templates controller pattern: skip-if-present unless force,
 * owner falls back to the first org admin so the seeded items
 * survive admin churn, default access 'org' so every member can
 * read.  Idempotent against the DB via the seed_kind check.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/themes')
export class AdminThemesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('starter-status')
  async starterStatus(
    @CurrentUser() user: AuthUser,
  ): Promise<{ starters: ThemeStarterStatus[] }> {
    const present = await this.prisma.item.findMany({
      where: {
        orgId: user.orgId,
        type: 'theme',
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
      starters: THEME_STARTERS.map((s) => ({
        kind: s.kind,
        label: s.label,
        description: s.description,
        swatch: s.swatch,
        itemId: byKind.get(s.kind) ?? null,
      })),
    };
  }

  @Post('restore-starters')
  async restoreStarters(
    @CurrentUser() user: AuthUser,
    @Body() dto: RestoreThemesDto,
  ): Promise<{ restored: ThemeStarterKind[]; skipped: ThemeStarterKind[] }> {
    const requested = new Set<string>(
      dto.kinds ?? THEME_STARTERS.map((s) => s.kind),
    );
    const force = dto.force === true;

    const present = await this.prisma.item.findMany({
      where: {
        orgId: user.orgId,
        type: 'theme',
        seedKind: { not: null },
        deletedAt: null,
      },
      select: { seedKind: true },
    });
    const presentKinds = new Set(
      present.map((p) => p.seedKind).filter((k): k is string => k !== null),
    );

    const adminRow = await this.prisma.user.findFirst({
      // A removed or disabled admin keeps orgRole 'admin'; skip them.
      where: { orgId: user.orgId, orgRole: 'admin', deletedAt: null, disabledAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const ownerId = adminRow?.id ?? user.id;

    const restored: ThemeStarterKind[] = [];
    const skipped: ThemeStarterKind[] = [];
    const rowsToInsert: Array<{
      orgId: string;
      ownerId: string;
      type: 'theme';
      title: string;
      description: string;
      tags: string[];
      data: object;
      access: 'org';
      seedKind: string | null;
    }> = [];

    for (const starter of THEME_STARTERS) {
      if (!requested.has(starter.kind)) continue;
      const alreadyHere = presentKinds.has(starter.kind);
      if (alreadyHere && !force) {
        skipped.push(starter.kind);
        continue;
      }
      const titleSuffix = alreadyHere
        ? ` (restored ${new Date().toISOString().slice(0, 10)})`
        : '';
      rowsToInsert.push({
        orgId: user.orgId,
        ownerId,
        type: 'theme',
        title: starter.label + titleSuffix,
        description: starter.description,
        tags: ['built-in'],
        data: {
          version: 1,
          swatch: starter.swatch,
          tokens: starter.tokens,
        },
        access: 'org',
        // Force-restore copies drop seed_kind so the partial unique
        // index allows them alongside the existing customized starter.
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
