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
  CATALOG_COLLECTION_ID,
  ITEM_SELECT,
  MAX_RECORDS_BBOX_SCAN,
  UUID_RE,
  buildRecord,
  buildRecordsPage,
  catalogCollectionDoc,
  clamp,
  filterAndPageRecords,
  parseSortby,
  recordsListParams,
  recordsWhere,
  type ItemRow,
} from './records-core.js';

/**
 * Searchable-catalog mount of OGC API Records (#116 / MetaSearch).
 *
 * QGIS MetaSearch splits its configured URL on `/collections/` and
 * OWSLib keeps `/collections` entries where `itemType == 'record'`.
 * This controller is that collection: id `catalog`, items under
 * `/items`, same payload as `/records`.
 *
 * Registered on a static path so it never races the Features
 * `:id` / `:id/items` routes for UUID collection ids.
 */
@ApiTags('public', 'ogc', 'records')
@Controller(`public/ogc/collections/${CATALOG_COLLECTION_ID}`)
export class OgcRecordsCatalogController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('/')
  catalog(@Req() req: Request) {
    const base = absoluteBase(req);
    return catalogCollectionDoc(`${base}/api/public/ogc`);
  }

  @Public()
  // Tighter than the global 300/min: bbox scans are heavier
  // (SEC-records-bbox-throttle).
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get('items')
  async items(
    @Req() req: Request,
    @Query('limit') limitParam?: string,
    @Query('offset') offsetParam?: string,
    @Query('q') q?: string,
    @Query('type') typeParam?: string,
    @Query('sortby') sortbyParam?: string,
    @Query('bbox') bboxParam?: string,
  ) {
    const base = absoluteBase(req);
    const selfBase = `${base}/api/public/ogc/collections/${CATALOG_COLLECTION_ID}/items`;
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
  @Get('items/:recordId')
  async item(
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
    const base = absoluteBase(req);
    return buildRecord(row as ItemRow, base, {
      selfPath: `${base}/api/public/ogc/collections/${CATALOG_COLLECTION_ID}/items/${recordId}`,
    });
  }
}
