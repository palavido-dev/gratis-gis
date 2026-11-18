// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  IsArray,
  IsIn,
  IsInt,
  Max,
  Min,
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
import { hasCapability } from '../auth/capabilities.js';
import { PrintReadable } from '../auth/print-readable.decorator.js';
import {
  POSTGIS_SSL_MODES,
  PostgisLiveService_,
  type PostgisSslMode,
} from './postgis-live.service.js';
import { ItemsService } from '../items/items.service.js';
import { CredentialService } from '../items/credential.service.js';
import { assertCredentialKeyConfigured } from '../items/credential-cipher.js';

class TestConnectionDto {
  @IsString() @MinLength(1) @MaxLength(255) host!: string;
  @IsInt() @Min(1) @Max(65535) port!: number;
  @IsString() @MinLength(1) @MaxLength(255) database!: string;
  @IsString() @MinLength(1) @MaxLength(255) role!: string;
  @IsString() @MaxLength(1024) password!: string;
  /** Optional schema for the capped geometry-table preview. */
  @IsOptional() @IsString() @MaxLength(63) defaultSchema?: string;
  /** libpq-style SSL mode; `prefer` when omitted. */
  @IsOptional() @IsIn(POSTGIS_SSL_MODES) sslMode?: PostgisSslMode;
}

class CreateConnectionDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsString() @MinLength(1) @MaxLength(255) host!: string;
  @IsInt() @Min(1) @Max(65535) port!: number;
  @IsString() @MinLength(1) @MaxLength(255) database!: string;
  @IsString() @MinLength(1) @MaxLength(255) role!: string;
  @IsString() @MaxLength(1024) password!: string;
  @IsOptional() @IsString() @MaxLength(63) defaultSchema?: string;
  @IsOptional() @IsIn(POSTGIS_SSL_MODES) sslMode?: PostgisSslMode;
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
  @IsOptional() @IsInt() @Min(1) @Max(5000) limit?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(name: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
}

function assertCanAuthorPostgis(user: AuthUser): void {
  if (!hasCapability(user, 'can_publish_items')) {
    throw new ForbiddenException(
      'Creating a PostGIS connection requires the contributor or admin role.',
    );
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
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('create')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateConnectionDto) {
    assertCanAuthorPostgis(user);
    // 0. The password has to be stored encrypted, so a server with no
    //    credential key cannot save a connection at all. Say so before
    //    anything is written: otherwise the item is created and step 3
    //    throws a bare 500, leaving an empty connection behind on every
    //    press of Save.
    try {
      assertCredentialKeyConfigured();
    } catch {
      throw new ServiceUnavailableException(
        'This server cannot store connection passwords yet: ' +
          'CREDENTIAL_ENCRYPTION_KEY is not set. Ask an administrator ' +
          'to set it and restart the API, then save again.',
      );
    }
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
      ...(dto.sslMode ? { sslMode: dto.sslMode } : {}),
    });
    if (!test.ok) {
      throw new BadRequestException(`Connection failed: ${test.error}`);
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
      // The mode that just connected, so live reads connect alike.
      sslMode: test.sslMode,
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
    try {
      // 3. Store the password as a basic-auth credential against
      //    the new item id.
      await this.credentials.setCredential(item.id, user.id, {
        kind: 'basic',
        username: dto.role,
        password: dto.password,
      });
      // 4. Probe for tables and write them onto the item's data.
      const layers = await this.svc.probe(user, item.id);
      return await this.items.update(user, item.id, {
        // Prisma typing wants InputJsonValue here; cast via unknown
        // because PostgisLiveLayerSnapshot[] satisfies the JSON shape
        // at runtime but TS doesn't see the structural match.
        data: { ...itemData, layers } as unknown as never,
      });
    } catch (err) {
      // Do not leave a connection without its password or its tables:
      // it would sit in the content list looking usable and fail on
      // every map. Take it back out, then report the error.
      await this.items
        .remove(user, item.id)
        .then(() => this.items.purge(user, item.id))
        .catch(() => undefined);
      throw err;
    }
  }

  /**
   * Test a PostGIS connection without saving. The wizard's
   * "Test connection" button hits this; on success the wizard
   * proceeds to the probe step and then to save.
   */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('test-connection')
  testConnection(@CurrentUser() user: AuthUser, @Body() dto: TestConnectionDto) {
    assertCanAuthorPostgis(user);
    return this.svc.testConnection(dto);
  }

  /**
   * Probe a registered service item for its current set of
   * geometry tables. Called by the wizard during create (to seed
   * `layers[]`) and on demand from the service detail page.
   */
  @Post(':serviceItemId/probe')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async probe(@CurrentUser() user: AuthUser, @Param('serviceItemId') serviceItemId: string) {
    assertUuid('serviceItemId', serviceItemId);
    // Same gate as create and test: a probe lists the whole schema
    // and runs a query per table on the owner's database.
    assertCanAuthorPostgis(user);
    const layers = await this.svc.probe(user, serviceItemId);
    // Keep the item's table snapshot current. It is written once, at
    // create, and the live read only serves tables on it, so a table
    // added afterwards (from QGIS, say) could never be drawn. Anyone
    // who may edit the item refreshes it by probing; anyone else just
    // gets the fresh list back.
    try {
      const item = await this.items.get(user, serviceItemId);
      const data = (item.data ?? {}) as Record<string, unknown>;
      await this.items.update(user, serviceItemId, {
        data: { ...data, layers } as unknown as never,
      });
    } catch (err) {
      if (!(err instanceof ForbiddenException)) throw err;
    }
    return layers;
  }

  /**
   * Bbox-filtered live read. The map canvas hits this on every
   * viewport change for a postgis-live layer.
   */
  @Post(':serviceItemId/features')
  // The server-side print reads live layers here
  // (print-read-credential.ts). A POST only because the query is in
  // the body; it reads and never writes.
  @PrintReadable({ method: 'POST', idParam: 'serviceItemId' })
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
