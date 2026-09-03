// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  FieldQueueService,
  type ManifestEntry,
} from './field-queue.service.js';

/**
 * One queued record's metadata. The actual edit payload (attribute
 * values, geometry) stays on the device by design; we only mirror what
 * an admin needs to see "user X has 47 records stuck". Validation is
 * intentionally permissive on free-form fields (id, layerId) since
 * client-generated globalIds are arbitrary uuids.
 */
class QueuedRecordDto {
  @IsString() @MaxLength(128) id!: string;
  @IsIn(['insert', 'update', 'delete']) op!: 'insert' | 'update' | 'delete';
  @IsString() @MaxLength(128) layerId!: string;
  @IsString() @MaxLength(64) queuedAt!: string;
  @IsIn(['pending', 'failed', 'rejected']) status!:
    | 'pending'
    | 'failed'
    | 'rejected';
  @IsOptional() @IsString() @MaxLength(500) lastError?: string;
  @IsOptional() @IsInt() @Min(0) attempts?: number;
}

class ManifestEntryDto {
  @IsString() @MaxLength(128) dataCollectionId!: string;
  @IsOptional() @IsString() @MaxLength(64) cachedAt?: string | null;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QueuedRecordDto)
  queuedRecords!: QueuedRecordDto[];
}

class PostManifestDto {
  @IsString() @MaxLength(128) deviceFingerprint!: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ManifestEntryDto)
  manifest!: ManifestEntryDto[];
  /** navigator.storage.estimate().usage at the time of the post. */
  @IsOptional() @IsInt() @Min(0) storageUsage?: number;
  /** navigator.storage.estimate().quota at the time of the post. */
  @IsOptional() @IsInt() @Min(0) storageQuota?: number;
  /** Captured by the client so the admin view can show "iPhone Safari"
   *  without us having to re-derive it from request headers. */
  @IsOptional() @IsString() @MaxLength(512) userAgent?: string;
}

/**
 * Public-to-authenticated-users endpoint that the field client beacons
 * to. Any signed-in user can post their own queue manifest; the
 * server scopes the upsert to the caller's userId so a user cannot
 * impersonate another worker's device. The admin view (a separate
 * controller) is the consumer.
 */
@ApiTags('field')
@ApiBearerAuth()
@Controller('field/queue-manifest')
export class FieldQueueController {
  constructor(private readonly service: FieldQueueService) {}

  @Post()
  @HttpCode(204)
  async post(
    @CurrentUser() user: AuthUser,
    @Body() body: PostManifestDto,
  ): Promise<void> {
    if (!body.deviceFingerprint?.trim()) {
      // class-validator normally guards this, but explicit message for
      // the device case (not a typing mistake, a missing crypto api on
      // the client).
      throw new BadRequestException('deviceFingerprint is required');
    }
    await this.service.upsertManifest({
      userId: user.id,
      deviceFingerprint: body.deviceFingerprint,
      manifest: body.manifest as ManifestEntry[],
      storageUsage: body.storageUsage,
      storageQuota: body.storageQuota,
      userAgent: body.userAgent ?? null,
    });
  }
}
