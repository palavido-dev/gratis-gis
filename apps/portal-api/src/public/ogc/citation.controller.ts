// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '../../auth/public.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { absoluteBase } from './url.js';
import { ITEM_SELECT, UUID_RE } from './records-core.js';
import {
  buildBibTeX,
  buildJsonLd,
  buildRis,
  filenameFor,
  mediaTypeFor,
  type CitationFormat,
} from './citation-core.js';

/**
 * Citation export for public items (research cycle 2 / #116 follow-up).
 *
 *   GET /api/public/ogc/citation/{id}.bib
 *   GET /api/public/ogc/citation/{id}.ris
 *   GET /api/public/ogc/citation/{id}.jsonld
 *
 * Same public-access filter as Records / Aardvark. No DOI minting.
 */
@ApiTags('public', 'ogc', 'citation')
@Controller('public/ogc/citation')
export class OgcCitationController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get(':itemId.bib')
  @Header('Content-Type', 'application/x-bibtex; charset=utf-8')
  async bib(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('itemId') itemId: string,
  ): Promise<string> {
    return this.render(req, res, itemId, 'bibtex');
  }

  @Public()
  @Get(':itemId.ris')
  @Header(
    'Content-Type',
    'application/x-research-info-systems; charset=utf-8',
  )
  async ris(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('itemId') itemId: string,
  ): Promise<string> {
    return this.render(req, res, itemId, 'ris');
  }

  @Public()
  @Get(':itemId.jsonld')
  @Header('Content-Type', 'application/ld+json; charset=utf-8')
  async jsonld(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('itemId') itemId: string,
  ): Promise<Record<string, unknown>> {
    const row = await this.loadPublic(itemId);
    const base = absoluteBase(req);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filenameFor(row, 'jsonld')}"`,
    );
    return buildJsonLd(row, base);
  }

  private async render(
    req: Request,
    res: Response,
    itemId: string,
    format: Exclude<CitationFormat, 'jsonld'>,
  ): Promise<string> {
    const row = await this.loadPublic(itemId);
    const base = absoluteBase(req);
    const body =
      format === 'bibtex' ? buildBibTeX(row, base) : buildRis(row, base);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filenameFor(row, format)}"`,
    );
    // Reinforce media type in case a proxy strips the decorator.
    res.setHeader('Content-Type', mediaTypeFor(format));
    return body;
  }

  private async loadPublic(itemId: string) {
    const id = itemId.replace(/\.(bib|ris|jsonld)$/i, '');
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
    return row;
  }
}
