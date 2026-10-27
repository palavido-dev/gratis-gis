// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Buffer shortcut for the Analyze workbench
 * (R4-analyze-buffer-derived).
 *
 * DuckDB-WASM correctly refuses meter buffers without PROJ data in
 * the browser build. Rather than invent a second buffer engine, this
 * helper builds a single-step `derived_layer` recipe that reuses the
 * existing PostGIS buffer tool. The Analyze UI posts the payload
 * through the same `POST /api/portal/items` path the new-item wizard
 * uses.
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

export interface FixedBufferGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
  distance: number;
  unit: LengthUnit;
}

export interface BufferDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

/** Cap a user-entered distance so it never exceeds the shared soft max. */
export function clampBufferDistance(
  distance: number,
  unit: LengthUnit,
): number {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  const meters = distance * METERS_PER_UNIT[unit];
  const capped = Math.min(meters, MAX_BUFFER_DISTANCE_METERS);
  return capped / METERS_PER_UNIT[unit];
}

/**
 * Validate a fixed buffer distance. Returns a plain-English reason
 * when the value is unusable; null when it is ready to submit.
 */
export function validateFixedBufferDistance(
  distance: number,
  unit: LengthUnit,
): string | null {
  if (!LENGTH_UNITS.includes(unit)) {
    return 'Pick a distance unit.';
  }
  if (!Number.isFinite(distance) || distance <= 0) {
    return 'Enter a distance greater than zero.';
  }
  const meters = distance * METERS_PER_UNIT[unit];
  if (meters > MAX_BUFFER_DISTANCE_METERS) {
    return `Distance must be at most ${MAX_BUFFER_DISTANCE_METERS.toLocaleString('en-US')} m.`;
  }
  return null;
}

/** Single-step buffer recipe pointed at a data_layer source. */
export function buildFixedBufferDerivedLayerData(
  input: FixedBufferGuideInput,
): DerivedLayerData {
  const distance = clampBufferDistance(input.distance, input.unit);
  return {
    version: 1,
    source: {
      kind: 'data_layer',
      itemId: input.sourceItemId,
      ...(input.layerKey ? { layerKey: input.layerKey } : {}),
    },
    pipeline: [
      {
        tool: 'buffer',
        params: {
          mode: 'fixed',
          distance,
          unit: input.unit,
        },
      },
    ],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    // Server recomputes schema + bbox on save; placeholders match the
    // wizard's empty-hint convention.
    outputSchema: [],
    bbox: [],
  };
}

/** Default title for a guided buffer: "Hydrants · 300 ft buffer". */
export function defaultBufferDerivedLayerTitle(
  sourceLabel: string,
  distance: number,
  unit: LengthUnit,
): string {
  const label = sourceLabel.trim() || 'Layer';
  const n = Number.isFinite(distance) ? distance : 0;
  const pretty =
    Number.isInteger(n) || Math.abs(n - Math.round(n)) < 1e-9
      ? String(Math.round(n))
      : String(n);
  return `${label} · ${pretty} ${UNIT_LABELS[unit]} buffer`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildBufferDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
  distance: number;
  unit: LengthUnit;
}): BufferDerivedLayerCreatePayload {
  const title = args.title.trim() || defaultBufferDerivedLayerTitle(
    args.sourceLabel,
    args.distance,
    args.unit,
  );
  return {
    type: 'derived_layer',
    title,
    description: `Server-side buffer of "${args.sourceLabel}" by ${args.distance} ${args.unit}. Created from the Analyze Buffer guide so meter distances stay honest on PostGIS.`,
    tags: [],
    access: 'private',
    data: buildFixedBufferDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
      distance: args.distance,
      unit: args.unit,
    }),
  };
}
