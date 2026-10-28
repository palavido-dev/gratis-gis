// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Simplify shortcut for the Analyze workbench
 * (R7-analyze-simplify-shortcut).
 *
 * Mirrors Buffer: Analyze never invents an in-browser simplify.
 * It POSTs a single-step `derived_layer` recipe that runs
 * PostGIS `ST_Simplify` with a meter-honest tolerance.
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

/** Same soft ceiling as the simplify generator / buffer (100 km). */
export const MAX_SIMPLIFY_TOLERANCE_METERS = MAX_BUFFER_DISTANCE_METERS;

export interface SimplifyGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
  tolerance: number;
  unit: LengthUnit;
}

export interface SimplifyDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

/** Cap a user-entered tolerance so it never exceeds the shared soft max. */
export function clampSimplifyTolerance(
  tolerance: number,
  unit: LengthUnit,
): number {
  if (!Number.isFinite(tolerance) || tolerance <= 0) return 0;
  const meters = tolerance * METERS_PER_UNIT[unit];
  const capped = Math.min(meters, MAX_SIMPLIFY_TOLERANCE_METERS);
  return capped / METERS_PER_UNIT[unit];
}

/**
 * Validate simplify tolerance. Returns a plain-English reason when
 * unusable; null when ready to submit. The Analyze guide overlays
 * locale strings for empty / unit / max cases.
 */
export function validateSimplifyTolerance(
  tolerance: number,
  unit: LengthUnit,
): string | null {
  if (!LENGTH_UNITS.includes(unit)) {
    return 'Pick a tolerance unit.';
  }
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    return 'Enter a tolerance greater than zero.';
  }
  const meters = tolerance * METERS_PER_UNIT[unit];
  if (meters > MAX_SIMPLIFY_TOLERANCE_METERS) {
    return `Tolerance must be at most ${MAX_SIMPLIFY_TOLERANCE_METERS.toLocaleString('en-US')} m.`;
  }
  return null;
}

/** Single-step simplify recipe pointed at a data_layer source. */
export function buildSimplifyDerivedLayerData(
  input: SimplifyGuideInput,
): DerivedLayerData {
  const tolerance = clampSimplifyTolerance(input.tolerance, input.unit);
  return {
    version: 1,
    source: {
      kind: 'data_layer',
      itemId: input.sourceItemId,
      ...(input.layerKey ? { layerKey: input.layerKey } : {}),
    },
    pipeline: [
      {
        tool: 'simplify',
        params: {
          tolerance,
          unit: input.unit,
        },
      },
    ],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

/** Default title: "Parcels · 10 m simplify". */
export function defaultSimplifyDerivedLayerTitle(
  sourceLabel: string,
  tolerance: number,
  unit: LengthUnit,
): string {
  const label = sourceLabel.trim() || 'Layer';
  const n = Number.isFinite(tolerance) ? tolerance : 0;
  const pretty =
    Number.isInteger(n) || Math.abs(n - Math.round(n)) < 1e-9
      ? String(Math.round(n))
      : String(n);
  return `${label} · ${pretty} ${UNIT_LABELS[unit]} simplify`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildSimplifyDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
  tolerance: number;
  unit: LengthUnit;
}): SimplifyDerivedLayerCreatePayload {
  const title =
    args.title.trim() ||
    defaultSimplifyDerivedLayerTitle(
      args.sourceLabel,
      args.tolerance,
      args.unit,
    );
  return {
    type: 'derived_layer',
    title,
    description: `Server-side simplify of "${args.sourceLabel}" with ${args.tolerance} ${args.unit} tolerance via ST_Simplify. Created from the Analyze Simplify guide; runs as a PostGIS derived-layer job.`,
    tags: [],
    access: 'private',
    data: buildSimplifyDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
      tolerance: args.tolerance,
      unit: args.unit,
    }),
  };
}
