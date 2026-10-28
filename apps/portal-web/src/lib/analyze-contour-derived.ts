// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Contour shortcut for the Analyze workbench
 * (R11-analyze-contour-shortcut).
 *
 * Analyze never invents in-browser TIN contours. It POSTs a
 * single-step `derived_layer` recipe with numeric field + auto
 * interval (+ optional min/max). Manual level lists stay in the
 * derived-layer builder. Point geometry only.
 */
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  type ContourStep,
  type DerivedLayerData,
  type FeatureField,
} from '@gratis-gis/shared-types';

/** Same hard cap as contourGenerator enrich. */
export const MAX_CONTOUR_LEVELS = 100;

export interface ContourGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
  field: string;
  interval: number;
  minLevel?: number;
  maxLevel?: number;
}

export interface ContourDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

export function numericFieldsForContour(
  fields: FeatureField[] | undefined,
): FeatureField[] {
  return (fields ?? []).filter((f) => f.type === 'number');
}

/**
 * Validate contour auto-mode params. Returns a plain-English reason
 * when unusable; null when ready to submit. The Analyze guide
 * overlays locale strings.
 */
export function validateContourParams(
  field: string,
  interval: number,
  fields: FeatureField[] | undefined,
  minLevel?: number,
  maxLevel?: number,
): string | null {
  const name = field.trim();
  if (!name) {
    return 'Pick a numeric field.';
  }
  const numeric = numericFieldsForContour(fields);
  const match = numeric.find((f) => f.name === name);
  if (!match) {
    return `Field "${name}" is not a numeric field on this layer.`;
  }
  if (!Number.isFinite(interval) || interval <= 0) {
    return 'Interval must be a positive number.';
  }
  const hasMin = minLevel !== undefined && Number.isFinite(minLevel);
  const hasMax = maxLevel !== undefined && Number.isFinite(maxLevel);
  if (minLevel !== undefined && !Number.isFinite(minLevel)) {
    return 'Min level must be a finite number when set.';
  }
  if (maxLevel !== undefined && !Number.isFinite(maxLevel)) {
    return 'Max level must be a finite number when set.';
  }
  if (hasMin && hasMax && (minLevel as number) >= (maxLevel as number)) {
    return 'Min level must be strictly less than max level.';
  }
  return null;
}

/** Single-step contour recipe (auto + interval) pointed at a data_layer. */
export function buildContourDerivedLayerData(
  input: ContourGuideInput,
): DerivedLayerData {
  const params: ContourStep['params'] = {
    field: input.field.trim(),
    mode: 'auto',
    interval: input.interval,
    ...(input.minLevel !== undefined && Number.isFinite(input.minLevel)
      ? { minLevel: input.minLevel }
      : {}),
    ...(input.maxLevel !== undefined && Number.isFinite(input.maxLevel)
      ? { maxLevel: input.maxLevel }
      : {}),
  };
  const step: ContourStep = { tool: 'contour', params };
  return {
    version: 1,
    source: {
      kind: 'data_layer',
      itemId: input.sourceItemId,
      ...(input.layerKey ? { layerKey: input.layerKey } : {}),
    },
    pipeline: [step],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

/** Default title: "Samples · contour elev_m @ 10". */
export function defaultContourDerivedLayerTitle(
  sourceLabel: string,
  field: string,
  interval: number,
): string {
  const label = sourceLabel.trim() || 'Layer';
  const f = field.trim() || 'field';
  const step = Number.isFinite(interval) && interval > 0 ? interval : 1;
  return `${label} · contour ${f} @ ${step}`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildContourDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
  field: string;
  interval: number;
  minLevel?: number;
  maxLevel?: number;
}): ContourDerivedLayerCreatePayload {
  const title =
    args.title.trim() ||
    defaultContourDerivedLayerTitle(
      args.sourceLabel,
      args.field,
      args.interval,
    );
  const rangeNote =
    args.minLevel !== undefined && args.maxLevel !== undefined
      ? ` Levels clipped to [${args.minLevel}, ${args.maxLevel}].`
      : args.minLevel !== undefined
        ? ` Min level ${args.minLevel}.`
        : args.maxLevel !== undefined
          ? ` Max level ${args.maxLevel}.`
          : '';
  return {
    type: 'derived_layer',
    title,
    description: `Server-side TIN iso-lines on "${args.field}" (auto interval ${args.interval}) of "${args.sourceLabel}". Created from the Analyze Contour guide; runs as a PostGIS derived-layer job. Line output with a level property only — not iso-polygons; dense point sets can be slow; about ${MAX_CONTOUR_LEVELS} levels max.${rangeNote}`,
    tags: [],
    access: 'private',
    data: buildContourDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
      field: args.field,
      interval: args.interval,
      ...(args.minLevel !== undefined ? { minLevel: args.minLevel } : {}),
      ...(args.maxLevel !== undefined ? { maxLevel: args.maxLevel } : {}),
    }),
  };
}
