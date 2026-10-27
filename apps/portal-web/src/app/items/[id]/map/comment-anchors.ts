// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Helpers for Phase 2 comment pins: resolve a thread's parent to a
 * WGS84 point the canvas can paint, and describe the anchor for the
 * comments panel chip.
 */
import {
  decodeFeatureCommentParent,
  type CommentParentKind,
  type DrawingSet,
} from '@gratis-gis/shared-types';

export type CommentAnchor = {
  parentKind: Exclude<CommentParentKind, 'map'>;
  parentId: string;
  /** Short label for the compose box / thread chip. */
  label: string;
};

export function centroidOfGeometry(
  geometry: GeoJSON.Geometry | null | undefined,
): [number, number] | null {
  if (!geometry) return null;
  switch (geometry.type) {
    case 'Point':
      return [geometry.coordinates[0]!, geometry.coordinates[1]!];
    case 'MultiPoint':
      return geometry.coordinates[0]
        ? [geometry.coordinates[0][0]!, geometry.coordinates[0][1]!]
        : null;
    case 'LineString':
      return midpoint(geometry.coordinates);
    case 'MultiLineString': {
      const first = geometry.coordinates[0];
      return first ? midpoint(first) : null;
    }
    case 'Polygon': {
      const ring = geometry.coordinates[0];
      return ring ? ringCentroid(ring) : null;
    }
    case 'MultiPolygon': {
      const ring = geometry.coordinates[0]?.[0];
      return ring ? ringCentroid(ring) : null;
    }
    case 'GeometryCollection':
      for (const g of geometry.geometries) {
        const c = centroidOfGeometry(g);
        if (c) return c;
      }
      return null;
    default:
      return null;
  }
}

function midpoint(coords: GeoJSON.Position[]): [number, number] | null {
  if (coords.length === 0) return null;
  const mid = coords[Math.floor(coords.length / 2)]!;
  return [mid[0]!, mid[1]!];
}

function ringCentroid(ring: GeoJSON.Position[]): [number, number] | null {
  if (ring.length === 0) return null;
  // Cheap average of vertices (skip the closing duplicate if present).
  const pts =
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1]
      ? ring.slice(0, -1)
      : ring;
  if (pts.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p[0]!;
    sy += p[1]!;
  }
  return [sx / pts.length, sy / pts.length];
}

/**
 * Resolve a thread parent to a map pin position. Returns null for
 * map-level threads or when the geometry is not loaded yet.
 */
export function resolveCommentPin(args: {
  parentKind: CommentParentKind;
  parentId: string;
  featuresByLayer: Record<string, GeoJSON.FeatureCollection | null | undefined>;
  drawings: DrawingSet[];
}): [number, number] | null {
  if (args.parentKind === 'map' || args.parentKind === 'layer') return null;
  if (args.parentKind === 'drawing') {
    for (const set of args.drawings) {
      const f = set.features.find((x) => x.id === args.parentId);
      if (f) return centroidOfGeometry(f.geometry as GeoJSON.Geometry);
    }
    return null;
  }
  const decoded = decodeFeatureCommentParent(args.parentId);
  if (!decoded) return null;
  const fc = args.featuresByLayer[decoded.mapLayerId];
  if (!fc) return null;
  const feature = fc.features.find((f) => {
    const id = f.id ?? f.properties?.['_global_id'] ?? f.properties?.['id'];
    return id !== undefined && String(id) === decoded.featureId;
  });
  return feature
    ? centroidOfGeometry(feature.geometry as GeoJSON.Geometry)
    : null;
}

/** Single selected feature from the shared selection map, if any. */
export function singleSelectionAnchor(
  selection: Record<string, Set<number | string>>,
  layers: Array<{ id: string; title: string }>,
): CommentAnchor | null {
  const picks: Array<{ layerId: string; featureId: string | number }> = [];
  for (const [layerId, ids] of Object.entries(selection)) {
    for (const id of ids) picks.push({ layerId, featureId: id });
    if (picks.length > 1) return null;
  }
  if (picks.length !== 1) return null;
  const pick = picks[0]!;
  const layer = layers.find((l) => l.id === pick.layerId);
  return {
    parentKind: 'feature',
    parentId: `${pick.layerId}:${String(pick.featureId)}`,
    label: layer
      ? `${layer.title} · ${String(pick.featureId)}`
      : String(pick.featureId),
  };
}
