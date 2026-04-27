import {
  Box,
  ClipboardList,
  FileText,
  File as FileIcon,
  Folder as FolderIcon,
  Globe,
  Inbox,
  Layers,
  LayoutDashboard,
  ListChecks,
  Map as MapIcon,
  MapPin,
  Notebook,
  Package,
  PencilRuler,
  Plug,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ItemType } from '@gratis-gis/shared-types';

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
  arcgis_service: Plug,
  form: ClipboardList,
  form_submission_collection: Inbox,
  web_app: Sparkles,
  report_template: FileText,
  dashboard: LayoutDashboard,
  file: FileIcon,
  layer_package: Package,
  notebook: Notebook,
  tool: Wrench,
  widget_package: Box,
  pick_list: ListChecks,
  geo_boundary: MapPin,
  basemap: Globe,
  wms_service: Plug,
  wfs_service: Plug,
  folder: FolderIcon,
  editor: PencilRuler,
};

/**
 * Human-readable label for every item type. Single source of truth
 * so the type badge on the detail page, filter chips on the items
 * list, wizard tile heading, and create-form dropdown all say the
 * same thing. Anywhere the raw enum value would otherwise leak into
 * the UI ("data_layer" as uppercase tracking-wide text) should read
 * from here instead.
 */
const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  map: 'Map',
  data_layer: 'Data layer',
  arcgis_service: 'ArcGIS service',
  form: 'Form',
  form_submission_collection: 'Form submissions',
  web_app: 'Web app',
  report_template: 'Report template',
  dashboard: 'Dashboard',
  file: 'File',
  layer_package: 'Layer package',
  notebook: 'Notebook',
  tool: 'Tool',
  widget_package: 'Widget package',
  pick_list: 'Pick list',
  geo_boundary: 'Boundary',
  basemap: 'Basemap',
  wms_service: 'WMS service',
  wfs_service: 'WFS service',
  folder: 'Folder',
  editor: 'Editor',
};

export function getItemTypeLabel(t: ItemType): string {
  return ITEM_TYPE_LABELS[t] ?? t;
}

/** Tailwind color classes used when rendering the icon OUTSIDE a
 *  colored tile (e.g. on a plain surface alongside the item title).
 *  Mirrors the tile palette in @gratis-gis/ui so the two contexts
 *  stay visually coherent. */
const ITEM_TYPE_ACCENT: Record<ItemType, string> = {
  map: 'text-emerald-600',
  data_layer: 'text-sky-600',
  arcgis_service: 'text-cyan-600',
  form: 'text-violet-600',
  form_submission_collection: 'text-violet-500',
  web_app: 'text-amber-600',
  report_template: 'text-rose-600',
  dashboard: 'text-indigo-600',
  file: 'text-slate-600',
  layer_package: 'text-emerald-700',
  notebook: 'text-fuchsia-600',
  tool: 'text-teal-600',
  widget_package: 'text-teal-700',
  pick_list: 'text-lime-600',
  geo_boundary: 'text-orange-600',
  basemap: 'text-slate-600',
  wms_service: 'text-cyan-700',
  wfs_service: 'text-cyan-800',
  folder: 'text-amber-700',
  editor: 'text-purple-600',
};

/** Tailwind class combos for the tile background used in compact
 *  thumbnails (e.g. detail-page header badge). Kept in sync with the
 *  ItemCard full-bleed tile colors. */
const ITEM_TYPE_TILE: Record<ItemType, string> = {
  map: 'bg-emerald-500/90 text-white',
  data_layer: 'bg-sky-500/90 text-white',
  arcgis_service: 'bg-cyan-600/90 text-white',
  form: 'bg-violet-500/90 text-white',
  form_submission_collection: 'bg-violet-400/90 text-white',
  web_app: 'bg-amber-500/90 text-white',
  report_template: 'bg-rose-500/90 text-white',
  dashboard: 'bg-indigo-500/90 text-white',
  file: 'bg-slate-500/90 text-white',
  layer_package: 'bg-emerald-600/90 text-white',
  notebook: 'bg-fuchsia-500/90 text-white',
  tool: 'bg-teal-500/90 text-white',
  widget_package: 'bg-teal-600/90 text-white',
  pick_list: 'bg-lime-500/90 text-white',
  geo_boundary: 'bg-orange-500/90 text-white',
  basemap: 'bg-slate-600/90 text-white',
  wms_service: 'bg-cyan-700/90 text-white',
  wfs_service: 'bg-cyan-800/90 text-white',
  folder: 'bg-amber-600/90 text-white',
  editor: 'bg-purple-500/90 text-white',
};

export function getItemTypeIcon(type: ItemType): LucideIcon {
  return ITEM_TYPE_ICONS[type] ?? FileIcon;
}

export function getItemTypeAccent(type: ItemType): string {
  return ITEM_TYPE_ACCENT[type] ?? 'text-slate-600';
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
