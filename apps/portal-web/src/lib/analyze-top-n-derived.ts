// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Top N shortcut for the Analyze workbench
 * (R10-analyze-top-n-shortcut).
 *
 * Mirrors Calculate geometry / Densify: Analyze never invents an
 * in-browser top-N. It POSTs a single-step `derived_layer` recipe
 * with numeric field + n + asc|desc (same as topNGenerator).
 */
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  type DerivedLayerData,
  type FeatureField,
} from '@gratis-gis/shared-types';

/** Same hard cap as the top-n generator. */
export const MAX_TOP_N = 100_000;

export type TopNDirection = 'asc' | 'desc';

export interface TopNGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
  field: string;
  n: number;
  direction: TopNDirection;
}

export interface TopNDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

export function numericFieldsForTopN(
  fields: FeatureField[] | undefined,
): FeatureField[] {
  return (fields ?? []).filter((f) => f.type === 'number');
}

/**
 * Validate top-n params. Returns a plain-English reason when
 * unusable; null when ready to submit. The Analyze guide overlays
 * locale strings.
 */
export function validateTopNParams(
  field: string,
  n: number,
  direction: TopNDirection,
  fields: FeatureField[] | undefined,
): string | null {
  if (direction !== 'asc' && direction !== 'desc') {
    return 'Pick ascending or descending.';
  }
  const name = field.trim();
  if (!name) {
    return 'Pick a numeric field.';
  }
  const numeric = numericFieldsForTopN(fields);
  const match = numeric.find((f) => f.name === name);
  if (!match) {
    return `Field "${name}" is not a numeric field on this layer.`;
  }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return 'N must be a positive integer.';
  }
  if (n > MAX_TOP_N) {
    return `N must be at most ${MAX_TOP_N.toLocaleString('en-US')}.`;
  }
  return null;
}

/** Single-step top-n recipe pointed at a data_layer source. */
export function buildTopNDerivedLayerData(
  input: TopNGuideInput,
): DerivedLayerData {
  return {
    version: 1,
    source: {
      kind: 'data_layer',
      itemId: input.sourceItemId,
      ...(input.layerKey ? { layerKey: input.layerKey } : {}),
    },
    pipeline: [
      {
        tool: 'top-n',
        params: {
          field: input.field.trim(),
          n: input.n,
          direction: input.direction,
        },
      },
    ],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

/** Default title: "Parcels · top 10 acres desc". */
export function defaultTopNDerivedLayerTitle(
  sourceLabel: string,
  field: string,
  n: number,
  direction: TopNDirection,
): string {
  const label = sourceLabel.trim() || 'Layer';
  const f = field.trim() || 'field';
  const count = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
  return `${label} · top ${count} ${f} ${direction}`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildTopNDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
  field: string;
  n: number;
  direction: TopNDirection;
}): TopNDerivedLayerCreatePayload {
  const title =
    args.title.trim() ||
    defaultTopNDerivedLayerTitle(
      args.sourceLabel,
      args.field,
      args.n,
      args.direction,
    );
  return {
    type: 'derived_layer',
    title,
    description: `Server-side top ${args.n} by "${args.field}" (${args.direction}) of "${args.sourceLabel}". Created from the Analyze Top N guide; runs as a PostGIS derived-layer job. NULLs sort last.`,
    tags: [],
    access: 'private',
    data: buildTopNDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
      field: args.field,
      n: args.n,
      direction: args.direction,
    }),
  };
}
