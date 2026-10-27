// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Erase shortcut for the Analyze workbench
 * (R6-analyze-erase-shortcut).
 *
 * Mirrors the Clip guide: Analyze never invents an in-browser
 * erase. It POSTs a single-step `derived_layer` recipe that runs
 * the existing PostGIS erase tool against a second data_layer
 * (the mask to subtract).
 */
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  type DerivedLayerData,
} from '@gratis-gis/shared-types';

export interface EraseGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
  eraseItemId: string;
  eraseLayerKey?: string;
}

export interface EraseDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

/** Validate the erase-mask pick. Null when ready to submit. */
export function validateEraseOtherSource(
  eraseItemId: string,
  sourceItemId: string,
): string | null {
  const id = eraseItemId.trim();
  if (!id) {
    return 'Pick an erase mask (a polygon data layer you can read).';
  }
  if (id === sourceItemId.trim()) {
    return 'Pick a different layer as the erase mask; a layer cannot erase itself here.';
  }
  return null;
}

/** Single-step erase recipe pointed at a data_layer source. */
export function buildEraseDerivedLayerData(
  input: EraseGuideInput,
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
        tool: 'erase',
        params: {
          otherSource: {
            kind: 'data_layer',
            itemId: input.eraseItemId,
            ...(input.eraseLayerKey
              ? { layerKey: input.eraseLayerKey }
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

/** Default title: "Parcels · erased by Flood zone". */
export function defaultEraseDerivedLayerTitle(
  sourceLabel: string,
  eraseLabel: string,
): string {
  const src = sourceLabel.trim() || 'Layer';
  const erase = eraseLabel.trim() || 'erase mask';
  return `${src} · erased by ${erase}`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildEraseDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  eraseLabel: string;
  sourceItemId: string;
  layerKey?: string;
  eraseItemId: string;
  eraseLayerKey?: string;
}): EraseDerivedLayerCreatePayload {
  const title =
    args.title.trim() ||
    defaultEraseDerivedLayerTitle(args.sourceLabel, args.eraseLabel);
  return {
    type: 'derived_layer',
    title,
    description: `Server-side erase of "${args.sourceLabel}" by "${args.eraseLabel}". Created from the Analyze Erase guide; runs as a PostGIS derived-layer job.`,
    tags: [],
    access: 'private',
    data: buildEraseDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
      eraseItemId: args.eraseItemId,
      ...(args.eraseLayerKey ? { eraseLayerKey: args.eraseLayerKey } : {}),
    }),
  };
}
