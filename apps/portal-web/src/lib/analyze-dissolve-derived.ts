// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Dissolve shortcut for the Analyze workbench
 * (R7-analyze-dissolve-shortcut).
 *
 * `dissolveGenerator` is a no-param PostGIS `ST_Union` that
 * drops attributes. Analyze never invents an in-browser dissolve;
 * it POSTs a single-step `derived_layer` recipe pointed at the
 * current data_layer, labeled as a server job.
 */
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  type DerivedLayerData,
} from '@gratis-gis/shared-types';

export interface DissolveGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
}

export interface DissolveDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

/** Single-step dissolve recipe pointed at a data_layer source. */
export function buildDissolveDerivedLayerData(
  input: DissolveGuideInput,
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
        tool: 'dissolve',
        params: {},
      },
    ],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

/** Default title: "Parcels · dissolve". */
export function defaultDissolveDerivedLayerTitle(sourceLabel: string): string {
  const src = sourceLabel.trim() || 'Layer';
  return `${src} · dissolve`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildDissolveDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
}): DissolveDerivedLayerCreatePayload {
  const title =
    args.title.trim() || defaultDissolveDerivedLayerTitle(args.sourceLabel);
  return {
    type: 'derived_layer',
    title,
    description: `Server-side dissolve of "${args.sourceLabel}" via ST_Union into one feature (attributes dropped). Created from the Analyze Dissolve guide; runs as a PostGIS derived-layer job. For keyed dissolve with aggregates, use group-by with geometry strategy dissolve.`,
    tags: [],
    access: 'private',
    data: buildDissolveDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
    }),
  };
}
