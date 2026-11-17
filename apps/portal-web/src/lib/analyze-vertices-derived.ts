// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Vertices shortcut for the Analyze workbench
 * (R9-analyze-vertices-shortcut).
 *
 * `verticesGenerator` already ships a no-param PostGIS
 * `ST_DumpPoints` step (adds `vertex_index`). Analyze never
 * invents an in-browser explode; it POSTs a single-step
 * `derived_layer` recipe. Row count can explode on dense polygons;
 * MULTI* parts are dumped together.
 */
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  type DerivedLayerData,
} from '@gratis-gis/shared-types';

export interface VerticesGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
}

export interface VerticesDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

/** Single-step vertices recipe pointed at a data_layer source. */
export function buildVerticesDerivedLayerData(
  input: VerticesGuideInput,
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
        tool: 'vertices',
        params: {},
      },
    ],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

/** Default title: "Parcels · vertices". */
export function defaultVerticesDerivedLayerTitle(sourceLabel: string): string {
  const src = sourceLabel.trim() || 'Layer';
  return `${src} · vertices`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildVerticesDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
}): VerticesDerivedLayerCreatePayload {
  const title =
    args.title.trim() || defaultVerticesDerivedLayerTitle(args.sourceLabel);
  return {
    type: 'derived_layer',
    title,
    description: `Server-side vertex dump of "${args.sourceLabel}" via ST_DumpPoints (adds vertex_index). Created from the Analyze Vertices guide; runs as a PostGIS derived-layer job. Row count can grow with every corner; MULTI* parts are expanded together.`,
    tags: [],
    access: 'private',
    data: buildVerticesDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
    }),
  };
}
