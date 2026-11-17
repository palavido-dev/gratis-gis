// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Nearest neighbor shortcut for the Analyze workbench
 * (R10-analyze-nearest-neighbor-shortcut).
 *
 * `nearestNeighborGenerator` already ships a no-param PostGIS
 * self-join that adds `nearest_distance_m`. Analyze never invents
 * an in-browser proximity path; it POSTs a single-step
 * `derived_layer` recipe pointed at the current data_layer,
 * labeled as a server job (O(N²), single-row NULL).
 */
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  type DerivedLayerData,
} from '@gratis-gis/shared-types';

export interface NearestNeighborGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
}

export interface NearestNeighborDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

/** Single-step nearest-neighbor recipe pointed at a data_layer source. */
export function buildNearestNeighborDerivedLayerData(
  input: NearestNeighborGuideInput,
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
        tool: 'nearest-neighbor',
        params: {},
      },
    ],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

/** Default title: "Wells · nearest neighbor". */
export function defaultNearestNeighborDerivedLayerTitle(
  sourceLabel: string,
): string {
  const src = sourceLabel.trim() || 'Layer';
  return `${src} · nearest neighbor`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildNearestNeighborDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
}): NearestNeighborDerivedLayerCreatePayload {
  const title =
    args.title.trim() ||
    defaultNearestNeighborDerivedLayerTitle(args.sourceLabel);
  return {
    type: 'derived_layer',
    title,
    description: `Server-side nearest_distance_m for "${args.sourceLabel}" via geography self-join (ST_Distance). Created from the Analyze Nearest neighbor guide; runs as a PostGIS derived-layer job. Same-layer only; O(N²); single-row inputs yield NULL.`,
    tags: [],
    access: 'private',
    data: buildNearestNeighborDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
    }),
  };
}
