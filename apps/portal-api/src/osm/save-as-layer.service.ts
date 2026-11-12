// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import {
  DEFAULT_DATA_LAYER_V3,
  type DataLayerDataV3,
  type DataLayerSublayer,
  type FeatureField,
  type LayerGeometryType,
} from '@gratis-gis/shared-types';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { DataLayerFeaturesService } from '../data-layer/features.service.js';
import { ItemsService } from '../items/items.service.js';
import type { OsmGeoJsonFeature } from './osm-to-geojson.js';

/**
 * OSM "Save overlay as data_layer" service (#102, wave 2).
 *
 * Materializes the in-memory GeoJSON features from an OSM overlay
 * into a brand-new data_layer item the calling user owns. Once
 * saved, the layer is just a regular portal item: it can be shared,
 * restyled, queried via OGC API, joined / clipped in derived layer
 * pipelines, exported through the bundle path, etc. The OSM cache
 * is no longer load-bearing for the persisted result.
 *
 * Why this is its own service rather than a generic "create
 * data_layer from FeatureCollection" surface: the schema inference
 * and the attribution defaulting are OSM-specific. The same
 * pattern (one method, two collaborators) would work for KML / GPX
 * promote-to-data_layer flows later, but each source has its own
 * field-typing quirks worth keeping local.
 *
 * Inputs are bounded: the controller's DTO refuses more than 50,000
 * features (the OSM resolver's own cap), so this service adds none.
 */
@Injectable()
export class OsmSaveAsLayerService {
  private readonly log = new Logger(OsmSaveAsLayerService.name);

  constructor(
    private readonly items: ItemsService,
    private readonly features: DataLayerFeaturesService,
  ) {}

  /**
   * Provision a new data_layer item and insert every feature from
   * `features` into its single sublayer. Returns the new item id.
   * Throws BadRequestException if the inputs are unusable.
   */
  async saveOverlayAsLayer(args: {
    user: AuthUser;
    title: string;
    description?: string;
    features: OsmGeoJsonFeature[];
  }): Promise<{ itemId: string; layerId: string; inserted: number }> {
    const cleanTitle = (args.title ?? '').trim();
    if (cleanTitle.length === 0) {
      throw new BadRequestException('Title is required.');
    }
    if (cleanTitle.length > 200) {
      throw new BadRequestException('Title is too long (max 200 chars).');
    }
    if (!Array.isArray(args.features) || args.features.length === 0) {
      throw new BadRequestException(
        'features must be a non-empty array of GeoJSON Feature objects.',
      );
    }

    // Schema + geometry inference. A homogeneous geometry type is
    // the common case for OSM overlays (preset = "amenity=cafe"
    // yields a points layer; preset = "highway" yields a lines
    // layer). When the input is mixed we promote to the lowest
    // common denominator so PostGIS can still validate every row.
    const geometryType = inferGeometryType(args.features);
    const fields = inferFields(args.features);

    const layerId = freshLayerId();
    const sublayer: DataLayerSublayer = {
      id: layerId,
      label: cleanTitle,
      name: slugify(cleanTitle, layerId),
      geometryType,
      fields,
      editingEnabled: false,
      attachmentsEnabled: false,
    };

    const data: DataLayerDataV3 = {
      ...DEFAULT_DATA_LAYER_V3,
      layers: [sublayer],
    };

    const created = await this.items.create(args.user, {
      type: 'data_layer',
      title: cleanTitle,
      ...(args.description
        ? { description: args.description.slice(0, 4000) }
        : {}),
      access: 'private',
      data: data as unknown as Prisma.InputJsonValue,
    });

    // Bulk-insert features into the new sublayer. The features
    // arrived as the OSM resolver's converted GeoJSON shape; the
    // engine's bulk-insert path accepts that directly.
    let inserted: { inserted: number };
    try {
      inserted = await this.features.insertFeatures(
        created.id,
        layerId,
        args.features.map((f) => ({
          properties: f.properties as Record<string, unknown>,
          geometry: geometryType === null ? null : (f.geometry as unknown),
        })),
        args.user,
      );
    } catch (err) {
      // Do not leave an empty, titled layer behind: each retry of a
      // failing save used to add another one to the user's content.
      try {
        await this.items.remove(args.user, created.id);
        await this.items.purge(args.user, created.id);
      } catch (cleanupErr) {
        this.log.warn(
          `Could not remove the empty layer ${created.id} after a failed OSM save: ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
      throw err;
    }

    this.log.log(
      `Saved OSM overlay as data_layer ${created.id} (layer ${layerId}, ${inserted.inserted} features).`,
    );

    return { itemId: created.id, layerId, inserted: inserted.inserted };
  }
}

/**
 * Walk the features and decide one geometry type for the whole
 * sublayer. Returns null only when every feature is geometry-less
 * (degenerate but acceptable - the result is an attribute-only
 * table). Mixed-geometry inputs throw; the caller would not get a
 * usable layer out the other end anyway because PostGIS columns
 * are typed.
 */
function inferGeometryType(features: OsmGeoJsonFeature[]): LayerGeometryType {
  const seen = new Set<LayerGeometryType>();
  for (const f of features) {
    const g = f.geometry;
    if (!g || typeof g !== 'object') {
      seen.add(null);
      continue;
    }
    switch (g.type) {
      case 'Point':
        seen.add('point');
        break;
      case 'LineString':
        seen.add('line');
        break;
      case 'Polygon':
      case 'MultiPolygon':
        seen.add('polygon');
        break;
      default:
        // Unknown shape: treat as missing so the row counts toward
        // the attribute-only branch rather than spawning a spurious
        // geometry type.
        seen.add(null);
        break;
    }
  }
  // Drop null when at least one real geometry was seen; mixed real
  // geometries leave more than one entry and trigger the refusal.
  if (seen.size > 1) seen.delete(null);
  if (seen.size > 1) {
    throw new BadRequestException(
      `Cannot save an OSM overlay with mixed geometry types (${[...seen].join(', ')}) as one data_layer; split the result by preset first.`,
    );
  }
  return [...seen][0] ?? null;
}

/**
 * Infer a FeatureField[] schema by walking every feature's
 * properties and tracking the seen types per key. The order of the
 * fields mirrors first-appearance in the input so a downstream
 * attribute table renders in a stable order regardless of which
 * property bag was emitted first by Overpass.
 *
 * Type promotion: number -> number; boolean -> boolean; everything
 * else falls to text. If the same key appears as different types
 * across features (rare in OSM), we promote to text to stay
 * round-trippable.
 */
function inferFields(features: OsmGeoJsonFeature[]): FeatureField[] {
  const order: string[] = [];
  const seenTypes = new Map<string, Set<'number' | 'boolean' | 'string'>>();
  for (const feat of features) {
    const props = feat.properties as Record<string, unknown> | null;
    if (!props) continue;
    for (const [key, val] of Object.entries(props)) {
      // Skip internal OSM bookkeeping keys the converter does not
      // emit (defensive; the resolver already strips these).
      if (key === '_global_id') continue;
      if (val === null || val === undefined) continue;
      if (!seenTypes.has(key)) {
        seenTypes.set(key, new Set());
        order.push(key);
      }
      const t =
        typeof val === 'number'
          ? 'number'
          : typeof val === 'boolean'
            ? 'boolean'
            : 'string';
      seenTypes.get(key)!.add(t);
    }
  }
  const fields: FeatureField[] = [];
  for (const key of order) {
    const types = seenTypes.get(key)!;
    let type: FeatureField['type'];
    if (types.size === 1) {
      const only = [...types][0]!;
      type = only === 'number' ? 'number' : only === 'boolean' ? 'boolean' : 'string';
    } else {
      // Mixed types -- flatten to string so the column accepts every
      // shape on round-trip.
      type = 'string';
    }
    fields.push({
      name: key,
      label: prettyLabel(key),
      type,
      nullable: true,
    });
  }
  return fields;
}

/** A UUIDv7-ish layer id minted client-free. */
function freshLayerId(): string {
  // Mint a v4 here -- v3 layer ids are stable strings, no need for
  // bitemporal ordering on the layer descriptor itself. Avoids
  // pulling in uuidv7() at the cost of a slightly less ordered id.
  const hex = (n: number) => Math.floor(Math.random() * n).toString(16);
  return `${hex(0xfffffff)}-${hex(0xffff)}-4${hex(0xfff)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(0xfff)}-${hex(0xfffffff)}${hex(0xffffff)}`;
}

/** Generate a stable, machine-friendly slug from the layer's title.
 *  Falls back to the layerId tail when the title sanitizes to empty
 *  so a title of `?` doesn't crash later code that uses `name` as
 *  part of a SQL identifier. */
function slugify(title: string, layerId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/-+/g, '_')
    .slice(0, 40);
  return slug.length > 0 ? slug : `osm_${layerId.split('-')[0]}`;
}

/** Render an OSM tag key as a friendly label for the field's UI
 *  surface (e.g. `addr:housenumber` -> `Addr housenumber`). */
function prettyLabel(key: string): string {
  return key
    .replace(/[:_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}
