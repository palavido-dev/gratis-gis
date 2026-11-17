// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Convex hull shortcut for the Analyze workbench
 * (R8-analyze-convex-hull-shortcut).
 *
 * `convexHullGenerator` already ships a no-param PostGIS
 * `ST_ConvexHull` step (per-feature). Analyze never invents an
 * in-browser hull path; it POSTs a single-step `derived_layer`
 * recipe pointed at the current data_layer, labeled as a server
 * job. One hull for the whole layer is not this path — use
 * dissolve / group-by when you need an aggregate shape.
 */
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  type DerivedLayerData,
} from '@gratis-gis/shared-types';

export interface ConvexHullGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
}

export interface ConvexHullDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

/** Single-step convex-hull recipe pointed at a data_layer source. */
export function buildConvexHullDerivedLayerData(
  input: ConvexHullGuideInput,
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
        tool: 'convex-hull',
        params: {},
      },
    ],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

/** Default title: "Parcels · convex hulls". */
export function defaultConvexHullDerivedLayerTitle(sourceLabel: string): string {
  const src = sourceLabel.trim() || 'Layer';
  return `${src} · convex hulls`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildConvexHullDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
}): ConvexHullDerivedLayerCreatePayload {
  const title =
    args.title.trim() || defaultConvexHullDerivedLayerTitle(args.sourceLabel);
  return {
    type: 'derived_layer',
    title,
    description: `Server-side per-feature convex hulls of "${args.sourceLabel}" via ST_ConvexHull. Created from the Analyze Convex hull guide; runs as a PostGIS derived-layer job. Not one hull for the whole layer.`,
    tags: [],
    access: 'private',
    data: buildConvexHullDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
    }),
  };
}
