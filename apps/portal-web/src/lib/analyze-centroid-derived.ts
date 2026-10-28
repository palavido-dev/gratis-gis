// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Centroid shortcut for the Analyze workbench
 * (R6-analyze-centroid-shortcut).
 *
 * `centroidGenerator` already ships a no-param PostGIS
 * `ST_Centroid` step. Analyze never invents an in-browser
 * centroid path; it POSTs a single-step `derived_layer` recipe
 * pointed at the current data_layer, labeled as a server job.
 */
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  type DerivedLayerData,
} from '@gratis-gis/shared-types';

export interface CentroidGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
}

export interface CentroidDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

/** Single-step centroid recipe pointed at a data_layer source. */
export function buildCentroidDerivedLayerData(
  input: CentroidGuideInput,
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
        tool: 'centroid',
        params: {},
      },
    ],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

/** Default title: "Parcels · centroids". */
export function defaultCentroidDerivedLayerTitle(sourceLabel: string): string {
  const src = sourceLabel.trim() || 'Layer';
  return `${src} · centroids`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildCentroidDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
}): CentroidDerivedLayerCreatePayload {
  const title =
    args.title.trim() || defaultCentroidDerivedLayerTitle(args.sourceLabel);
  return {
    type: 'derived_layer',
    title,
    description: `Server-side centroids of "${args.sourceLabel}" via ST_Centroid. Created from the Analyze Centroid guide; runs as a PostGIS derived-layer job. Geometric centroid only (not pole of inaccessibility).`,
    tags: [],
    access: 'private',
    data: buildCentroidDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
    }),
  };
}
