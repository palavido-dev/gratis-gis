// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IsIn, IsString } from 'class-validator';

import { AdminGuard } from '../admin/admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

const STATUSES = ['new', 'handled', 'spam'] as const;
type FeedbackStatusValue = (typeof STATUSES)[number];

class UpdateFeedbackDto {
  @IsString() @IsIn(STATUSES) status!: FeedbackStatusValue;
}

/**
 * Triage surface for stored feedback.
 *
 * Admin-only, and NOT gated on PORTAL_FEEDBACK_ENABLED: an operator
 * who turns the form off still needs to read, action, and delete
 * whatever came in while it was on. Gating the reader on the writer's
 * flag would strand exactly the data the flag flip was reacting to.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/feedback')
@UseGuards(AdminGuard)
export class FeedbackAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Newest first, optionally filtered by status. Paged with a plain
   * offset rather than a keyset: this table is small by nature (it is
   * bounded by how many humans bother to write in) and an admin
   * jumping to page 4 is a more useful affordance here than the
   * no-drift guarantee that matters on a million-row feature layer.
   */
  @Get()
  async list(
    @Query('status') status?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    if (status !== undefined && !STATUSES.includes(status as FeedbackStatusValue)) {
      throw new BadRequestException(
        `Status must be one of: ${STATUSES.join(', ')}.`,
      );
    }
    const limit = clampInt(limitRaw, 50, 1, 200);
    const offset = clampInt(offsetRaw, 0, 0, 1_000_000);
    const where = status ? { status: status as FeedbackStatusValue } : {};

    const [rows, total, counts] = await Promise.all([
      this.prisma.feedback.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          message: true,
          status: true,
          name: true,
          email: true,
          pageUrl: true,
          appVersion: true,
          userAgent: true,
          viewport: true,
          screenshotKey: true,
          createdAt: true,
          handledAt: true,
          user: { select: { id: true, username: true, fullName: true } },
          handledBy: { select: { username: true, fullName: true } },
        },
      }),
      this.prisma.feedback.count({ where }),
      this.prisma.feedback.groupBy({ by: ['status'], _count: true }),
    ]);

    return {
      items: rows.map((r) => ({
        ...r,
        // The key is an internal storage path; the client only needs
        // to know whether to render an image and where to ask for it.
        screenshotKey: undefined,
        hasScreenshot: r.screenshotKey !== null,
      })),
      total,
      limit,
      offset,
      counts: Object.fromEntries(
        STATUSES.map((s) => [
          s,
          counts.find((c) => c.status === s)?._count ?? 0,
        ]),
      ),
    };
  }

  /**
   * Stream a submission's screenshot. Proxied through the API on
   * purpose: the `feedback-screenshot/` prefix is absent from the
   * bucket's public-read policy, so these bytes are not reachable
   * without the admin check this route applies.
   */
  @Get(':id/screenshot')
  async screenshot(@Param('id') id: string, @Res() res: Response) {
    const row = await this.prisma.feedback.findUnique({
      where: { id },
      select: { screenshotKey: true },
    });
    if (!row?.screenshotKey) throw new NotFoundException('No screenshot.');

    const upstream = await this.storage.streamObject(row.screenshotKey);
    if (upstream.contentType) res.setHeader('content-type', upstream.contentType);
    if (upstream.contentLength !== undefined) {
      res.setHeader('content-length', String(upstream.contentLength));
    }
    // Never cached by a shared cache: this is another person's
    // screenshot behind an admin check.
    res.setHeader('cache-control', 'private, no-store');
    upstream.body.pipe(res);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateFeedbackDto,
  ) {
    const existing = await this.prisma.feedback.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Feedback not found.');

    // Moving back to `new` clears the handled trail rather than
    // leaving a stale "handled by X" on something now marked unread.
    const handled = dto.status !== 'new';
    return this.prisma.feedback.update({
      where: { id },
      data: {
        status: dto.status,
        handledAt: handled ? new Date() : null,
        handledById: handled ? user.id : null,
      },
      select: { id: true, status: true, handledAt: true },
    });
  }

  /**
   * Hard delete, including the screenshot object. Feedback can carry
   * whatever someone typed into a public box, so "remove it" has to
   * actually remove it; a soft delete would leave the content sitting
   * in the table it was meant to be purged from.
   */
  @Delete(':id')
  async remove(@Param('id') id: string) {
    const row = await this.prisma.feedback.findUnique({
      where: { id },
      select: { id: true, screenshotKey: true },
    });
    if (!row) throw new NotFoundException('Feedback not found.');

    if (row.screenshotKey) {
      try {
        await this.storage.deleteObject(row.screenshotKey);
      } catch {
        // An orphaned object is worth less than a blocked delete:
        // the admin asked for the row to go, so it goes. The object
        // is unreferenced afterwards and swept by the same
        // housekeeping pass that handles other orphaned uploads.
      }
    }
    await this.prisma.feedback.delete({ where: { id } });
    return { ok: true };
  }
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new BadRequestException('Limit and offset must be whole numbers.');
  }
  return Math.min(Math.max(n, min), max);
}
