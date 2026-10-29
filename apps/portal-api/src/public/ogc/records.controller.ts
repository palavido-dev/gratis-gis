// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { Public } from '../../auth/public.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { absoluteBase } from './url.js';
import {
  ITEM_SELECT,
  MAX_RECORDS_BBOX_SCAN,
  UUID_RE,
  buildRecord,
  buildRecordsPage,
  clamp,
  filterAndPageRecords,
  parseSortby,
  recordsListParams,
  recordsWhere,
  type ItemRow,
} from './records-core.js';

/**
 * OGC API - Records Part 1 Core (#116). Modern catalog surface
 * that replaces the legacy CSW XML protocol for clients that speak
 * the OGC API style; CSW stays up alongside indefinitely for
 * harvesters that haven't upgraded.
 *
 * Surface:
 *
 *   /api/public/ogc/records          - the catalog (records list)
 *   /api/public/ogc/records/{id}     - one record
 *
 * The searchable-catalog mount that QGIS MetaSearch discovers lives
 * at `/api/public/ogc/collections/catalog` (see
 * records-catalog.controller.ts). This `/records` path stays as a
 * stable alias with the same payload.
 *
 * Conformance: record-core + json + sorting + searchable-catalog
 * (declared on the landing controller once the catalog collection
 * is present).
 */
@ApiTags('public', 'ogc', 'records')
@Controller('public/ogc/records')
export class OgcRecordsController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  // Tighter than the global 300/min: bbox scans are heavier
  // (SEC-records-bbox-throttle).
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get('/')
  async records(
    @Req() req: Request,
    @Query('limit') limitParam?: string,
    @Query('offset') offsetParam?: string,
    @Query('q') q?: string,
    @Query('type') typeParam?: string,
    @Query('sortby') sortbyParam?: string,
    @Query('bbox') bboxParam?: string,
  ) {
    const base = absoluteBase(req);
    const selfBase = `${base}/api/public/ogc/records`;
    const rootHref = `${base}/api/public/ogc/`;
    const limit = clamp(parseInt(limitParam ?? '', 10) || 100, 1, 1000);
    const offset = Math.max(0, parseInt(offsetParam ?? '', 10) || 0);
    const params = recordsListParams({
      limit,
      offset,
      q,
      type: typeParam,
      sortby: sortbyParam,
      bbox: bboxParam,
    });
    const where = recordsWhere({ q, type: typeParam });
    const orderBy = parseSortby(sortbyParam);

    if (bboxParam && bboxParam.trim().length > 0) {
      const rows = (await this.prisma.item.findMany({
        where,
        select: ITEM_SELECT,
        orderBy,
        take: MAX_RECORDS_BBOX_SCAN,
      })) as ItemRow[];
      return filterAndPageRecords(rows, base, selfBase, params, rootHref);
    }

    const [total, rows] = await Promise.all([
      this.prisma.item.count({ where }),
      this.prisma.item.findMany({
        where,
        select: ITEM_SELECT,
        orderBy,
        skip: offset,
        take: limit,
      }),
    ]);
    return buildRecordsPage(
      rows as ItemRow[],
      total,
      base,
      selfBase,
      params,
      rootHref,
    );
  }

  @Public()
  // Match list budget (SEC-records-item-throttle): single-item GETs
  // were still on the global 300/min default.
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get(':recordId')
  async record(
    @Req() req: Request,
    @Param('recordId') recordId: string,
  ) {
    if (!UUID_RE.test(recordId)) {
      throw new NotFoundException('Record not found.');
    }
    const row = await this.prisma.item.findFirst({
      where: { id: recordId, access: 'public', deletedAt: null },
      select: ITEM_SELECT,
    });
    if (!row) throw new NotFoundException('Record not found.');
    return buildRecord(row as ItemRow, absoluteBase(req));
  }
}
