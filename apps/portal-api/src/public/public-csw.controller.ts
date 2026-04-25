import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../auth/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * CSW (Catalog Service for the Web) 2.0.2 surface (#31).
 *
 * Niche XML catalog protocol the GIS world keeps in circulation
 * for ISO 19115 metadata harvesting. We respond just enough of it
 * to be usable by harvesters that already speak it (GeoNetwork,
 * pycsw clients, ArcGIS Online's metadata import). For new
 * integrations prefer OGC API Records or the existing
 * /public/catalog.json (DCAT) feed; this exists for compatibility.
 *
 * Implemented operations:
 *   - GetCapabilities: minimum-viable capabilities document.
 *   - GetRecords (typeNames=csw:Record, ElementSetName=summary):
 *       returns one csw:SummaryRecord per public item.
 *
 * Not implemented:
 *   - Full ISO 19115 metadata records (gmd:MD_Metadata) -- callers
 *     that need richer metadata can fall back to the JSON catalog.
 *   - Filter / Constraint expressions -- everything is an
 *     unfiltered list of public items; max=50 by default.
 *   - GetRecordById, DescribeRecord, Transactions: out of scope
 *     for a read-only public surface.
 */
@ApiTags('public', 'csw')
@Controller('public/csw')
export class PublicCswController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  @Header('content-type', 'application/xml; charset=utf-8')
  async dispatch(
    @Req() req: Request,
    @Query('service') service?: string,
    @Query('request') request?: string,
    @Query('startposition') startPosition?: string,
    @Query('maxrecords') maxRecords?: string,
  ): Promise<string> {
    const base = absoluteBase(req);
    if (!service || service.toUpperCase() !== 'CSW') {
      return ows('MissingParameterValue', 'service', 'service must be CSW');
    }
    const op = (request ?? '').toLowerCase();
    if (op === 'getcapabilities') return getCapabilities(base);
    if (op === 'getrecords') {
      const start = clamp(parseInt(startPosition ?? '1', 10) || 1, 1, 1_000_000);
      const max = clamp(parseInt(maxRecords ?? '50', 10) || 50, 1, 200);
      return this.getRecords(start, max);
    }
    return ows(
      'InvalidParameterValue',
      'request',
      `Unsupported operation: ${request ?? '(none)'}. ` +
        'Supported: GetCapabilities, GetRecords.',
    );
  }

  private async getRecords(start: number, max: number): Promise<string> {
    const total = await this.prisma.item.count({
      where: { access: 'public', deletedAt: null },
    });
    const rows = await this.prisma.item.findMany({
      where: { access: 'public', deletedAt: null },
      select: {
        id: true,
        title: true,
        description: true,
        type: true,
        tags: true,
        license: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: max,
      skip: start - 1,
    });

    const records = rows
      .map(
        (r) => `
    <csw:SummaryRecord
      xmlns:csw="http://www.opengis.net/cat/csw/2.0.2"
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:dct="http://purl.org/dc/terms/"
      xmlns:ows="http://www.opengis.net/ows">
      <dc:identifier>${esc(r.id)}</dc:identifier>
      <dc:title>${esc(r.title)}</dc:title>
      <dc:type>${esc(r.type)}</dc:type>
      ${(r.tags ?? [])
        .map((t) => `<dc:subject>${esc(t)}</dc:subject>`)
        .join('')}
      <dct:abstract>${esc(r.description || r.title)}</dct:abstract>
      <dct:modified>${r.updatedAt.toISOString()}</dct:modified>
      ${r.license ? `<dct:rights>${esc(r.license)}</dct:rights>` : ''}
    </csw:SummaryRecord>`,
      )
      .join('');

    const nextRecord =
      start + rows.length <= total ? start + rows.length : 0;

    return `<?xml version="1.0" encoding="UTF-8"?>
<csw:GetRecordsResponse
  xmlns:csw="http://www.opengis.net/cat/csw/2.0.2"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dct="http://purl.org/dc/terms/"
  xmlns:ows="http://www.opengis.net/ows"
  version="2.0.2">
  <csw:SearchStatus timestamp="${new Date().toISOString()}"/>
  <csw:SearchResults
    numberOfRecordsMatched="${total}"
    numberOfRecordsReturned="${rows.length}"
    nextRecord="${nextRecord}"
    elementSet="summary">
    ${records}
  </csw:SearchResults>
</csw:GetRecordsResponse>`;
  }
}

function getCapabilities(base: string): string {
  const endpoint = `${base}/api/public/csw`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<csw:Capabilities
  xmlns:csw="http://www.opengis.net/cat/csw/2.0.2"
  xmlns:ows="http://www.opengis.net/ows"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  version="2.0.2">
  <ows:ServiceIdentification>
    <ows:Title>GratisGIS public catalog</ows:Title>
    <ows:Abstract>Read-only CSW 2.0.2 view of public items in this portal.</ows:Abstract>
    <ows:ServiceType>CSW</ows:ServiceType>
    <ows:ServiceTypeVersion>2.0.2</ows:ServiceTypeVersion>
  </ows:ServiceIdentification>
  <ows:OperationsMetadata>
    <ows:Operation name="GetCapabilities">
      <ows:DCP>
        <ows:HTTP>
          <ows:Get xlink:href="${endpoint}"/>
        </ows:HTTP>
      </ows:DCP>
    </ows:Operation>
    <ows:Operation name="GetRecords">
      <ows:DCP>
        <ows:HTTP>
          <ows:Get xlink:href="${endpoint}"/>
        </ows:HTTP>
      </ows:DCP>
      <ows:Parameter name="typeNames">
        <ows:Value>csw:Record</ows:Value>
      </ows:Parameter>
      <ows:Parameter name="outputSchema">
        <ows:Value>http://www.opengis.net/cat/csw/2.0.2</ows:Value>
      </ows:Parameter>
      <ows:Parameter name="ElementSetName">
        <ows:Value>summary</ows:Value>
      </ows:Parameter>
    </ows:Operation>
  </ows:OperationsMetadata>
</csw:Capabilities>`;
}

function ows(code: string, locator: string, text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ows:ExceptionReport
  xmlns:ows="http://www.opengis.net/ows"
  version="2.0.2">
  <ows:Exception exceptionCode="${esc(code)}" locator="${esc(locator)}">
    <ows:ExceptionText>${esc(text)}</ows:ExceptionText>
  </ows:Exception>
</ows:ExceptionReport>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function absoluteBase(req: Request): string {
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined) ??
    req.protocol ??
    'http';
  const host =
    (req.headers['x-forwarded-host'] as string | undefined) ??
    req.headers.host ??
    'localhost';
  return `${proto}://${host}`;
}
