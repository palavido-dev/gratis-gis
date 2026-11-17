// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { Public } from '../../auth/public.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { absoluteBase } from './url.js';
import { ITEM_SELECT, UUID_RE } from './records-core.js';
import { buildAardvark } from './aardvark-core.js';

/**
 * OpenGeoMetadata Aardvark export (#116 / research cycle).
 *
 * One JSON document per public item, shaped for GeoBlacklight /
 * OpenGeoMetadata harvest (a git repo of .json files). This is a
 * projection only: GratisGIS keeps its own item model; Aardvark is
 * the library-catalogue view.
 *
 *   GET /api/public/ogc/aardvark/{id}.json
 *
 * See docs/research/ecosystem-alignment-2026-08-17.md.
 */
@ApiTags('public', 'ogc', 'aardvark')
@Controller('public/ogc/aardvark')
export class OgcAardvarkController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  // Harvest scrape path (SEC-aardvark-throttle): tighter than the
  // global 300/min so anonymous id sweeps cannot lean on it alone.
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get(':itemId.json')
  async one(
    @Req() req: Request,
    @Param('itemId') itemId: string,
  ): Promise<Record<string, unknown>> {
    // Nest captures the param including a literal ".json" suffix
    // when the route is `:itemId.json`; strip if a client hit
    // `/aardvark/{uuid}` without the extension somehow.
    const id = itemId.replace(/\.json$/i, '');
    if (!UUID_RE.test(id)) {
      throw new NotFoundException('Record not found.');
    }
    const row = await this.prisma.item.findFirst({
      where: { id, access: 'public', deletedAt: null },
      select: {
        ...ITEM_SELECT,
        org: { select: { name: true } },
      },
    });
    if (!row) throw new NotFoundException('Record not found.');
    return buildAardvark(row, absoluteBase(req));
  }
}
