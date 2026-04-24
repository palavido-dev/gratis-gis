import {
  BadRequestException,
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SharingService } from '../items/sharing.service.js';
import { FeaturesService } from '../features/features.service.js';
import { V3FeaturesService } from '../features-v3/v3-features.service.js';
import { IngestService } from './ingest.service.js';

/**
 * Server-side ingest endpoint. Accepts a multipart upload of an
 * OGR-readable vector file, parses it via GDAL, and writes the
 * features into a PostGIS table (v2 storage). The item metadata is
 * updated to reflect the new storage type.
 *
 * Only data_layer items are accepted as targets. The caller must
 * have edit rights (owner or org admin, same rule as PATCH /items/:id).
 */
@ApiTags('ingest')
@ApiBearerAuth()
@Controller()
export class IngestController {
  constructor(
    private readonly ingest: IngestService,
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly prisma: PrismaService,
    private readonly features: FeaturesService,
    private readonly v3Features: V3FeaturesService,
  ) {}

  /**
   * Probe an uploaded spatial file and return per-layer metadata
   * (name, geometry type, fields, feature count) without creating or
   * mutating any items. Backs the builder's Import tab: user picks
   * one or more layers, we seed the v3 schema with them, then the
   * user fills in details and creates the item.
   */
  @Post('ingest/probe')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  async probe(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException(
        'No file uploaded; field name must be "file".',
      );
    }
    return this.ingest.probeFile(file.buffer, file.originalname);
  }

  @Post('items/:id/ingest')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        // Multer enforces the same ceiling as IngestService. Defense in
        // depth is cheap and it gives users a clear 413 instead of
        // burning CPU on a 2 GB shapefile.
        fileSize: 100 * 1024 * 1024,
      },
    }),
  )
  async ingestFile(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded; field name must be "file".');
    }

    const item = await this.items.get(user, id);
    if (item.type !== 'data_layer') {
      throw new BadRequestException(
        'Server-side ingest only targets data_layer items.',
      );
    }
    const shares = await this.prisma.itemShare.findMany({ where: { itemId: id } });
    if (!this.sharing.canEdit(user, item, shares)) {
      throw new ForbiddenException('You do not have edit permission on this item.');
    }

    const { geojson, fields, driver, sourceSrs } = await this.ingest.fileToGeoJson(
      file.buffer,
      file.originalname,
    );

    // Ensure the PostGIS table exists for this item (idempotent).
    await this.features.provisionTable(id);

    // Replace all current features with the newly ingested set.
    const { inserted, expired } = await this.features.replaceAll(
      id,
      geojson.features.map((f: unknown) => {
        const feat = f as {
          geometry?: unknown;
          properties?: Record<string, unknown> | null;
        };
        return {
          geometry: feat.geometry,
          properties: feat.properties ?? {},
        };
      }),
      user,
    );

    // Compute bbox and update item metadata to v2 storage shape.
    const stats = await this.features.stats(id);
    const nextData: Record<string, unknown> = {
      version: 2,
      storageType: 'postgis',
      fields: fields.map((f) => ({
        name: f.name,
        type: f.type,
        label: f.name,
        nullable: true,
      })),
      featureCount: stats.featureCount,
      bbox: stats.bbox,
      updatedAt: new Date().toISOString(),
      source: {
        fileName: file.originalname,
        format: driverToFormat(driver),
        sizeBytes: file.size,
        importedAt: new Date().toISOString(),
        importedBy: user.id,
        note: `driver: ${driver}`,
        sourceSrs,
      },
    };

    await this.prisma.item.update({
      where: { id },
      data: { data: nextData as unknown as Prisma.InputJsonValue },
    });

    return {
      driver,
      inserted,
      expired,
      featureCount: stats.featureCount,
      bbox: stats.bbox,
      fields: nextData.fields,
      sourceSrs,
    };
  }

  /**
   * Per-layer ingest for v3 multi-layer items. Accepts a file + the
   * optional name of a source layer inside a multi-layer archive
   * (GDB, shapefile zip with several .shp). Features get bulk-
   * inserted into the target layer's PostGIS table — which must
   * already exist (provisioned on item create by ItemsService).
   */
  @Post('items/:id/layers/:layerId/import')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  async ingestV3Layer(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('sourceLayer') sourceLayer?: string,
  ) {
    if (!file) {
      throw new BadRequestException(
        'No file uploaded; field name must be "file".',
      );
    }
    const item = await this.items.get(user, itemId);
    if (item.type !== 'data_layer') {
      throw new BadRequestException(
        'Ingest only targets data_layer items.',
      );
    }
    const data = item.data as {
      version?: number;
      layers?: Array<{ id: string }>;
    } | null;
    if (data?.version !== 3) {
      throw new BadRequestException(
        'Per-layer ingest is v3-only. Use /items/:id/ingest for v1/v2 items.',
      );
    }
    if (!(data.layers ?? []).some((l) => l.id === layerId)) {
      throw new NotFoundException(
        `Layer ${layerId} is not part of this item's schema.`,
      );
    }
    await this.items.assertCanEdit(user, itemId);

    const { geojson, driver, layerName, sourceSrs } = await this.ingest.fileLayerToGeoJson(
      file.buffer,
      file.originalname,
      sourceLayer,
    );

    const { inserted } = await this.v3Features.insertFeatures(
      itemId,
      layerId,
      geojson.features.map((f) => {
        const feat = f as {
          geometry?: unknown;
          properties?: Record<string, unknown> | null;
        };
        return {
          geometry: feat.geometry,
          properties: feat.properties ?? {},
        };
      }),
      user,
    );

    // Stamp provenance on the layer so the detail page can render
    // "Imported from nest-points.geojson on 4/24/2026 by Mateo". We
    // re-read the item rather than rely on the earlier snapshot since
    // insertFeatures may have mutated bbox / featureCount in between.
    await this.stampV3LayerSource(itemId, layerId, {
      fileName: file.originalname,
      format: driverToFormat(driver),
      sizeBytes: file.size,
      importedAt: new Date().toISOString(),
      importedBy: user.id,
      note: `driver: ${driver}`,
      sourceSrs,
    });

    return { driver, sourceLayer: layerName, inserted, sourceSrs };
  }

  /**
   * Merge a `source` block onto the named layer inside the item's
   * v3 data blob. Read-modify-write is safe here: this endpoint is
   * the only writer of layer.source, and we guard with canEdit above.
   */
  private async stampV3LayerSource(
    itemId: string,
    layerId: string,
    source: {
      fileName: string;
      format: string;
      sizeBytes: number;
      importedAt: string;
      importedBy: string;
      note?: string;
      sourceSrs?: string | null;
    },
  ) {
    const row = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { data: true },
    });
    const data = row?.data as
      | { version?: number; layers?: Array<Record<string, unknown>> }
      | null;
    if (!data || data.version !== 3 || !Array.isArray(data.layers)) return;
    const nextLayers = data.layers.map((l) =>
      (l as { id?: string }).id === layerId ? { ...l, source } : l,
    );
    const nextData = { ...(data as object), layers: nextLayers };
    await this.prisma.item.update({
      where: { id: itemId },
      data: { data: nextData as unknown as Prisma.InputJsonValue },
    });
  }
}

/**
 * Map GDAL driver strings we emit to the format enum the shared
 * DataLayerSource type exposes. Unknown drivers fall through to
 * 'api' so the shape stays strict on the client side.
 */
function driverToFormat(
  driver: string,
): 'geojson' | 'kml' | 'kmz' | 'shapefile' | 'gdb' | 'xlsx' | 'csv' | 'manual' | 'api' {
  const d = driver.toLowerCase();
  if (d.includes('geojson')) return 'geojson';
  if (d.includes('kmz')) return 'kmz';
  if (d.includes('kml')) return 'kml';
  if (d.includes('shape') || d.includes('esri shapefile')) return 'shapefile';
  if (d.includes('filegdb') || d.includes('openfilegdb')) return 'gdb';
  if (d.includes('xlsx') || d.includes('excel')) return 'xlsx';
  if (d.includes('csv')) return 'csv';
  return 'api';
}
