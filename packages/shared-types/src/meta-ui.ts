// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Server-computed presentation block for item detail reads.
 *
 * Clients (portal-web, QGIS plugin, MCP, Python) should prefer
 * `meta.ui` over re-deriving viewer endpoints from `item.data`.
 * Shape is additive and versioned; unknown fields must be ignored.
 *
 * See docs/meta-ui.md and docs/research/ecosystem-alignment-2026-08-17.md.
 */

import type { MapLayerSource } from './map.js';

/** One suggested map layer derived from an item. */
export interface MetaUiLayer {
  title: string;
  /**
   * Ready-to-stamp MapLayerSource. Clients that build MapLibre /
   * QGIS layers should use this instead of parsing item.data.
   */
  source: MapLayerSource;
  /** Sublayer geometry when known (data_layer v3). */
  geometryType?: string | null;
}

export interface MetaUiDownload {
  label: string;
  url: string;
  /** Short format hint, e.g. GeoJSON, PMTiles, COPC. */
  format: string;
}

/**
 * Presentation contract attached as `meta.ui` on item detail GET.
 * Not stored in the database; computed on read.
 */
export interface MetaUi {
  version: 1;
  /** Suggested layers for "add to map" / plugin open. Empty when not map-viewable. */
  layers: MetaUiLayer[];
  downloads: MetaUiDownload[];
  thumbnailUrl: string | null;
  /** Portal path to the item detail page, e.g. `/items/{id}`. */
  landingPath: string;
}

export interface ItemMeta {
  ui: MetaUi;
}

/** Map a MetaUiLayer.source into a MapLayerSource (identity + strip unknowns). */
export function mapLayerSourceFromMetaUi(
  layer: MetaUiLayer,
): MapLayerSource | null {
  const s = layer.source;
  if (!s || typeof s !== 'object' || !('kind' in s)) return null;
  return s;
}
