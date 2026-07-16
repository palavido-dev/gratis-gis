// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Box,
  ClipboardList,
  Eye,
  FileText,
  File as FileIcon,
  FlaskConical,
  Folder as FolderIcon,
  Globe,
  Inbox,
  Layers,
  LayoutDashboard,
  ListChecks,
  Map as MapIcon,
  MapPin,
  Package,
  PencilRuler,
  Plug,
  Palette,
  Printer,
  Sparkles,
  Wand2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ItemType } from '@gratis-gis/shared-types';
import {
  isCustomAppItem,
  isEditorItem,
  isViewerItem,
} from '@gratis-gis/shared-types';

/**
 * Per-item-type icon mapping. Kept in portal-web (not @gratis-gis/ui)
 * so the ui package stays free of lucide as a hard dep. Callers that
 * render an item card or thumbnail pass this icon in explicitly.
 *
 * The colored tile background used behind the icon lives in
 * @gratis-gis/ui's ItemCard: keeping the palette there so every
 * render shares the same colors, and keeping the icon component here
 * so portal-web owns the lucide surface.
 */
const ITEM_TYPE_ICONS: Record<ItemType, LucideIcon> = {
  map: MapIcon,
  data_layer: Layers,
  derived_layer: FlaskConical,
  arcgis_service: Plug,
  form: ClipboardList,
  form_submission_collection: Inbox,
  web_app: Sparkles,
  report_template: FileText,
  dashboard: LayoutDashboard,
  file: FileIcon,
  layer_package: Package,
  tool: Wrench,
  widget_package: Box,
  pick_list: ListChecks,
  geo_boundary: MapPin,
  basemap: Globe,
  wms_service: Plug,
  wfs_service: Plug,
  service: Plug,
  folder: FolderIcon,
  editor: PencilRuler,
  data_collection: ClipboardList,
  geocoding_service: MapPin,
  tile_layer: Layers,
  app_template: Wand2,
  theme: Palette,
  print_template: Printer,
};

/**
 * Human-readable label for every item type. Single source of truth
 * so the type badge on the detail page, filter chips on the items
 * list, wizard tile heading, and create-form dropdown all say the
 * same thing. Anywhere the raw enum value would otherwise leak into
 * the UI ("data_layer" as uppercase tracking-wide text) should read
 * from here instead.
 */
// Label map lifted to shared-types so backend renderers (thumbnail
// SVG, etc.) can read the same labels.  Imported here for the local
// getItemDisplayLabel helper that needs to distinguish web_app
// variants before falling through to the generic label.
import { ITEM_TYPE_LABELS } from '@gratis-gis/shared-types';

export { getItemTypeLabel } from '@gratis-gis/shared-types';

/** Tailwind color classes used when rendering the icon OUTSIDE a
 *  colored tile (e.g. on a plain surface alongside the item title).
 *  Mirrors the tile palette in @gratis-gis/ui so the two contexts
 *  stay visually coherent. */
const ITEM_TYPE_ACCENT: Record<ItemType, string> = {
  map: 'text-emerald-600 dark:text-emerald-400',
  data_layer: 'text-sky-600 dark:text-sky-400',
  derived_layer: 'text-blue-700 dark:text-blue-400',
  arcgis_service: 'text-cyan-600 dark:text-cyan-400',
  form: 'text-violet-600 dark:text-violet-400',
  form_submission_collection: 'text-violet-500 dark:text-violet-400',
  web_app: 'text-amber-600 dark:text-amber-400',
  report_template: 'text-rose-600 dark:text-rose-400',
  dashboard: 'text-indigo-600 dark:text-indigo-400',
  file: 'text-slate-600 dark:text-slate-400',
  layer_package: 'text-emerald-700 dark:text-emerald-400',
  tool: 'text-teal-600 dark:text-teal-400',
  widget_package: 'text-teal-700 dark:text-teal-400',
  pick_list: 'text-lime-600 dark:text-lime-400',
  geo_boundary: 'text-orange-600 dark:text-orange-400',
  basemap: 'text-slate-600 dark:text-slate-400',
  wms_service: 'text-cyan-700 dark:text-cyan-400',
  wfs_service: 'text-cyan-800 dark:text-cyan-300',
  service: 'text-cyan-600 dark:text-cyan-400',
  folder: 'text-amber-700 dark:text-amber-400',
  editor: 'text-purple-600 dark:text-purple-400',
  data_collection: 'text-violet-700 dark:text-violet-400',
  geocoding_service: 'text-orange-700 dark:text-orange-400',
  tile_layer: 'text-fuchsia-600 dark:text-fuchsia-400',
  app_template: 'text-amber-700 dark:text-amber-400',
  theme: 'text-pink-600 dark:text-pink-400',
  print_template: 'text-slate-700 dark:text-slate-400',
};

/** Tailwind class combos for the tile background used in compact
 *  thumbnails (e.g. detail-page header badge). Kept in sync with the
 *  ItemCard full-bleed tile colors. */
const ITEM_TYPE_TILE: Record<ItemType, string> = {
  map: 'bg-emerald-500/90 text-white',
  data_layer: 'bg-sky-500/90 text-white',
  derived_layer: 'bg-blue-700/90 text-white',
  arcgis_service: 'bg-cyan-600/90 text-white',
  form: 'bg-violet-500/90 text-white',
  form_submission_collection: 'bg-violet-400/90 text-white',
  web_app: 'bg-amber-500/90 text-white',
  report_template: 'bg-rose-500/90 text-white',
  dashboard: 'bg-indigo-500/90 text-white',
  file: 'bg-slate-500/90 text-white',
  layer_package: 'bg-emerald-600/90 text-white',
  tool: 'bg-teal-500/90 text-white',
  widget_package: 'bg-teal-600/90 text-white',
  pick_list: 'bg-lime-500/90 text-white',
  geo_boundary: 'bg-orange-500/90 text-white',
  basemap: 'bg-slate-600/90 text-white',
  wms_service: 'bg-cyan-700/90 text-white',
  wfs_service: 'bg-cyan-800/90 text-white',
  service: 'bg-cyan-600/90 text-white',
  folder: 'bg-amber-600/90 text-white',
  editor: 'bg-purple-500/90 text-white',
  data_collection: 'bg-violet-700/90 text-white',
  geocoding_service: 'bg-orange-600/90 text-white',
  tile_layer: 'bg-fuchsia-500/90 text-white',
  app_template: 'bg-amber-700/90 text-white',
  theme: 'bg-pink-500/90 text-white',
  print_template: 'bg-slate-700/90 text-white',
};

export function getItemTypeIcon(type: ItemType): LucideIcon {
  return ITEM_TYPE_ICONS[type] ?? FileIcon;
}

/**
 * Template-aware label + icon helpers for web_app items. The bare
 * type-based helpers above show every templated web_app as the
 * generic "Web app" / Sparkles, which loses information for users
 * scanning a list. These helpers narrow first on the WebApp template
 * (Editor / Viewer / Custom) and fall back to the type-based
 * Record otherwise.
 *
 * Both helpers accept the broader `Item`-shaped object so callers
 * can pass list rows directly. `data` is optional; missing data
 * degrades gracefully to the type-based label.
 */
export function getItemDisplayLabel(item: {
  type: ItemType | string;
  data?: unknown;
}): string {
  if (item.type === 'web_app') {
    if (isEditorItem(item)) return 'Editor';
    if (isViewerItem(item)) return 'Viewer';
    if (isCustomAppItem(item)) return 'Custom web app';
  }
  if ((ITEM_TYPE_LABELS as Record<string, string>)[item.type]) {
    return (ITEM_TYPE_LABELS as Record<string, string>)[item.type] as string;
  }
  return String(item.type);
}

export function getItemDisplayIcon(item: {
  type: ItemType | string;
  data?: unknown;
}): LucideIcon {
  if (item.type === 'web_app') {
    if (isEditorItem(item)) return PencilRuler;
    if (isViewerItem(item)) return Eye;
    if (isCustomAppItem(item)) return Sparkles;
  }
  return (
    (ITEM_TYPE_ICONS as Record<string, LucideIcon>)[item.type] ?? FileIcon
  );
}

/**
 * Default click destination for an item of a given type. Most types
 * land on `/items/<id>` (the standard detail page). Some types have
 * a richer workspace surface where end users actually USE the item;
 * for those we deep-link to the workspace by default and let the
 * detail page be reached via "back to config" from inside it.
 *
 *   - editor: goes straight to the workspace runtime
 *     (`/items/<id>/editor/run`). An editor's whole point is to be
 *     used; the config page is for owners and they'll go there via
 *     the "Back to config" link in the runtime or via the Edit
 *     button on the detail page.
 *
 * Add new entries here when a future item type grows a workspace.
 * Most callers just pass `getItemHref(item)` and forget about it.
 */
export function getItemHref(item: {
  id: string;
  type: ItemType;
  /** Optional payload so we can recognize templated web_apps (e.g.
   *  the editor template after #258). When the caller has the full
   *  item already, pass it through; the helper degrades gracefully
   *  to type-only routing if not. */
  data?: unknown;
}): string {
  // #258: editor lives both as legacy type='editor' AND as migrated
  // type='web_app' + data.template='editor'. Both deep-link to the
  // editor runtime so the user-facing word stays "Editor".
  if (isEditorItem(item)) return `/items/${item.id}/editor/run`;
  // #259: viewer template is web_app + data.template='viewer'. Deep
  // link to the viewer runtime route.
  if (isViewerItem(item)) return `/items/${item.id}/viewer/run`;
  // #261: custom web_app template lands at its own runtime which
  // walks pages + widgets and renders them on a 12-column grid.
  if (isCustomAppItem(item)) return `/items/${item.id}/custom/run`;
  // data_collection items go straight to field-mode runtime (#193).
  // The config / sharing surface is still reachable via the back
  // button or the Edit link from inside the runtime.
  if (item.type === 'data_collection') return `/items/${item.id}/field`;
  // #323: forms are runnable -- the "Open" / "Launch" target is the
  // respondent-facing runtime that lets a user submit a response.
  // (View Responses, the implicit response browser, is a separate
  // affordance on the form detail page; it lives at
  // /items/<id>/responses.)
  if (item.type === 'form') return `/forms/${item.id}/respond`;
  return `/items/${item.id}`;
}

/**
 * Does this item have a distinct runtime (the "end product" the
 * end user uses) separate from its configuration page? When true,
 * the per-row kebab on the items list shows BOTH "Open" (runtime)
 * and "Configure" (detail page); when false, there's only one
 * landing place so the menu has a single Open entry.
 *
 * Currently true for the templated web_apps (editor/viewer/custom),
 * data_collection (field PWA), and form (#323 -- Open
 * targets the respondent-facing runtime at /forms/<id>/respond, with
 * a separate View Responses action wired in on the form detail page
 * for the implicit response browser).
 */
export function hasRuntime(item: {
  type: ItemType;
  data?: unknown;
}): boolean {
  if (isEditorItem(item)) return true;
  if (isViewerItem(item)) return true;
  if (isCustomAppItem(item)) return true;
  if (item.type === 'data_collection') return true;
  if (item.type === 'form') return true;
  return false;
}

/**
 * Configuration page href. Always the bare /items/:id detail page;
 * never deep-links into a runtime. Pair with getItemHref to power
 * the kebab's "Open" + "Configure" pair (#310 follow-up).
 */
export function getItemConfigureHref(item: { id: string }): string {
  return `/items/${item.id}`;
}

export function getItemTypeAccent(type: ItemType): string {
  return ITEM_TYPE_ACCENT[type] ?? 'text-slate-600 dark:text-slate-400';
}

export function getItemTypeTileClasses(type: ItemType): string {
  return ITEM_TYPE_TILE[type] ?? 'bg-slate-500/90 text-white';
}

/**
 * Render the per-type icon on a type-colored rounded tile. Used where
 * the full ItemCard is overkill but we still want the "icon on colored
 * square" visual vocabulary (detail page header, uploader fallback).
 */
export function ItemTypeBadge({
  type,
  size = 'md',
  className = '',
}: {
  type: ItemType;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const Icon = getItemTypeIcon(type);
  const tile = getItemTypeTileClasses(type);
  const sizeCls = {
    sm: 'h-8 w-8 [&>svg]:h-4 [&>svg]:w-4',
    md: 'h-10 w-10 [&>svg]:h-5 [&>svg]:w-5',
    lg: 'h-14 w-14 [&>svg]:h-7 [&>svg]:w-7',
    xl: 'h-24 w-24 [&>svg]:h-12 [&>svg]:w-12',
  }[size];
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center rounded-md ${sizeCls} ${tile} ${className}`}
    >
      <Icon />
    </span>
  );
}
