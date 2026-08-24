// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OfflineArea } from './offline-package';

/**
 * Canonical shape stored in an Item's dataJson when
 * `type = 'data_collection'`.
 *
 * A data_collection is a Field Maps-style "field deployment" wrapper
 * around a `map` item. The author picks a map, optionally binds
 * custom forms to specific editable layers, and optionally configures
 * an offline area. The resulting item gets opened in the field-mode
 * runtime by collectors who tap features (to edit) or empty space
 * (to add) on a phone-friendly canvas.
 *
 * Why a wrapper around a map rather than tying field-mode to maps
 * directly:
 *   - A map and a field deployment have different audiences. The
 *     same map can power a desktop browse view AND a field crew's
 *     collection app; the deployment carries the field-specific
 *     overlay (visible vs. editable layers, offline extent, custom
 *     form bindings) without polluting the map item itself.
 *   - Crew distribution. A QR code or share grant points at the
 *     data_collection, so renaming or restructuring the underlying
 *     map doesn't break field links.
 *   - Offline configuration belongs on the deployment, not the map.
 *     Two crews collecting in different parts of a state shouldn't
 *     share the same offline extent.
 *
 * Form resolution at runtime (Field Maps convention):
 *   1. If `formBindings[layerKey]` is set, use that form item.
 *   2. Otherwise, auto-generate a form from the layer's FeatureField
 *      schema, respecting popup config (hidden fields, label
 *      overrides, field order). System fields (`gid`, `created_by`,
 *      `edited_at`, etc.) are filtered out.
 *
 * This means an author can ship a working field deployment with no
 * form authoring at all -- pick a map, save, done. Custom forms are
 * an upgrade path, not a prerequisite.
 *
 * Versioned for forward compatibility: bump `version` and write a
 * migrator when a breaking change is needed. The runtime tolerates
 * missing fields and falls back to defaults so older deployments
 * keep working after additive shape changes.
 */
export interface DataCollectionData {
  version: 1;
  /**
   * Item id of the `map` this deployment wraps. Required: a
   * data_collection without a map has nothing for a collector to
   * tap on.
   */
  mapId: string;
  /**
   * Optional explicit form bindings keyed by layer key (a v3
   * data_layer sublayer id, matching the layerKey used in
   * MapLayerSource). When a layer has no entry here, the field
   * runtime auto-generates a form from the layer's FeatureField
   * schema. When present, the bound form is used verbatim.
   *
   * Stored as an object keyed by layer key rather than an array so
   * lookups in the runtime are O(1) and so the JSON path
   * `formBindings.<layerKey>` is stable for dependency extraction.
   */
  formBindings?: Record<string, DataCollectionFormBinding>;
  /**
   * NOT READ BY ANYTHING. Kept only so items that already carry it
   * round-trip unchanged.
   *
   * It was meant to bound what the field runtime pre-caches, and the
   * runtime never consulted it: the download uses the live viewport
   * and the zoom pickers instead. Pre-declared extents are now
   * `offlineAreas` below, which the server builds from. Read that
   * one; this one is a tombstone.
   */
  offline?: DataCollectionOfflineConfig;
  /**
   * Author-defined areas the portal pre-builds basemap packages for.
   * Separate from `offline` above, which describes how the runtime
   * should behave when a collector takes an area offline themselves.
   * These describe areas the author knows about in advance, so the
   * archive is cut once on the server instead of once per collector.
   *
   * The builds are rows in `offline_package`, not fields here; see
   * OfflineArea in offline-package.ts for why they are split.
   */
  offlineAreas?: OfflineArea[];
}

/**
 * One explicit form binding. Today carries just the form item id;
 * structured as an object so we can add per-binding options later
 * (override field labels, lock specific fields, etc.) without
 * another schema migration.
 */
export interface DataCollectionFormBinding {
  /** Item id of the bound form. */
  formItemId: string;
}

/**
 * Dead shape. See the note on `DataCollectionData.offline`: nothing
 * has ever read this, and the field comments below describe a
 * runtime that was never built against it. Left in place so stored
 * items keep round-tripping; do not write new code against it.
 */
export interface DataCollectionOfflineConfig {
  /**
   * EPSG:4326 envelope to pre-cache, [west, south, east, north].
   * Inclusive. When omitted, the runtime falls back to the map's
   * default extent at download time.
   */
  bbox?: [number, number, number, number];
  /**
   * Lowest zoom level to pre-cache tiles at. Tiles below this zoom
   * still render online if connection is available. Defaults to
   * the map's minZoom, or 0 when the map has none.
   */
  minZoom?: number;
  /**
   * Highest zoom level to pre-cache. Higher = more detail offline,
   * but quadratic tile count growth. Capped by the runtime at a
   * sensible default (currently zoom 18) to avoid runaway downloads.
   */
  maxZoom?: number;
}

/**
 * Freshly-created data_collection with safe defaults. The wizard
 * sets `mapId` from the picker; everything else stays empty so the
 * runtime falls through to schema-derived forms and online-only
 * mode until the author opts in.
 */
export const DEFAULT_DATA_COLLECTION: Omit<DataCollectionData, 'mapId'> = {
  version: 1,
};
