// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  ForbiddenException,
  Controller,
  Delete,
  Get,
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
import { sanitizeSvg } from './svg-sanitizer.js';

const MAX_BYTES = 1024 * 1024; // 1 MB; map icons are KB at most.

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
 * Per-org SVG marker uploads for the map point-symbol picker
 * (#73). The picker calls /list to populate the "Org uploads"
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
   * Upload one SVG file. Multipart `file` field; optional
   * `label` form field. Returns the new MapIconUpload row.
   * Failure modes (all return 400 with a specific message):
   *   - no file in the multipart body
   *   - file larger than 1 MB
   *   - content-type not image/svg+xml
   *   - SVG sanitizer rejected the body (script, external
   *     reference, etc.)
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
    if (!file) {
      throw new BadRequestException(
        'No file uploaded; field name must be "file".',
      );
    }
    if (
      file.mimetype !== 'image/svg+xml' &&
      !file.originalname.toLowerCase().endsWith('.svg')
    ) {
      throw new BadRequestException(
        'Only .svg files are accepted for map-icon uploads.',
      );
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
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    const row = await this.prisma.mapIconUpload.findUnique({
      where: { id },
    });
    if (!row || row.orgId !== user.orgId) {
      throw new BadRequestException('Map icon not found.');
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
