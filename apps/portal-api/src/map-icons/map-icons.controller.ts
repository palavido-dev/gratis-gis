// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  ForbiddenException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Express } from 'express';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { canDeleteMapIcon } from './map-icon-auth.js';
import { hasCapability } from '../auth/capabilities.js';
import { UuidPathPipe } from '../common/uuid-shape.js';
import { sanitizeSvg } from './svg-sanitizer.js';
import {
  RASTER_ICON_MAX_BYTES,
  RasterIconError,
  claimedIconType,
  processRasterIcon,
} from './raster-icon.js';

/** SVG cap. Vector map icons are KB at most. */
const SVG_MAX_BYTES = 1024 * 1024;
/** Multer's hard stop: the larger of the per-type caps. */
const MAX_BYTES = Math.max(SVG_MAX_BYTES, RASTER_ICON_MAX_BYTES);
/** Uploaded icons one organization may hold. */
export const MAX_ICONS_PER_ORG = 1000;

class UploadMapIconDto {
  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(80)
  label?: string;
}

export interface MapIconUploadDto {
  id: string;
  storageKey: string;
  storageUrl: string;
  label: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * Per-org marker uploads for the map point-symbol picker
 * (#73). SVG, plus PNG and JPEG since #686. The picker calls /list to populate the "Org uploads"
 * section alongside the bundled Lucide grid; the upload flow
 * sanitizes the file (allowlist-only XML walker, see
 * svg-sanitizer.ts) then pushes the cleaned body into MinIO
 * under the `map-icon/` kind. Each successful upload writes a
 * MapIconUpload row so the picker can index by org + present
 * a friendly label without re-fetching from MinIO.
 */
@ApiBearerAuth()
@ApiTags('map-icons')
@Controller('map-icons')
export class MapIconsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * List the calling user's org's uploaded icons, newest first.
   * The picker shows the top 50 in a horizontal scroll; we cap
   * at 200 in the response in case a future bulk-uploader needs
   * the wider window.
   */
  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<MapIconUploadDto[]> {
    const rows = await this.prisma.mapIconUpload.findMany({
      where: { orgId: user.orgId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(toDto);
  }

  /**
   * Upload one SVG, PNG or JPEG file. Multipart `file` field;
   * optional `label` form field. Returns the new MapIconUpload row.
   * Failure modes (all return 400 with a specific message):
   *   - no file in the multipart body
   *   - not named or typed as SVG, PNG or JPEG
   *   - SVG larger than 1 MB, or PNG / JPEG larger than 2 MB
   *   - SVG sanitizer rejected the body (script, external
   *     reference, etc.)
   *   - PNG / JPEG whose bytes are not really that format, will
   *     not decode, or is over 4096 x 4096 pixels
   *
   * SVG goes through the sanitizer exactly as before. PNG and JPEG
   * are checked by magic bytes and a real decode, then re-encoded
   * as a PNG of at most 256 px on the long side (raster-icon.ts).
   * Raster keys end in `.png` so the map can tell them apart.
   */
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_BYTES },
    }),
  )
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadMapIconDto,
  ): Promise<MapIconUploadDto> {
    // Icons go into the whole org's picker and their bytes are never
    // deleted, so adding one is publishing. A viewer could otherwise
    // add icons without limit and push the org's own out of the list.
    if (!hasCapability(user, 'can_publish_items')) {
      throw new ForbiddenException(
        'Uploading map icons needs a contributor or admin role.',
      );
    }
    const count = await this.prisma.mapIconUpload.count({
      where: { orgId: user.orgId },
    });
    if (count >= MAX_ICONS_PER_ORG) {
      throw new BadRequestException(
        `This organization has ${MAX_ICONS_PER_ORG} uploaded icons, the most allowed. Delete some to add more.`,
      );
    }
    if (!file) {
      throw new BadRequestException(
        'No file uploaded; field name must be "file".',
      );
    }
    const claimed = claimedIconType(file.mimetype, file.originalname);
    if (claimed === 'raster') {
      return this.uploadRaster(user, file, dto);
    }
    if (claimed !== 'svg') {
      throw new BadRequestException(
        'Only .svg, .png and .jpg files are accepted for map-icon uploads.',
      );
    }
    if (file.size > SVG_MAX_BYTES || file.buffer.length > SVG_MAX_BYTES) {
      throw new BadRequestException('SVG is larger than 1 MB.');
    }
    const raw = file.buffer.toString('utf8');
    const cleaned = sanitizeSvg(raw);
    if (!cleaned) {
      throw new BadRequestException(
        'SVG rejected by sanitizer. Strip out any <script>, ' +
          '<foreignObject>, external <image> references, or ' +
          'event-handler attrs and try again.',
      );
    }
    const body = Buffer.from(cleaned, 'utf8');
    const upload = await this.storage.uploadBuffer(
      'map-icon',
      body,
      'image/svg+xml',
    );
    const label = (dto.label || stripExt(file.originalname)).slice(0, 80);
    const row = await this.prisma.mapIconUpload.create({
      data: {
        storageKey: upload.key,
        storageUrl: upload.publicUrl,
        label,
        fileName: file.originalname.slice(0, 200),
        sizeBytes: body.length,
        orgId: user.orgId,
        createdBy: user.id,
      },
    });
    return toDto(row);
  }

  private async uploadRaster(
    user: AuthUser,
    file: Express.Multer.File,
    dto: UploadMapIconDto,
  ): Promise<MapIconUploadDto> {
    let body: Buffer;
    try {
      ({ body } = await processRasterIcon(file.buffer));
    } catch (err) {
      if (err instanceof RasterIconError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
    const upload = await this.storage.uploadBuffer(
      'map-icon',
      body,
      'image/png',
      '.png',
    );
    const label = (dto.label || stripExt(file.originalname)).slice(0, 80);
    const row = await this.prisma.mapIconUpload.create({
      data: {
        storageKey: upload.key,
        storageUrl: upload.publicUrl,
        label,
        fileName: file.originalname.slice(0, 200),
        sizeBytes: body.length,
        orgId: user.orgId,
        createdBy: user.id,
      },
    });
    return toDto(row);
  }

  /**
   * Remove an uploaded icon. Idempotent: deleting an already-
   * gone row returns 404 the first time, then 404 forever (the
   * picker filters its UI to the latest list response so a
   * client that races a delete just sees the row disappear).
   *
   * The corresponding MinIO object is left in place; we don't
   * track every layer style that might still reference it, so
   * deleting the bytes risks breaking already-saved maps. The
   * bucket cleanup is a future garbage-collection pass.
   */
  @Delete(':id')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new UuidPathPipe('Map icon not found.')) id: string,
  ): Promise<{ ok: true }> {
    const row = await this.prisma.mapIconUpload.findUnique({
      where: { id },
    });
    if (!row || row.orgId !== user.orgId) {
      throw new NotFoundException('Map icon not found.');
    }
    if (!canDeleteMapIcon(user, row)) {
      throw new ForbiddenException(
        'You can delete an icon you uploaded. An org admin can delete any icon in the org.',
      );
    }
    await this.prisma.mapIconUpload.delete({ where: { id } });
    return { ok: true };
  }
}

function toDto(row: {
  id: string;
  storageKey: string;
  storageUrl: string;
  label: string;
  fileName: string;
  sizeBytes: number;
  createdAt: Date;
}): MapIconUploadDto {
  return {
    id: row.id,
    storageKey: row.storageKey,
    storageUrl: row.storageUrl,
    label: row.label,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}
