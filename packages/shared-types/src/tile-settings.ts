// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-layer vector tile settings for hosted data layers.
 *
 * Stored on each v3 sublayer as `tiles` (next to `editingPolicy` and
 * the other layer-level switches in the item's data JSON). Every key
 * is optional and an absent key means "what the server did before
 * this setting existed", so an existing layer renders exactly as it
 * always has until its owner opts in.
 *
 * The bounds live here so the API (which validates on write and
 * clamps again on read) and the settings form (which shows them) can
 * never disagree.
 */
import type { MapLayer } from './map';

export interface LayerTileSettings {
  /**
   * Attribute fields carried in each tile, by name. Absent means every
   * declared field (the historical behaviour). Fields a map's own
   * style, labels, filter or hover popup reference are added back by
   * the map at request time; see `tileFieldRefs`.
   *
   * This trims tile size. It is NOT access control: anyone who can
   * read the layer can still read every field through the features
   * API.
   */
  fields?: string[];
  /** Lowest zoom that returns features. Below it the tile is empty. */
  minZoom?: number;
  /** Highest zoom that returns features. Above it the tile is empty. */
  maxZoom?: number;
  /** Per-tile feature cap. Can only lower the server's cap. */
  maxFeatures?: number;
  /** Browser cache lifetime for tiles, in seconds (Cache-Control max-age). */
  cacheMaxAge?: number;
  /**
   * Add a `labels` layer to each tile: one point per line or polygon
   * feature, in the one tile that contains it, so the map labels each
   * feature once instead of once per tile it crosses. Off by default.
   * Line and polygon features in `features` then carry
   * `_label_point: true`, which tells the map to label them from
   * `labels`. Has no effect on point layers.
   */
  labelPoints?: boolean;
}

/** MVT layer name of the label points (tile settings `labelPoints`). */
export const TILE_LABELS_LAYER = 'labels';
/** Property marking a `features` feature that has a label point. */
export const TILE_LABEL_POINT_PROP = '_label_point';

/** Zoom bounds the tile routes accept at all. */
export const TILE_ZOOM_MIN = 0;
export const TILE_ZOOM_MAX = 24;

/**
 * The server's own per-tile feature ceiling. A layer setting may lower
 * it but never raise it: the ceiling is what keeps a state-wide low
 * zoom tile inside the statement timeout.
 */
export const MAX_FEATURES_PER_TILE = 5000;

/**
 * Upper bound on the per-layer browser cache age. An hour keeps the
 * window short enough that an edit, or an owner making a public layer
 * private, reaches viewers (and any shared cache in front of a public
 * layer) within a bounded time.
 */
export const TILE_CACHE_MAX_AGE_MAX = 3600;

/** Default max-age of the authenticated tile route (private). */
export const TILE_CACHE_DEFAULT_PRIVATE = 60;
/** Default max-age of the anonymous tile routes (public). */
export const TILE_CACHE_DEFAULT_PUBLIC = 300;

/**
 * The query parameter a map adds to a tile URL to name the attribute
 * fields it reads from the tile. `*` means every declared field.
 */
export const TILE_INCLUDE_PARAM = 'include';

const TOKEN_RE = /\{\{\s*([\w.-]+)/g;

function templateFields(template: string | undefined, out: Set<string>): void {
  if (typeof template !== 'string' || template.length === 0) return;
  for (const m of template.matchAll(TOKEN_RE)) {
    if (m[1]) out.add(m[1]);
  }
}

function rendererField(r: unknown, out: Set<string>): void {
  if (!r || typeof r !== 'object') return;
  const f = (r as { field?: unknown }).field;
  if (typeof f === 'string' && f.length > 0) out.add(f);
}

/**
 * Every attribute name a map layer reads from its tiles while drawing:
 * the renderer field, scaled-symbology renderers, the extrusion height,
 * the label template, the client-side filter and, when hover popups
 * are on, the popup's fields. Returns `['*']` when the hover popup
 * shows every field. Sorted, so the URL it feeds is stable.
 *
 * Click popups are not here on purpose: they load the feature from the
 * features API, not from the tile.
 */
export function tileFieldRefs(layer: Pick<MapLayer, 'renderer' | 'labels' | 'filter' | 'popup' | 'style'> & {
  scaledSymbology?: MapLayer['scaledSymbology'];
}): string[] {
  const out = new Set<string>();
  rendererField(layer.renderer, out);
  for (const cls of layer.scaledSymbology ?? []) rendererField(cls?.renderer, out);
  const ext = layer.style?.polygon?.extrusion;
  if (ext?.enabled && typeof ext.heightField === 'string' && ext.heightField) {
    out.add(ext.heightField);
  }
  if (layer.labels?.enabled) templateFields(layer.labels.template, out);
  for (const c of layer.filter?.clauses ?? []) {
    if (typeof c?.field === 'string' && c.field.length > 0) out.add(c.field);
  }
  const popup = layer.popup;
  if (popup?.enabled && popup.showOnHover === true) {
    if (popup.mode === 'all') return ['*'];
    if (popup.mode === 'picked') {
      for (const f of popup.fields ?? []) if (typeof f === 'string' && f) out.add(f);
    } else {
      templateFields(popup.titleTemplate, out);
      templateFields(popup.bodyTemplate, out);
    }
  }
  return [...out].sort();
}
