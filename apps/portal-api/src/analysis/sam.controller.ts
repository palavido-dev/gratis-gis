// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ItemsService } from '../items/items.service.js';
import { StorageService } from '../storage/storage.service.js';

/**
 * Magic-outline (SAM) embedding surface. The browser decoder needs
 * one 4 MiB image embedding per 1024px map window ("supertile":
 * tile coords at zoom minus two). Embeddings are computed by the
 * analysis worker (kind 'sam-embed'), cached forever in MinIO, and
 * served here.
 *
 * Access gating is read access on the imagery item, NOT publish
 * rights: the tool exists for people digitizing features, who are
 * often editors without the contributor role. The job is cheap
 * (a few seconds of CPU), deduplicated, and permanently cached, so
 * read access is the honest requirement.
 */
@ApiTags('analysis')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class SamController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly storage: StorageService,
    private readonly cfg: ConfigService,
  ) {}

  private assertServerTier(): void {
    const tiers = (this.cfg.get<string>('ANALYSIS_TIERS') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tiers.includes('server-heavy')) {
      throw new ServiceUnavailableException(
        'The outline tool needs the analysis worker, which is not enabled on this portal.',
      );
    }
  }

  /** Validate + normalize the supertile address. */
  private parseKey(z: string | number, gx: string | number, gy: string | number) {
    const zi = Number(z);
    const gxi = Number(gx);
    const gyi = Number(gy);
    if (
      !Number.isInteger(zi) ||
      !Number.isInteger(gxi) ||
      !Number.isInteger(gyi) ||
      zi < 14 ||
      zi > 22
    ) {
      throw new BadRequestException('Zoom in further to use the outline tool.');
    }
    const n = 2 ** (zi - 2);
    if (gxi < 0 || gyi < 0 || gxi >= n || gyi >= n) {
      throw new BadRequestException('That view is off the map.');
    }
    return { z: zi, gx: gxi, gy: gyi };
  }

  private async assertReadableImagery(user: AuthUser, itemId: string) {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'tile_layer') {
      throw new BadRequestException('The outline tool works on imagery layers.');
    }
    const data = item.data as {
      kind?: string;
      dem?: boolean;
      cogStorageKey?: string;
    } | null;
    if (data?.kind !== 'raster' || data.dem || !data.cogStorageKey) {
      throw new BadRequestException(
        'The outline tool needs an imagery layer with its original image file.',
      );
    }
    return item;
  }

  /**
   * Make sure the embedding for one supertile exists. Returns
   * ready | working, creating the worker job when needed. The
   * client polls until ready, then fetches the bytes.
   */
  @Post('items/:itemId/sam/embedding')
  async ensure(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body() body: { z: number; gx: number; gy: number },
  ) {
    this.assertServerTier();
    await this.assertReadableImagery(user, itemId);
    const { z, gx, gy } = this.parseKey(body.z, body.gx, body.gy);

    const key = `sam-embed/${itemId}/${z}/${gx}/${gy}.bin`;
    if (await this.storage.objectExists(key)) {
      return { state: 'ready' as const };
    }
    const existing = await this.prisma.analysisJob.findFirst({
      where: {
        kind: 'sam-embed',
        sourceItemId: itemId,
        state: { in: ['queued', 'running'] },
        params: { equals: { z, gx, gy } },
      },
      select: { id: true },
    });
    if (existing) {
      return { state: 'working' as const, jobId: existing.id };
    }
    const job = await this.prisma.analysisJob.create({
      data: {
        orgId: user.orgId,
        userId: user.id,
        kind: 'sam-embed',
        params: { z, gx, gy },
        sourceItemId: itemId,
      },
    });
    return { state: 'working' as const, jobId: job.id };
  }

  /** Job state for the ensure poll (failed jobs carry the message). */
  @Get('items/:itemId/sam/embedding/:z/:gx/:gy/state')
  async state(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Param('z') z: string,
    @Param('gx') gx: string,
    @Param('gy') gy: string,
  ) {
    await this.assertReadableImagery(user, itemId);
    const parsed = this.parseKey(z, gx, gy);
    const key = `sam-embed/${itemId}/${parsed.z}/${parsed.gx}/${parsed.gy}.bin`;
    if (await this.storage.objectExists(key)) {
      return { state: 'ready' as const };
    }
    const job = await this.prisma.analysisJob.findFirst({
      where: {
        kind: 'sam-embed',
        sourceItemId: itemId,
        params: { equals: parsed },
      },
      orderBy: { createdAt: 'desc' },
      select: { state: true, error: true },
    });
    if (!job) return { state: 'missing' as const };
    if (job.state === 'failed') {
      return { state: 'failed' as const, error: job.error };
    }
    return { state: 'working' as const };
  }

  /** The embedding bytes: 256x64x64 float32, little-endian. */
  @Get('items/:itemId/sam/embedding/:z/:gx/:gy')
  async fetch(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Param('z') z: string,
    @Param('gx') gx: string,
    @Param('gy') gy: string,
    @Res() res: Response,
  ) {
    await this.assertReadableImagery(user, itemId);
    const parsed = this.parseKey(z, gx, gy);
    const key = `sam-embed/${itemId}/${parsed.z}/${parsed.gx}/${parsed.gy}.bin`;
    try {
      const obj = await this.storage.streamObject(key);
      res.status(200);
      res.setHeader('Content-Type', 'application/octet-stream');
      if (obj.contentLength !== undefined) {
        res.setHeader('Content-Length', String(obj.contentLength));
      }
      // Content-addressed by key and immutable once computed.
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      obj.body.pipe(res);
    } catch {
      throw new NotFoundException(
        'The embedding for this view is not ready yet.',
      );
    }
  }
}
