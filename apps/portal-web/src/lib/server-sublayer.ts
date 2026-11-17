// SPDX-License-Identifier: AGPL-3.0-or-later
import { fetchLayerExtent, layerExtentUrl, v3SublayerOf } from './layer-extent-url';

/**
 * Which layers the attribute table, search and form view read from
 * the server instead of from a feature collection held in the
 * browser.
 *
 * Two shapes qualify:
 *   - a `data-layer` source with a sublayer key (the Viewer and the
 *     map builder draw these from tiles), and
 *   - an Editor target: a `geojson-url` source under the
 *     `editor-target:` id that names a v3 sublayer. The canvas only
 *     holds the rows in view for these, so the browser never has the
 *     whole layer to page through.
 *
 * Other `geojson-url` layers stay client fed. The map keys their
 * selection by row position, which the server pages cannot match.
 */

/** Id prefix of the Editor's synthesized target layers. Same value as
 *  EDITOR_TARGET_LAYER_PREFIX in the editor's build-map-data. */
export const EDITOR_TARGET_ID_PREFIX = 'editor-target:';

type SublayerSource =
  | { kind: 'data-layer'; itemId: string; layerKey?: string | undefined }
  | { kind: 'geojson-url'; url: string }
  | { kind: string };

interface LayerLike {
  id: string;
  source: SublayerSource;
}

export function isEditorTargetSublayer(layer: LayerLike): boolean {
  return (
    layer.id.startsWith(EDITOR_TARGET_ID_PREFIX) &&
    v3SublayerOf(layer.source) !== null
  );
}

/** The v3 sublayer to read from the server, or null for a client-fed layer. */
export function serverSublayerOf(
  layer: LayerLike | null | undefined,
): { itemId: string; layerKey: string } | null {
  if (!layer) return null;
  if (layer.source.kind === 'data-layer') return v3SublayerOf(layer.source);
  if (layer.id.startsWith(EDITOR_TARGET_ID_PREFIX)) {
    return v3SublayerOf(layer.source);
  }
  return null;
}

export type Bbox = [number, number, number, number];

/** Union of the boxes that are present and finite; null when none are. */
export function unionBbox(boxes: Array<Bbox | null | undefined>): Bbox | null {
  let out: Bbox | null = null;
  for (const b of boxes) {
    if (!b || b.length !== 4 || !b.every((n) => Number.isFinite(n))) continue;
    out = out
      ? [
          Math.min(out[0], b[0]),
          Math.min(out[1], b[1]),
          Math.max(out[2], b[2]),
          Math.max(out[3], b[3]),
        ]
      : [b[0], b[1], b[2], b[3]];
  }
  return out;
}

/**
 * The extent covering every Editor target in `layers`, asked of the
 * server one sublayer at a time. Null when no target has an extent
 * (all empty, or every request failed). `fetchExtent` is a parameter
 * so the spec can stand in for the network.
 */
export async function editorTargetsExtent(
  layers: Array<LayerLike & { filter?: Parameters<typeof layerExtentUrl>[1] }>,
  fetchExtent: (url: string) => Promise<Bbox | null> = fetchLayerExtent,
): Promise<Bbox | null> {
  const urls = layers
    .filter(isEditorTargetSublayer)
    .map((l) => layerExtentUrl(l.source, l.filter ?? null))
    .filter((u): u is string => u !== null);
  if (urls.length === 0) return null;
  const boxes = await Promise.all(urls.map((u) => fetchExtent(u).catch(() => null)));
  return unionBbox(boxes);
}
