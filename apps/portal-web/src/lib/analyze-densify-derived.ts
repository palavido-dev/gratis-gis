// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Densify shortcut for the Analyze workbench
 * (R8-analyze-densify-shortcut).
 *
 * Mirrors Simplify / Buffer: Analyze never invents an in-browser
 * densify. It POSTs a single-step `derived_layer` recipe that runs
 * PostGIS `ST_Segmentize` on geography with a meter-honest
 * maxSegmentLength (min 1 m, soft max 100 km).
 */
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  LENGTH_UNITS,
  MAX_BUFFER_DISTANCE_METERS,
  METERS_PER_UNIT,
  UNIT_LABELS,
  type DerivedLayerData,
  type LengthUnit,
} from '@gratis-gis/shared-types';

/** Same soft ceiling as the densify generator / buffer (100 km). */
export const MAX_DENSIFY_SEGMENT_METERS = MAX_BUFFER_DISTANCE_METERS;

/** Same floor as the densify generator (1 m). */
export const MIN_DENSIFY_SEGMENT_METERS = 1;

export interface DensifyGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
  maxSegmentLength: number;
  unit: LengthUnit;
}

export interface DensifyDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

/** Cap a user-entered segment length so it never exceeds the soft max. */
export function clampDensifySegmentLength(
  maxSegmentLength: number,
  unit: LengthUnit,
): number {
  if (!Number.isFinite(maxSegmentLength) || maxSegmentLength <= 0) return 0;
  const meters = maxSegmentLength * METERS_PER_UNIT[unit];
  const capped = Math.min(meters, MAX_DENSIFY_SEGMENT_METERS);
  return capped / METERS_PER_UNIT[unit];
}

/**
 * Validate densify maxSegmentLength. Returns a plain-English reason
 * when unusable; null when ready to submit. The Analyze guide
 * overlays locale strings for empty / unit / min / max cases.
 */
export function validateDensifySegmentLength(
  maxSegmentLength: number,
  unit: LengthUnit,
): string | null {
  if (!LENGTH_UNITS.includes(unit)) {
    return 'Pick a segment-length unit.';
  }
  if (!Number.isFinite(maxSegmentLength) || maxSegmentLength <= 0) {
    return 'Enter a max segment length greater than zero.';
  }
  const meters = maxSegmentLength * METERS_PER_UNIT[unit];
  if (meters < MIN_DENSIFY_SEGMENT_METERS) {
    return `Max segment length must be at least ${MIN_DENSIFY_SEGMENT_METERS} m.`;
  }
  if (meters > MAX_DENSIFY_SEGMENT_METERS) {
    return `Max segment length must be at most ${MAX_DENSIFY_SEGMENT_METERS.toLocaleString('en-US')} m.`;
  }
  return null;
}

/** Single-step densify recipe pointed at a data_layer source. */
export function buildDensifyDerivedLayerData(
  input: DensifyGuideInput,
): DerivedLayerData {
  const maxSegmentLength = clampDensifySegmentLength(
    input.maxSegmentLength,
    input.unit,
  );
  return {
    version: 1,
    source: {
      kind: 'data_layer',
      itemId: input.sourceItemId,
      ...(input.layerKey ? { layerKey: input.layerKey } : {}),
    },
    pipeline: [
      {
        tool: 'densify',
        params: {
          maxSegmentLength,
          unit: input.unit,
        },
      },
    ],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

/** Default title: "Roads · 100 m densify". */
export function defaultDensifyDerivedLayerTitle(
  sourceLabel: string,
  maxSegmentLength: number,
  unit: LengthUnit,
): string {
  const label = sourceLabel.trim() || 'Layer';
  const n = Number.isFinite(maxSegmentLength) ? maxSegmentLength : 0;
  const pretty =
    Number.isInteger(n) || Math.abs(n - Math.round(n)) < 1e-9
      ? String(Math.round(n))
      : String(n);
  return `${label} · ${pretty} ${UNIT_LABELS[unit]} densify`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildDensifyDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
  maxSegmentLength: number;
  unit: LengthUnit;
}): DensifyDerivedLayerCreatePayload {
  const title =
    args.title.trim() ||
    defaultDensifyDerivedLayerTitle(
      args.sourceLabel,
      args.maxSegmentLength,
      args.unit,
    );
  return {
    type: 'derived_layer',
    title,
    description: `Server-side densify of "${args.sourceLabel}" with ${args.maxSegmentLength} ${args.unit} max segment length via ST_Segmentize on geography. Created from the Analyze Densify guide; runs as a PostGIS derived-layer job.`,
    tags: [],
    access: 'private',
    data: buildDensifyDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
      maxSegmentLength: args.maxSegmentLength,
      unit: args.unit,
    }),
  };
}
