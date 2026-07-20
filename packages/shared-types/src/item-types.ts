// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The enumerated set of content types an Item can represent. The string
 * values match the Prisma-generated enum names (underscore form), which
 * is what the API actually serializes; Prisma's `@map("kebab-case")`
 * only affects the on-disk value, not the JSON shape. Keeping these
 * aligned avoids silent mismatches between client comparisons and
 * server responses.
 *
 * Add a new value here when introducing a new kind of platform content.
 */
export const ITEM_TYPES = [
  'map',
  'data_layer',
  'derived_layer',
  'arcgis_service',
  'form',
  'form_submission_collection',
  'web_app',
  'report_template',
  'dashboard',
  'file',
  'layer_package',
  'tool',
  'widget_package',
  'pick_list',
  'geo_boundary',
  'basemap',
  'wms_service',
  'wfs_service',
  // #304: unified Connected Service item type. Replaces the four
  // protocol-specific types (arcgis_service, wms_service, wfs_service,
  // and the not-yet-shipped wmts) under a single shape with a
  // `protocol` discriminator on data_json. The legacy types stay in
  // this list for the deprecation window so existing rows keep
  // dispatching to their detail pages until the migration runs.
  'service',
  'folder',
  'editor',
  'data_collection',
  // #74: geocoding service backed by an internal data_layer. Wraps
  // a vector layer (parcels, addresses, places) + a search-fields
  // config and exposes a /geocode endpoint for maps + apps to
  // consume. Sits alongside arcgis_geocode `service` items as the
  // two ways to publish a geocoder; both feed the same map-search
  // picker.
  'geocoding_service',
  // #179: pre-rendered tile cache (PMTiles container in v1). Wraps
  // one uploaded tile file + metadata extracted from its header at
  // upload time. Consumable as a basemap source through its
  // pmtiles:// URL.
  'tile_layer',
  // #22: reusable Custom Web App blueprint. Stores a CustomAppData
  // payload that the new-item wizard can clone into a fresh
  // web_app at instantiation time. Built-in starters (sidebar-
  // explorer, showcase-map, compact-drawer, blank-canvas) are
  // seeded per-org as items of this kind, alongside any templates
  // an author saves themselves from an existing app.
  'app_template',
  // #22: shareable color/typography palette for Custom Web Apps.
  // data_json stores the AppThemeTokens bundle (surface ladder,
  // header tokens, accent, radii, shadows, density). Built-in
  // starters (default/slate/aurora/forest/paper) seed per-org as
  // items of this kind; user-saved themes appear alongside them
  // in the designer's theme picker. CustomAppData.themePresetId
  // references a theme item id (or the starter kind for back-
  // compat with apps that pre-date this refactor).
  'theme',
  // #101: shareable print template for the Print tool in a Custom
  // Web App.  data_json carries a PrintTemplateData (paper size +
  // free-positioned elements + declared parameters).  Built-in
  // starters (Letter portrait/landscape, Letter landscape large
  // legend, Tabloid landscape, Field summary) seed per-org;
  // user-authored templates live here too.  At print time the
  // runtime widget reads the template's declared parameters,
  // renders a form, and posts the resolved values to the server
  // PDF endpoint.
  'print_template',
  // #179: 3D point cloud served as an ordinary layer, not a separate
  // "scene" surface. Wraps one uploaded COPC (cloud-optimized LAZ)
  // file range-served from MinIO; viewers stream octree nodes by
  // viewport. data_json shape is PointCloudData.
  'point_cloud',
] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

export function isItemType(value: unknown): value is ItemType {
  return typeof value === 'string' && (ITEM_TYPES as readonly string[]).includes(value);
}

/**
 * Human-readable display labels for each ItemType.  Lifted here from
 * portal-web's item-type-icon.tsx so backend renderers (thumbnail
 * SVG, DCAT export, notifications) can reuse the same vocabulary
 * without round-tripping through the UI layer.  portal-web's
 * getItemTypeLabel() now re-exports from here; the icon registry
 * stays in portal-web because it pulls in lucide.
 */
export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  map: 'Map',
  data_layer: 'Data layer',
  derived_layer: 'Derived layer',
  arcgis_service: 'ArcGIS service',
  form: 'Form',
  form_submission_collection: 'Form submissions',
  web_app: 'Web app',
  report_template: 'Report template',
  dashboard: 'Dashboard',
  file: 'File',
  layer_package: 'Layer package',
  tool: 'Tool',
  widget_package: 'Widget package',
  pick_list: 'Pick list',
  geo_boundary: 'Boundary',
  basemap: 'Basemap',
  wms_service: 'WMS service',
  wfs_service: 'WFS service',
  service: 'Connected service',
  folder: 'Folder',
  editor: 'Editor',
  data_collection: 'Data collection',
  geocoding_service: 'Geocoding service',
  tile_layer: 'Tile layer',
  app_template: 'Web app template',
  theme: 'Theme',
  print_template: 'Print template',
  point_cloud: 'Point cloud',
};

export function getItemTypeLabel(t: ItemType): string {
  return ITEM_TYPE_LABELS[t] ?? t;
}
