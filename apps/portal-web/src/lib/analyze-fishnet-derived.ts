// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Fishnet shortcut for the Analyze workbench
 * (R10-analyze-fishnet-shortcut).
 *
 * Mirrors Densify / Buffer: Analyze never invents an in-browser
 * fishnet. It POSTs a single-step `derived_layer` recipe that runs
 * PostGIS `ST_SquareGrid` with cellSize + unit + polygons|lines.
 * Polygon-only at the Analyze chip; save-time MAX_CELLS (~1e6)
 * honesty stays on the server enrich hook.
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

/** Same soft ceiling as the fishnet generator / buffer (100 km). */
export const MAX_FISHNET_CELL_METERS = MAX_BUFFER_DISTANCE_METERS;

/** Same floor as the fishnet generator (1 m). */
export const MIN_FISHNET_CELL_METERS = 1;

/** Mirrors server MAX_CELLS_PER_RECIPE for UI honesty (not enforced client-side). */
export const FISHNET_MAX_CELLS_HINT = 1_000_000;

export type FishnetOutput = 'polygons' | 'lines';

export interface FishnetGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
  cellSize: number;
  unit: LengthUnit;
  output: FishnetOutput;
}

export interface FishnetDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

/** Cap a user-entered cell size so it never exceeds the soft max. */
export function clampFishnetCellSize(
  cellSize: number,
  unit: LengthUnit,
): number {
  if (!Number.isFinite(cellSize) || cellSize <= 0) return 0;
  const meters = cellSize * METERS_PER_UNIT[unit];
  const capped = Math.min(meters, MAX_FISHNET_CELL_METERS);
  return capped / METERS_PER_UNIT[unit];
}

/**
 * Validate fishnet cell size. Returns a plain-English reason when
 * unusable; null when ready to submit. The Analyze guide overlays
 * locale strings for empty / unit / min / max / output cases.
 */
export function validateFishnetCellSize(
  cellSize: number,
  unit: LengthUnit,
  output: FishnetOutput,
): string | null {
  if (output !== 'polygons' && output !== 'lines') {
    return 'Pick polygons or lines output.';
  }
  if (!LENGTH_UNITS.includes(unit)) {
    return 'Pick a cell-size unit.';
  }
  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    return 'Enter a cell size greater than zero.';
  }
  const meters = cellSize * METERS_PER_UNIT[unit];
  if (meters < MIN_FISHNET_CELL_METERS) {
    return `Cell size must be at least ${MIN_FISHNET_CELL_METERS} m.`;
  }
  if (meters > MAX_FISHNET_CELL_METERS) {
    return `Cell size must be at most ${MAX_FISHNET_CELL_METERS.toLocaleString('en-US')} m.`;
  }
  return null;
}

/** Single-step fishnet recipe pointed at a data_layer source. */
export function buildFishnetDerivedLayerData(
  input: FishnetGuideInput,
): DerivedLayerData {
  const cellSize = clampFishnetCellSize(input.cellSize, input.unit);
  return {
    version: 1,
    source: {
      kind: 'data_layer',
      itemId: input.sourceItemId,
      ...(input.layerKey ? { layerKey: input.layerKey } : {}),
    },
    pipeline: [
      {
        tool: 'fishnet',
        params: {
          cellSize,
          unit: input.unit,
          output: input.output,
        },
      },
    ],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

/** Default title: "City · 500 m fishnet polygons". */
export function defaultFishnetDerivedLayerTitle(
  sourceLabel: string,
  cellSize: number,
  unit: LengthUnit,
  output: FishnetOutput,
): string {
  const label = sourceLabel.trim() || 'Layer';
  const n = Number.isFinite(cellSize) ? cellSize : 0;
  const pretty =
    Number.isInteger(n) || Math.abs(n - Math.round(n)) < 1e-9
      ? String(Math.round(n))
      : String(n);
  return `${label} · ${pretty} ${UNIT_LABELS[unit]} fishnet ${output}`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildFishnetDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
  cellSize: number;
  unit: LengthUnit;
  output: FishnetOutput;
}): FishnetDerivedLayerCreatePayload {
  const title =
    args.title.trim() ||
    defaultFishnetDerivedLayerTitle(
      args.sourceLabel,
      args.cellSize,
      args.unit,
      args.output,
    );
  return {
    type: 'derived_layer',
    title,
    description: `Server-side fishnet of "${args.sourceLabel}" with ${args.cellSize} ${args.unit} cells (${args.output}) via ST_SquareGrid. Created from the Analyze Fishnet guide; runs as a PostGIS derived-layer job. Polygon sources only; very fine grids may hit the ~1e6 cell save-time cap.`,
    tags: [],
    access: 'private',
    data: buildFishnetDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
      cellSize: args.cellSize,
      unit: args.unit,
      output: args.output,
    }),
  };
}
