import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from './items.service.js';
import { SharingService } from './sharing.service.js';
import {
  AUTH_KINDS,
  CredentialService,
  type AuthKind,
  type CredentialPayload,
} from './credential.service.js';

class SetCredentialDto {
  @IsEnum(AUTH_KINDS) kind!: AuthKind;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(4096) token?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(256) username?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(1024) password?: string;
}

/**
 * Per-item credential CRUD (#36). Credentials are encrypted at
 * rest and never returned in plaintext from these endpoints --
 * GET only reports "a credential is set, of kind X." The proxy
 * controller (separate file) is the only path that decrypts a
 * credential, and even then the plaintext stays inside the
 * server process.
 *
 * Authz: callers must have admin rights on the item to set or
 * clear (matches share-management gate). Read-side metadata is
 * gated to canEdit so collaborators can see whether the
 * credential is configured without being able to mutate it.
 */
@ApiTags('items', 'credentials')
@ApiBearerAuth()
@Controller('items/:id/credential')
export class ItemCredentialController {
  constructor(
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly credentials: CredentialService,
  ) {}

  @Get()
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const item = await this.items.get(user, id);
    // Editors and admins can see whether a credential is set.
    // Plain readers shouldn't even know about it (defence in
    // depth: the item's existence is already public to them, but
    // its operational config is not).
    const shares = (item as { shares?: unknown }).shares as
      | Parameters<SharingService['canEdit']>[2]
      | undefined;
    if (!this.sharing.canEdit(user, item, shares ?? [])) {
      throw new ForbiddenException(
        'You need edit access on the item to view credential metadata',
      );
    }
    const meta = await this.credentials.getCredentialMeta(id);
    return meta ?? { hasSecret: false };
  }

  @Put()
  async put(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetCredentialDto,
  ) {
    const item = await this.items.get(user, id);
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException(
        'Only the owner or an org admin can set credentials',
      );
    }
    // Build a typed payload from the DTO. The DTO is intentionally
    // permissive (every field optional) so a single endpoint can
    // accept all three kinds; the per-kind validation happens here
    // and lives next to the kind discriminator.
    let payload: CredentialPayload;
    switch (dto.kind) {
      case 'bearer':
        if (!dto.token) {
          throw new BadRequestException('bearer requires a token');
        }
        payload = { kind: 'bearer', token: dto.token };
        break;
      case 'arcgis_token':
        if (!dto.token) {
          throw new BadRequestException('arcgis_token requires a token');
        }
        payload = { kind: 'arcgis_token', token: dto.token };
        break;
      case 'basic':
        if (!dto.username || !dto.password) {
          throw new BadRequestException(
            'basic requires username and password',
          );
        }
        payload = {
          kind: 'basic',
          username: dto.username,
          password: dto.password,
        };
        break;
    }
    return this.credentials.setCredential(id, user.id, payload);
  }

  @Delete()
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const item = await this.items.get(user, id);
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException(
        'Only the owner or an org admin can clear credentials',
      );
    }
    await this.credentials.clearCredential(id);
  }
}
