// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Clip shortcut for the Analyze workbench
 * (R5-analyze-clip-shortcut).
 *
 * Mirrors the Buffer guide: Analyze never invents an in-browser
 * clip. It POSTs a single-step `derived_layer` recipe that runs
 * the existing PostGIS clip tool against a second data_layer
 * (the cookie-cutter).
 */
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  type DerivedLayerData,
} from '@gratis-gis/shared-types';

export interface ClipGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
  clipItemId: string;
  clipLayerKey?: string;
}

export interface ClipDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

/** Validate the clip-layer pick. Null when ready to submit. */
export function validateClipOtherSource(
  clipItemId: string,
  sourceItemId: string,
): string | null {
  const id = clipItemId.trim();
  if (!id) {
    return 'Pick a clip layer (a polygon data layer you can read).';
  }
  if (id === sourceItemId.trim()) {
    return 'Pick a different layer to clip against; a layer cannot cookie-cut itself here.';
  }
  return null;
}

/** Single-step clip recipe pointed at a data_layer source. */
export function buildClipDerivedLayerData(
  input: ClipGuideInput,
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
        tool: 'clip',
        params: {
          otherSource: {
            kind: 'data_layer',
            itemId: input.clipItemId,
            ...(input.clipLayerKey
              ? { layerKey: input.clipLayerKey }
              : {}),
          },
        },
      },
    ],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

/** Default title: "Hydrants · clipped by City boundary". */
export function defaultClipDerivedLayerTitle(
  sourceLabel: string,
  clipLabel: string,
): string {
  const src = sourceLabel.trim() || 'Layer';
  const clip = clipLabel.trim() || 'clip layer';
  return `${src} · clipped by ${clip}`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildClipDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  clipLabel: string;
  sourceItemId: string;
  layerKey?: string;
  clipItemId: string;
  clipLayerKey?: string;
}): ClipDerivedLayerCreatePayload {
  const title =
    args.title.trim() ||
    defaultClipDerivedLayerTitle(args.sourceLabel, args.clipLabel);
  return {
    type: 'derived_layer',
    title,
    description: `Server-side clip of "${args.sourceLabel}" by "${args.clipLabel}". Created from the Analyze Clip guide; runs as a PostGIS derived-layer job.`,
    tags: [],
    access: 'private',
    data: buildClipDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
      clipItemId: args.clipItemId,
      ...(args.clipLayerKey ? { clipLayerKey: args.clipLayerKey } : {}),
    }),
  };
}
