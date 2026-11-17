// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Bounding boxes shortcut for the Analyze workbench
 * (R9-analyze-bbox-shortcut).
 *
 * `bboxGenerator` already ships a no-param PostGIS `ST_Envelope`
 * step (per-feature). Analyze never invents an in-browser envelope
 * path; it POSTs a single-step `derived_layer` recipe pointed at
 * the current data_layer, labeled as a server job. One envelope for
 * the whole layer is not this path — use dissolve / group-by when
 * you need an aggregate shape.
 */
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  type DerivedLayerData,
} from '@gratis-gis/shared-types';

export interface BboxGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
}

export interface BboxDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

/** Single-step bbox recipe pointed at a data_layer source. */
export function buildBboxDerivedLayerData(
  input: BboxGuideInput,
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
        tool: 'bbox',
        params: {},
      },
    ],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

/** Default title: "Parcels · bounding boxes". */
export function defaultBboxDerivedLayerTitle(sourceLabel: string): string {
  const src = sourceLabel.trim() || 'Layer';
  return `${src} · bounding boxes`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildBboxDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
}): BboxDerivedLayerCreatePayload {
  const title =
    args.title.trim() || defaultBboxDerivedLayerTitle(args.sourceLabel);
  return {
    type: 'derived_layer',
    title,
    description: `Server-side per-feature bounding boxes of "${args.sourceLabel}" via ST_Envelope. Created from the Analyze Bounding boxes guide; runs as a PostGIS derived-layer job. Not one envelope for the whole layer.`,
    tags: [],
    access: 'private',
    data: buildBboxDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
    }),
  };
}
