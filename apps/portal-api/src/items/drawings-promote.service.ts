// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_DATA_LAYER_V3,
  type DataLayerDataV3,
  type DataLayerSublayer,
  type DrawingFeature,
  type DrawingSet,
  type FeatureField,
  type LayerGeometryType,
} from '@gratis-gis/shared-types';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { DataLayerFeaturesService } from '../data-layer/features.service.js';
import { ItemsService } from './items.service.js';
import { DrawingsService, type DrawingsAuthor } from './drawings.service.js';

/**
 * Promote a drawing set to a real data_layer (#154 Phase 1.5).
 *
 * Mirrors the OSM save-as-layer path: create a v3 data_layer the
 * caller owns, infer one sublayer per geometry family present in
 * the set (point / line / polygon), then bulk-insert the features.
 * Mixed-geometry markup is the common case for a review round that
 * mixes pins and sketched boundaries, so one item with multiple
 * sublayers beats refusing the promote or spawning three items.
 *
 * The drawing set itself is left in place. Promotion is a copy, not
 * a move: reviewers keep their redlines while GIS gets a durable
 * layer they can style, share, and query.
 */
@Injectable()
export class DrawingsPromoteService {
  private readonly log = new Logger(DrawingsPromoteService.name);

  constructor(
    private readonly drawings: DrawingsService,
    private readonly items: ItemsService,
    private readonly features: DataLayerFeaturesService,
  ) {}

  async promote(args: {
    user: AuthUser;
    mapId: string;
    drawingId: string;
    title?: string;
  }): Promise<{
    itemId: string;
    layers: Array<{
      layerId: string;
      geometryType: LayerGeometryType;
      inserted: number;
    }>;
    inserted: number;
  }> {
    const author: DrawingsAuthor = { kind: 'user', user: args.user };
    // Authors can promote their own set; map editors can promote
    // anyone's (same posture as update / delete).
    const set = await this.drawings.requireWritableSet(
      author,
      args.mapId,
      args.drawingId,
    );
    if (set.features.length === 0) {
      throw new BadRequestException(
        'This markup set has no features to promote.',
      );
    }

    const cleanTitle = (
      typeof args.title === 'string' && args.title.trim().length > 0
        ? args.title.trim()
        : set.title
    ).slice(0, 200);

    const buckets = bucketByGeometry(set.features);
    if (buckets.length === 0) {
      throw new BadRequestException(
        'This markup set has no promotable geometries.',
      );
    }

    const sublayers: DataLayerSublayer[] = buckets.map((b) => {
      const layerId = randomUUID();
      const label =
        buckets.length === 1
          ? cleanTitle
          : `${cleanTitle} (${geometryLabel(b.geometryType)})`;
      return {
        id: layerId,
        label,
        name: slugify(label, layerId),
        geometryType: b.geometryType,
        fields: inferDrawingFields(b.features),
        editingEnabled: true,
        attachmentsEnabled: false,
      };
    });

    const data: DataLayerDataV3 = {
      ...DEFAULT_DATA_LAYER_V3,
      layers: sublayers,
    };

    const created = await this.items.create(args.user, {
      type: 'data_layer',
      title: cleanTitle,
      description: `Promoted from markup "${set.title}" on map ${args.mapId}`,
      access: 'private',
      data: data as unknown as Prisma.InputJsonValue,
    });

    const layerResults: Array<{
      layerId: string;
      geometryType: LayerGeometryType;
      inserted: number;
    }> = [];
    let totalInserted = 0;

    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i]!;
      const sub = sublayers[i]!;
      const inserted = await this.features.insertFeatures(
        created.id,
        sub.id,
        bucket.features.map((f) => ({
          globalId: f.id,
          properties: {
            kind: f.kind,
            ...(typeof f.label === 'string' ? { label: f.label } : {}),
            ...(typeof f.note === 'string' ? { note: f.note } : {}),
            markup_set_id: set.id,
            markup_author: set.authorDisplay,
          },
          geometry: f.geometry as unknown,
        })),
        args.user,
      );
      layerResults.push({
        layerId: sub.id,
        geometryType: bucket.geometryType,
        inserted: inserted.inserted,
      });
      totalInserted += inserted.inserted;
    }

    this.log.log(
      `Promoted drawing set ${set.id} on map ${args.mapId} to data_layer ${created.id} (${totalInserted} features, ${layerResults.length} sublayer(s)).`,
    );

    return {
      itemId: created.id,
      layers: layerResults,
      inserted: totalInserted,
    };
  }
}

type GeometryBucket = {
  geometryType: Exclude<LayerGeometryType, null>;
  features: DrawingFeature[];
};

function bucketByGeometry(features: DrawingFeature[]): GeometryBucket[] {
  const map = new Map<Exclude<LayerGeometryType, null>, DrawingFeature[]>();
  for (const f of features) {
    const gt = geometryTypeOf(f);
    if (!gt) continue;
    const list = map.get(gt) ?? [];
    list.push(f);
    map.set(gt, list);
  }
  const order: Array<Exclude<LayerGeometryType, null>> = [
    'point',
    'line',
    'polygon',
  ];
  const out: GeometryBucket[] = [];
  for (const gt of order) {
    const feats = map.get(gt);
    if (feats && feats.length > 0) {
      out.push({ geometryType: gt, features: feats });
    }
  }
  return out;
}

function geometryTypeOf(
  f: DrawingFeature,
): Exclude<LayerGeometryType, null> | null {
  const geom = f.geometry as { type?: string } | null | undefined;
  if (!geom || typeof geom.type !== 'string') return null;
  switch (geom.type) {
    case 'Point':
    case 'MultiPoint':
      return 'point';
    case 'LineString':
    case 'MultiLineString':
      return 'line';
    case 'Polygon':
    case 'MultiPolygon':
      return 'polygon';
    default:
      return null;
  }
}

function geometryLabel(gt: Exclude<LayerGeometryType, null>): string {
  switch (gt) {
    case 'point':
      return 'points';
    case 'line':
      return 'lines';
    case 'polygon':
      return 'polygons';
  }
}

function inferDrawingFields(features: DrawingFeature[]): FeatureField[] {
  // Markup always carries kind + optional label/note; provenance
  // fields help the GIS owner see where a row came from after
  // promote. Keep the schema small: drawings are not symbology.
  const hasLabel = features.some((f) => typeof f.label === 'string');
  const hasNote = features.some((f) => typeof f.note === 'string');
  const fields: FeatureField[] = [
    { name: 'kind', label: 'Kind', type: 'string', nullable: false },
  ];
  if (hasLabel) {
    fields.push({
      name: 'label',
      label: 'Label',
      type: 'string',
      nullable: true,
    });
  }
  if (hasNote) {
    fields.push({
      name: 'note',
      label: 'Note',
      type: 'string',
      nullable: true,
    });
  }
  fields.push(
    {
      name: 'markup_set_id',
      label: 'Markup set id',
      type: 'string',
      nullable: true,
    },
    {
      name: 'markup_author',
      label: 'Markup author',
      type: 'string',
      nullable: true,
    },
  );
  return fields;
}

function slugify(title: string, layerId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/-+/g, '_')
    .slice(0, 40);
  return slug.length > 0 ? slug : `markup_${layerId.split('-')[0]}`;
}
