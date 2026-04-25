import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsString, MaxLength } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import type { AssetKind } from './storage.service.js';
import { StorageService } from './storage.service.js';

const ASSET_KINDS: AssetKind[] = [
  'item-thumb',
  'group-thumb',
  'user-avatar',
  'org-hero',
  'feature-attachment',
];

class PresignUploadDto {
  @IsEnum(ASSET_KINDS) kind!: AssetKind;
  /** Thumbnails stay image-only (the service layer enforces); feature
   *  attachments accept any MIME so we only validate non-empty here. */
  @IsString() @MaxLength(255) contentType!: string;
}

/**
 * Minting presigned URLs requires a valid auth token (the global JWT
 * guard handles that). Beyond auth, we don't gate by role here: any
 * authenticated user may upload imagery for entities they own, and the
 * PATCH endpoint that persists the URL is where we enforce ownership.
 * A leaked presigned URL just lets someone burn 5 MB of our storage,
 * which is a 60-second window and a clear abuse signal if it happens.
 */
@ApiTags('storage')
@ApiBearerAuth()
@Controller('storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('presign-upload')
  async presignUpload(
    @CurrentUser() _user: AuthUser,
    @Body() dto: PresignUploadDto,
  ) {
    try {
      return await this.storage.presignUpload(dto.kind, dto.contentType);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to sign upload';
      throw new BadRequestException(msg);
    }
  }
}
