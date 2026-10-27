// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { MapLayerFilter } from '@gratis-gis/shared-types';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PostgisLiveService_ } from './postgis-live.service.js';
import { ItemsService } from '../items/items.service.js';
import { CredentialService } from '../items/credential.service.js';

class TestConnectionDto {
  @IsString() @MinLength(1) @MaxLength(255) host!: string;
  @IsInt() port!: number;
  @IsString() @MinLength(1) @MaxLength(255) database!: string;
  @IsString() @MinLength(1) @MaxLength(255) role!: string;
  @IsString() @MaxLength(1024) password!: string;
  /** Optional schema for the capped geometry-table preview. */
  @IsOptional() @IsString() @MaxLength(63) defaultSchema?: string;
}

class CreateConnectionDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsString() @MinLength(1) @MaxLength(255) host!: string;
  @IsInt() port!: number;
  @IsString() @MinLength(1) @MaxLength(255) database!: string;
  @IsString() @MinLength(1) @MaxLength(255) role!: string;
  @IsString() @MaxLength(1024) password!: string;
  @IsOptional() @IsString() @MaxLength(63) defaultSchema?: string;
}

class ReadFeaturesDto {
  @IsString() @MaxLength(255) tableName!: string;
  @IsOptional()
  @IsArray()
  bbox?: [number, number, number, number];
  @IsOptional() @IsString() @MaxLength(2000) whereClause?: string;
  /**
   * #158 Phase 1.5: structured MapLayer.filter to compile into a
   * parameterized SQL fragment. The service does shape validation
   * + column-existence checks; the class-validator decorator here
   * just gates a shallow "is this an object" check so a malformed
   * payload still 400s cleanly.
   */
  @IsOptional() @IsObject() filter?: MapLayerFilter;
  @IsOptional() @IsInt() limit?: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(name: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
}

@ApiTags('postgis-live')
@ApiBearerAuth()
@Controller('postgis-live')
export class PostgisLiveController {
  constructor(
    private readonly svc: PostgisLiveService_,
    private readonly items: ItemsService,
    private readonly credentials: CredentialService,
  ) {}

  /**
   * Create a postgis_live service item end-to-end: tests the
   * connection, creates the item, stores the password as a
   * credential, runs the probe to populate `layers[]`. Used by
   * the wizard so the user gets a single Save click instead of
   * three.
   */
  @Post('create')
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateConnectionDto,
  ) {
    // 1. Test the connection BEFORE creating the item so a bad
    //    password / wrong port doesn't leave a half-configured
    //    service item lying around.
    const test = await this.svc.testConnection({
      host: dto.host,
      port: dto.port,
      database: dto.database,
      role: dto.role,
      password: dto.password,
      ...(dto.defaultSchema ? { defaultSchema: dto.defaultSchema } : {}),
    });
    if (!test.ok) {
      throw new BadRequestException(
        `Connection failed: ${test.error}`,
      );
    }
    // 2. Create the service item with empty layers[].
    const itemData = {
      version: 1 as const,
      protocol: 'postgis_live' as const,
      url:
        `postgis://${dto.host}:${dto.port}/${dto.database}` +
        (dto.defaultSchema ? `?schema=${dto.defaultSchema}` : ''),
      host: dto.host,
      port: dto.port,
      database: dto.database,
      role: dto.role,
      ...(dto.defaultSchema ? { defaultSchema: dto.defaultSchema } : {}),
      layers: [],
      requiresAuth: true,
      statementTimeoutMs: 10_000,
    };
    const item = await this.items.create(user, {
      type: 'service',
      title: dto.title,
      description: dto.description ?? '',
      data: itemData,
      tags: ['postgis_live'],
    });
    // 3. Store the password as a basic-auth credential against
    //    the new item id.
    await this.credentials.setCredential(item.id, user.id, {
      kind: 'basic',
      username: dto.role,
      password: dto.password,
    });
    // 4. Probe for tables and write them onto the item's data.
    const layers = await this.svc.probe(user, item.id);
    const updated = await this.items.update(user, item.id, {
      // Prisma typing wants InputJsonValue here; cast via unknown
      // because PostgisLiveLayerSnapshot[] satisfies the JSON shape
      // at runtime but TS doesn't see the structural match.
      data: { ...itemData, layers } as unknown as never,
    });
    return updated;
  }

  /**
   * Test a PostGIS connection without saving. The wizard's
   * "Test connection" button hits this; on success the wizard
   * proceeds to the probe step and then to save.
   */
  @Post('test-connection')
  testConnection(@Body() dto: TestConnectionDto) {
    return this.svc.testConnection(dto);
  }

  /**
   * Probe a registered service item for its current set of
   * geometry tables. Called by the wizard during create (to seed
   * `layers[]`) and on demand from the service detail page.
   */
  @Post(':serviceItemId/probe')
  probe(
    @CurrentUser() user: AuthUser,
    @Param('serviceItemId') serviceItemId: string,
  ) {
    assertUuid('serviceItemId', serviceItemId);
    return this.svc.probe(user, serviceItemId);
  }

  /**
   * Bbox-filtered live read. The map canvas hits this on every
   * viewport change for a postgis-live layer.
   */
  @Post(':serviceItemId/features')
  readFeatures(
    @CurrentUser() user: AuthUser,
    @Param('serviceItemId') serviceItemId: string,
    @Body() dto: ReadFeaturesDto,
  ) {
    assertUuid('serviceItemId', serviceItemId);
    return this.svc.readFeatures(user, serviceItemId, {
      tableName: dto.tableName,
      ...(dto.bbox ? { bbox: dto.bbox } : {}),
      ...(dto.whereClause ? { whereClause: dto.whereClause } : {}),
      ...(dto.filter ? { filter: dto.filter } : {}),
      ...(dto.limit !== undefined ? { limit: dto.limit } : {}),
    });
  }
}
