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
  'arcgis_service',
  'form',
  'form_submission_collection',
  'web_app',
  'report_template',
  'dashboard',
  'file',
  'layer_package',
  'notebook',
  'tool',
  'widget_package',
  'pick_list',
  'geo_boundary',
  'basemap',
  'wms_service',
  'wfs_service',
  'folder',
  'editor',
] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

export function isItemType(value: unknown): value is ItemType {
  return typeof value === 'string' && (ITEM_TYPES as readonly string[]).includes(value);
}
