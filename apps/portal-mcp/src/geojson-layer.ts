// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Helpers for create_data_layer_from_geojson (#161 Phase 2).
 *
 * Mirror the OSM save-as-layer inference so MCP can POST a v3
 * data_layer schema + append batches without new Nest endpoints.
 * Feature payloads for POST .../features must be
 * { globalId?, geometry?, properties? } (Nest whitelist).
 */

export type LayerGeometryType = 'point' | 'line' | 'polygon' | null;

export type FieldType = 'string' | 'number' | 'boolean';

export interface InferredField {
  name: string;
  label: string;
  type: FieldType;
  nullable: boolean;
}

export interface GeoJsonFeatureInput {
  type?: 'Feature';
  id?: string | number;
  geometry?: unknown;
  properties?: Record<string, unknown> | null;
}

export interface AppendFeature {
  globalId?: string;
  geometry?: unknown;
  properties?: Record<string, unknown>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const APPEND_BATCH_SIZE = 5000;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function inferGeometryType(
  features: GeoJsonFeatureInput[],
): LayerGeometryType {
  const seen = new Set<LayerGeometryType>();
  for (const f of features) {
    const g = f.geometry;
    if (!g || typeof g !== 'object') {
      seen.add(null);
      continue;
    }
    const t = (g as { type?: unknown }).type;
    switch (t) {
      case 'Point':
      case 'MultiPoint':
        seen.add('point');
        break;
      case 'LineString':
      case 'MultiLineString':
        seen.add('line');
        break;
      case 'Polygon':
      case 'MultiPolygon':
        seen.add('polygon');
        break;
      default:
        seen.add(null);
        break;
    }
  }
  if (seen.size > 1) seen.delete(null);
  if (seen.size > 1) {
    throw new Error(
      `Cannot create a data_layer with mixed geometry types (${[...seen].join(', ')}); split the FeatureCollection first.`,
    );
  }
  return [...seen][0] ?? null;
}

export function inferFields(features: GeoJsonFeatureInput[]): InferredField[] {
  const order: string[] = [];
  const seenTypes = new Map<string, Set<FieldType>>();
  for (const feat of features) {
    const props = feat.properties;
    if (!props || typeof props !== 'object') continue;
    for (const [key, val] of Object.entries(props)) {
      if (val === null || val === undefined) continue;
      if (!seenTypes.has(key)) {
        seenTypes.set(key, new Set());
        order.push(key);
      }
      const t: FieldType =
        typeof val === 'number'
          ? 'number'
          : typeof val === 'boolean'
            ? 'boolean'
            : 'string';
      seenTypes.get(key)!.add(t);
    }
  }
  return order.map((key) => {
    const types = seenTypes.get(key)!;
    let type: FieldType = 'string';
    if (types.size === 1) {
      type = [...types][0]!;
    }
    return {
      name: key,
      label: prettyLabel(key),
      type,
      nullable: true,
    };
  });
}

export function prettyLabel(key: string): string {
  return key
    .replace(/[:_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

export function slugify(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/-+/g, '_')
    .slice(0, 40);
  return slug.length > 0 ? slug : fallback;
}

/** Map GeoJSON Features to the Nest append DTO (strips type / id). */
export function toAppendFeatures(
  features: GeoJsonFeatureInput[],
): AppendFeature[] {
  return features.map((f) => {
    const out: AppendFeature = {};
    if (typeof f.id === 'string' && isUuid(f.id)) {
      out.globalId = f.id;
    }
    if (f.geometry !== undefined && f.geometry !== null) {
      out.geometry = f.geometry;
    }
    if (f.properties && typeof f.properties === 'object') {
      out.properties = f.properties;
    }
    return out;
  });
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error('chunk size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function buildV3LayerData(args: {
  layerId: string;
  label: string;
  geometryType: LayerGeometryType;
  fields: InferredField[];
}): {
  version: 3;
  storageType: 'postgis';
  layers: Array<{
    id: string;
    label: string;
    name: string;
    geometryType: LayerGeometryType;
    fields: InferredField[];
    editingEnabled: boolean;
    attachmentsEnabled: boolean;
  }>;
} {
  return {
    version: 3,
    storageType: 'postgis',
    layers: [
      {
        id: args.layerId,
        label: args.label,
        name: slugify(args.label, args.layerId),
        geometryType: args.geometryType,
        fields: args.fields,
        editingEnabled: false,
        attachmentsEnabled: false,
      },
    ],
  };
}
