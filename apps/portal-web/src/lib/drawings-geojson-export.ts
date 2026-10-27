// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Client-side GeoJSON export for a markup drawing set (#154 export
 * surface / R4-drawings-geojson-export).
 *
 * Features are already hydrated on the Markup panel, so export is a
 * pure FeatureCollection build + browser download — no round-trip.
 * Properties mirror the promote path (kind / label / note + set
 * provenance) plus the set color so a downloaded file stays useful
 * in QGIS without needing the map context.
 */
import type { DrawingFeature, DrawingSet } from '@gratis-gis/shared-types';

export type DrawingGeoJsonFeature = {
  type: 'Feature';
  id: string;
  geometry: GeoJSON.Geometry;
  properties: {
    kind: DrawingFeature['kind'];
    label: string | null;
    note: string | null;
    color: string;
    markup_set_id: string;
    markup_set_title: string;
    markup_author: string;
  };
};

export type DrawingGeoJsonFeatureCollection = {
  type: 'FeatureCollection';
  features: DrawingGeoJsonFeature[];
};

/**
 * Build a GeoJSON FeatureCollection from one drawing set. Skips
 * features with missing geometry (same posture as the overlay
 * flattener). Does not invent arrow-tip helper Points — those are
 * render-only.
 */
export function drawingSetToFeatureCollection(
  set: Pick<
    DrawingSet,
    'id' | 'title' | 'color' | 'authorDisplay' | 'features'
  >,
): DrawingGeoJsonFeatureCollection {
  const features: DrawingGeoJsonFeature[] = [];
  for (const f of set.features) {
    if (!isGeoJsonGeometry(f.geometry)) continue;
    features.push({
      type: 'Feature',
      id: f.id,
      geometry: f.geometry,
      properties: {
        kind: f.kind,
        label: typeof f.label === 'string' ? f.label : null,
        note: typeof f.note === 'string' ? f.note : null,
        color: f.style?.color ?? set.color,
        markup_set_id: set.id,
        markup_set_title: set.title,
        markup_author: set.authorDisplay,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

function isGeoJsonGeometry(value: unknown): value is GeoJSON.Geometry {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'Point' ||
    type === 'MultiPoint' ||
    type === 'LineString' ||
    type === 'MultiLineString' ||
    type === 'Polygon' ||
    type === 'MultiPolygon' ||
    type === 'GeometryCollection'
  );
}

/** Strip filesystem-unsafe characters for a download basename. */
export function sanitizeDrawingExportFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : 'markup';
}

/**
 * Trigger a browser download of the set as `.geojson`. Safe to call
 * from a click handler; no-ops when every feature lacks geometry.
 */
export function downloadDrawingSetGeoJson(
  set: Pick<
    DrawingSet,
    'id' | 'title' | 'color' | 'authorDisplay' | 'features'
  >,
): { downloaded: boolean; featureCount: number } {
  const fc = drawingSetToFeatureCollection(set);
  if (fc.features.length === 0) {
    return { downloaded: false, featureCount: 0 };
  }
  const blob = new Blob([JSON.stringify(fc, null, 2)], {
    type: 'application/geo+json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeDrawingExportFilename(set.title)}.geojson`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { downloaded: true, featureCount: fc.features.length };
}
