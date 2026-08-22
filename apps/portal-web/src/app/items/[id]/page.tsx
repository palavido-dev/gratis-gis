// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Calendar,
  ChevronDown,
  ClipboardList,
  ExternalLink,
  FlaskConical,
  Pencil,
  User,
  Users,
} from 'lucide-react';
import type {
  BasemapData,
  DataCollectionData,
  DerivedLayerData,
  FileData,
  FolderData,
  Item,
  ItemShare,
  Group,
  User as UserT,
  ArcgisServiceData,
  DataLayerData,
  DataLayerDataV3,
  EditorData,
  GeoBoundaryData,
  PickListData,
  ScriptData,
  MapData,
  ServiceData,
  CustomAppData,
  PrintTemplateData,
  ViewerData,
  WfsServiceData,
  WmsServiceData,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_ARCGIS_SERVICE,
  DEFAULT_DATA_LAYER,
  DEFAULT_EDITOR,
  DEFAULT_FOLDER,
  DEFAULT_GEO_BOUNDARY,
  DEFAULT_PICK_LIST,
  DEFAULT_MAP,
  DEFAULT_CUSTOM_APP,
  DEFAULT_PRINT_TEMPLATE,
  DEFAULT_VIEWER,
  isCustomAppItem,
  isEditorItem,
  isViewerItem,
  readCustomAppData,
  readEditorData,
  readViewerData,
} from '@gratis-gis/shared-types';
import { EntityBadge } from '@gratis-gis/ui';
import { ItemTypeBadge } from '@/lib/item-type-icon';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { apiFetch } from '@/lib/api';

// Name the local alias so the transform signature is readable. Keeps
// the inline type annotation in the list fetch below from ballooning.
type CustomBasemapRow = CustomBasemap;

/**
 * Map a basemap item (type=basemap, data_json: BasemapData) into the
 * CustomBasemap row shape that MapEditor / MapCanvas already consume.
 * Returns null when the basemap isn't renderable yet: unset URL,
 * unknown kind, or a Phase 2 `composed-map` kind the canvas doesn't
 * handle in Phase 1a.
 */
function basemapItemToCustomBasemap(
  it: Item<BasemapData>,
): CustomBasemapRow | null {
  const d = it.data ?? ({} as BasemapData);
  let url: string | undefined;
  let sourceKind: CustomBasemapRow['sourceKind'];
  let config: Record<string, unknown> | null = null;
  switch (d.kind) {
    case 'style-url':
      if (!d.styleUrl) return null;
      url = d.styleUrl;
      sourceKind = 'vector-style';
      break;
    case 'tile-url':
      if (!d.tileUrl) return null;
      url = d.tileUrl;
      sourceKind = 'xyz';
      break;
    case 'wms':
      if (!d.wmsUrl) return null;
      url = d.wmsUrl;
      sourceKind = 'wms';
      config = (d.wmsConfig ?? null) as Record<string, unknown> | null;
      break;
    default:
      // 'composed-map' is Phase 2; anything unexpected is a forward-compat
      // dropped entry rather than a render-time crash.
      return null;
  }
  return {
    id: it.id,
    orgId: it.orgId,
    label: it.title,
    description: it.description ?? '',
    url,
    sourceKind,
    attribution: d.attribution ?? '',
    thumbnailUrl: d.thumbnailUrl ?? it.thumbnailUrl ?? null,
    config,
    isDefault: false,
  };
}
import { ItemPills } from './item-pills';
import { ItemStatsStrip } from './item-stats-strip';
import { ItemMapPreview } from './item-map-preview';
import { SharingPanel } from './sharing-panel';
import { ItemDependencies } from './item-dependencies';
import { DeleteItemButton } from './delete-button';
import { ReassignOwnerButton } from './reassign-owner-button';
import { AddToMapButton } from './add-to-map-button';
import { MapEditor } from './map/map-editor';
import { DataLayerEditor } from './data-layer/editor';
import { ImportJobsBanner } from './import-jobs-banner';
import { DataLayerV3SchemaEditor } from './data-layer/v3-schema-editor';
import { ArcgisServiceEditor } from './arcgis-service/editor';
import { PickListEditor } from './pick-list/editor';
import { GeoBoundaryEditor } from './geo-boundary/editor';
import { DerivedLayerDetail } from './derived-layer/detail';
import { FolderDetail } from './folder/folder-detail';
import { EditorDetail } from './editor/editor-detail';
import { FormDesigner } from './form/designer';
import { FormActionsRow } from './form/actions-row';
import { PairedLayerSharingNotice } from './form/paired-layer-sharing-notice';
import { DataCollectionDetail } from './data-collection/data-collection-detail';
import { FileDetail } from './file/file-detail';
import { OgcServiceEditor } from './ogc-service/editor';
import { ServiceEditor } from './service/editor';
import { ViewerDetail } from './viewer/detail';
import { CustomAppDetail } from './custom/detail';
import { ToolDetail } from './tool/detail';
import type { ToolItemData } from '@gratis-gis/shared-types';
import type { FormSchema } from '@gratis-gis/form-schema';
import { DataLayerProvenance } from './data-layer/provenance-panel';
import { DataLayerSchema } from './data-layer/schema-panel';
import { VersionHistoryPanel } from './data-layer/version-history-panel';
import { ComingSoon } from './coming-soon';
import { BasemapEditor } from './basemap/editor';
import { GeocodingServiceEditor } from './geocoding/editor';
import { TileLayerEditor } from './tile-layer/editor';
import { PointCloudPanel } from './point-cloud/panel';
import { ScriptPanel } from './script/panel';
import { AppTemplateDetail } from './app-template/app-template-detail';
import { AppThemeDetail } from './theme/theme-detail';
import { PrintTemplateDetail } from './print-template/print-template-detail';

interface Props {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ view?: string; add?: string }>;
}

type ItemWithShares = Item & { shares: ItemShare[] };

// The type-pill palette and the access icons moved into ItemPills,
// which is the only thing that rendered them.

export default async function ItemDetailPage(props: Props) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  // Builder vs metadata view gate. Default is the metadata page
  // (description, owner, tags, sharing, related items, version
  // history) which matches how other tool-style items handle
  // edit/configuration flows. `?view=configure` opens the
  // full-screen BuilderShell for studio-style item types (map today,
  // web_app and form to follow). The builder's back arrow returns
  // here without the param. Non-studio item types ignore the gate
  // entirely.
  const isBuilderView = searchParams?.view === 'configure';
  // Phase 1: the two unconditional fetches in parallel. Item is the
  // only one that can legitimately 404 (item missing / not visible),
  // so we wrap with try/catch but still fan out alongside `me`.
  // Without parallelisation the page paid two sequential round-trips
  // before doing anything else; with it we pay one wall-clock unit
  // for both. Same for the bigger second batch below.
  let item: ItemWithShares;
  let me: {
    id: string;
    orgId: string;
    orgRole: string;
    fullName?: string | null;
    username?: string | null;
  };
  try {
    [item, me] = await Promise.all([
      apiFetch<ItemWithShares>(`/api/items/${params.id}`),
      // /api/users/me serializes the full AuthUser plus profile
      // bits; orgId is always present even though older callers only
      // typed id+orgRole. Add it here so #296's view-side download
      // gate can compare item.orgId. fullName + username are
      // optional fields the markup panel uses to label the
      // viewer's own drawing sets.
      apiFetch<{
        id: string;
        orgId: string;
        orgRole: string;
        fullName?: string | null;
        username?: string | null;
      }>('/api/users/me'),
    ]);
  } catch (err) {
    // apiFetch throws on non-2xx. 404 from the API means "not found
    // or not visible to you" (same response to prevent enumeration).
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }
  const canManage = me.id === item.ownerId || me.orgRole === 'admin';
  // #296 + #32: client-side approximation of the download tier
  // (owner/admin, public access, or same-org access). Kept only as
  // the FALLBACK for the real permissions fetch in the parallel
  // batch below, which does see per-share 'download' grants; this
  // approximation cannot, because the page never loads the user's
  // group memberships.
  const viewerCanDownload =
    item.access === 'public' || (item.access === 'org' && item.orgId === me.orgId);
  const isMap = item.type === 'map';
  const isFolder = item.type === 'folder';
  const mapData = isMap ? (item.data as MapData | null) : null;

  // Phase 2: fan out every other server-side fetch in one parallel
  // batch. Each is independent of the others; the only sequential
  // dependency is "we needed item.type and canManage first," which
  // is now resolved. Wall-clock cost goes from sum-of-7-fetches to
  // max-of-7-fetches. Failures are non-fatal per-fetch (same as the
  // sequential version was).
  const needsThemes = isCustomAppItem(item);
  const [
    basemaps,
    defaultExtentBoundary,
    folderChildren,
    allFoldersForBreadcrumb,
    geoBoundaries,
    groups,
    themeItems,
    canDownload,
  ] = await Promise.all([
    // Web map basemap library. full=1: the list default strips
    // data_json, but basemapItemToCustomBasemap needs each row's
    // tile/style config to build renderable entries.
    isMap
      ? apiFetch<Array<Item<BasemapData>>>('/api/items?type=basemap&full=1')
          .then((items) =>
            items
              .map(basemapItemToCustomBasemap)
              .filter((b): b is CustomBasemapRow => b !== null),
          )
          .catch(() => [] as CustomBasemapRow[])
      : Promise.resolve([] as CustomBasemapRow[]),
    // Resolve the map's default-extent boundary so the canvas can
    // fit-bounds without a follow-up round-trip. Missing/deleted
    // boundary -> null -> map falls back to its persisted camera.
    mapData?.defaultExtentBoundaryId
      ? apiFetch<Item<GeoBoundaryData>>(
          `/api/items/${mapData.defaultExtentBoundaryId}`,
        ).catch(() => null)
      : Promise.resolve(null),
    // Folder children resolved server-side with authz / trash filters.
    isFolder
      ? apiFetch<ItemWithShares[]>(
          `/api/items/${item.id}/folder-contents`,
        ).catch(() => [] as ItemWithShares[])
      : Promise.resolve([] as ItemWithShares[]),
    // Every folder the caller can see, used to compute the breadcrumb.
    // full=1: the parent-chain walk below reads data.childItemIds on
    // every folder row, which the lite default strips. limit=1000 is
    // the API's hard cap; breadcrumbs degrade gracefully if an org
    // somehow exceeds it (the chain just stops earlier).
    isFolder
      ? apiFetch<ItemWithShares[]>(
          '/api/items?type=folder&full=1&limit=1000',
        ).catch(() => [] as ItemWithShares[])
      : Promise.resolve([] as ItemWithShares[]),
    // Geo-boundary library. Map editors use it for the Default
    // Extent picker; SharingPanel (#80) uses it for the tier-level
    // boundary picker that scopes public / org reads. Fetch when
    // either surface needs it -- everyone who can manage the
    // sharing surface (canManage) needs the list.
    isMap || canManage
      ? apiFetch<Array<Item<GeoBoundaryData>>>(
          '/api/items?type=geo_boundary',
        ).catch(() => [] as Array<Item<GeoBoundaryData>>)
      : Promise.resolve([] as Array<Item<GeoBoundaryData>>),
    // Groups for the share picker. Only managers see the picker, so
    // skip the fetch otherwise -- saves a round-trip on the read path.
    canManage
      ? apiFetch<Group[]>('/api/groups').catch(() => [] as Group[])
      : Promise.resolve([] as Group[]),
    // #22: theme catalog for the Custom Web App designer's theme
    // picker.  Only fetched when looking at a custom-app item so
    // the round-trip doesn't run on every detail page view.
    // full=1: the theme picker renders each theme's swatch from
    // data.swatch, so this small list needs its payload.
    needsThemes
      ? apiFetch<
          Array<{
            id: string;
            title: string;
            description: string;
            seedKind: string | null;
            data: { swatch?: string };
          }>
        >('/api/items?type=theme&full=1').catch(() => [])
      : Promise.resolve(
          [] as Array<{
            id: string;
            title: string;
            description: string;
            seedKind: string | null;
            data: { swatch?: string };
          }>,
        ),
    // Real download-tier decision (#32) for the surfaces that gate
    // bulk extract (file download button, data_layer export menu).
    // The permissions endpoint sees per-share 'download' grants the
    // viewerCanDownload approximation above cannot (it lacks the
    // user's group memberships). Owners and org admins skip the
    // round-trip; a failed fetch falls back to the approximation so
    // the page still renders.
    !canManage && (item.type === 'file' || item.type === 'data_layer')
      ? apiFetch<{ canDownload: boolean }>(`/api/items/${item.id}/permissions`)
          .then((p) => p.canDownload)
          .catch(() => viewerCanDownload)
      : Promise.resolve(true),
  ]);

  // Folder breadcrumb: walk up the parent chain so the detail page
  // can render "Project A > 2026 Surveys > (this folder)" at the
  // top. Multi-parent folders pick the first parent encountered,
  // matching the rail tree's behaviour. allFoldersForBreadcrumb is
  // already populated above when isFolder.
  const folderBreadcrumb: Array<{ id: string; title: string }> = [];
  if (isFolder && allFoldersForBreadcrumb.length > 0) {
    const byId = new Map<string, ItemWithShares>();
    for (const f of allFoldersForBreadcrumb) byId.set(f.id, f);
    const parentOf = new Map<string, string>();
    for (const f of allFoldersForBreadcrumb) {
      const children = (f.data as { childItemIds?: unknown } | null)
        ?.childItemIds;
      if (!Array.isArray(children)) continue;
      for (const c of children) {
        if (typeof c === 'string' && !parentOf.has(c)) {
          parentOf.set(c, f.id);
        }
      }
    }
    const chain: Array<{ id: string; title: string }> = [];
    const seen = new Set<string>();
    let cur: string | undefined = item.id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const row = byId.get(cur);
      if (!row) break;
      chain.unshift({ id: row.id, title: row.title });
      cur = parentOf.get(cur);
    }
    // Drop "this folder" from the chain so the breadcrumb component
    // can render it as the trailing label rather than a clickable hop.
    if (chain.length > 1) {
      folderBreadcrumb.push(...chain.slice(0, -1));
    }
  }

  // Resolve importedBy UUIDs on data_layer items so the provenance
  // panel renders "by Mateo" instead of "by e39beba6". Cheap: one
  // /api/users?ids=... lookup per page render, scoped to the org.
  // Skipped for non-data_layer items.
  let userNamesForProvenance: Record<string, string> = {};
  if (item.type === 'data_layer') {
    const dl = item.data as { layers?: Array<{ source?: { importedBy?: string } }> } | null;
    const ids = new Set<string>();
    for (const l of dl?.layers ?? []) {
      const u = l?.source?.importedBy;
      if (typeof u === 'string' && u.length > 0) ids.add(u);
    }
    if (ids.size > 0) {
      const rows = await apiFetch<
        Array<{ id: string; fullName?: string | null; username?: string | null }>
      >(`/api/users?ids=${Array.from(ids).join(',')}`).catch(() => []);
      for (const r of rows) {
        userNamesForProvenance[r.id] =
          (r.fullName?.trim() || r.username || '').trim();
      }
    }
  }

  // v3 data_layer sublayers, when this item is one. Read once here
  // because the header pills, the preview and the stats strip all
  // want the same list, and three separate casts of `item.data` would
  // be three places to get the version gate wrong.
  const v3Data =
    item.type === 'data_layer' &&
    (item.data as DataLayerData | null)?.version === 3
      ? (item.data as unknown as DataLayerDataV3)
      : null;
  const v3Layers = v3Data?.layers ?? null;
  // "Workspace" item types are content-heavy (map, feature service,
  // arcgis service). For those, we collapse the metadata header so the
  // actual editor is the first thing the user sees. Other types keep
  // the standard, richer header because their "content" is basically
  // metadata + some small payload anyway.
  const isWorkspace =
    item.type === 'map' ||
    item.type === 'data_layer' ||
    item.type === 'arcgis_service';
  // Web app designers (viewer / editor / custom) are also
  // content-heavy: a 12-column drag-and-drop canvas wedged into a
  // 6xl container ends up with about 700px of usable canvas width
  // after the palette and properties rails eat their share, which
  // makes laying out a real app awkward. Bump those up to the same
  // 2xl tier maps + data_layers use; the canvas's own min-width
  // takes over below that on narrower viewports.
  const isAppBuilder = item.type === 'web_app';
  const containerWidth =
    isWorkspace || isAppBuilder ? 'max-w-screen-2xl' : 'max-w-6xl';

  return (
    <div className={`mx-auto w-full ${containerWidth} px-6 py-6`}>
      <Link
        href="/items"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to items
      </Link>
      {/* Compact header: single row with badge, title, chips, and
          actions. Description / owner / updated / tags collapse into
          a `<details>` disclosure below so they're one click away
          without eating the fold. */}
      <header className="mb-4 flex items-start gap-3">
        {/* Thumbnail: user-uploaded image wins; otherwise a per-type
            icon tile so the header visually matches the card on the
            list page instead of showing letter-initials. */}
        {item.thumbnailUrl ? (
          <EntityBadge
            label={item.title}
            seed={item.id}
            imageUrl={item.thumbnailUrl}
            size="md"
            rounded="md"
          />
        ) : (
          <ItemTypeBadge type={item.type} size="md" />
        )}
        <div className="min-w-0 flex-1">
          {/* Title owns its line. It used to sit in a flex row beside
              the pills under `truncate`, so a long name lost its tail
              to an ellipsis while the pills kept their width: the
              title, the one thing that identifies the item, was the
              part that got cut. Pills drop underneath and the title
              wraps instead. */}
          <div className="min-w-0">
            <h1 className="text-xl font-semibold leading-tight tracking-tight">
              {item.title}
            </h1>
            <ItemPills
              className="mt-1.5"
              type={item.type}
              access={item.access}
              license={item.license}
              geometryTypes={v3Layers?.map((l) => l.geometryType)}
            />
          </div>
        </div>
        {/* #323: forms get a prominent Open (respondent runtime) +
            View Responses (implicit response viewer) pair right in
            the header. Visible to anyone who can read the form, not
            gated by canManage -- a viewer with edit-rows access still
            wants to submit a response or browse responses. Both open
            in a new tab so the form detail page stays as the
            persistent landing strip the user can keep reaching from. */}
        {item.type === 'form' ? (
          <div className="flex shrink-0 items-center gap-2">
            <a
              href={`/forms/${item.id}/respond`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-transparent bg-accent px-3 text-xs font-medium text-white shadow-card hover:bg-accent/90"
              title="Open the form to submit a response"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </a>
            <a
              href={`/items/${item.id}/responses`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 shadow-card hover:bg-surface-2"
              title="Browse submitted responses on a map and through the form view"
            >
              <ClipboardList className="h-3.5 w-3.5" />
              Responses
            </a>
          </div>
        ) : null}
        {/* #185: layer-ish items can jump straight onto a map, new
            (scratch, #187) or existing. Available to viewers too:
            making a map from something you can see is a read
            operation until you save. Elevation layers and vector
            tile packages are excluded (they're consumed through
            the terrain picker / basemap flow instead). */}
        {(item.type === 'data_layer' ||
          item.type === 'derived_layer' ||
          item.type === 'point_cloud' ||
          item.type === 'arcgis_service' ||
          (item.type === 'tile_layer' &&
            !(item.data as { dem?: boolean } | null)?.dem &&
            (item.data as { kind?: string } | null)?.kind !== 'vector')) ? (
          <div className="flex shrink-0 items-center">
            <AddToMapButton itemId={item.id} />
          </div>
        ) : null}
        {canManage ? (
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={`/items/${item.id}/edit`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 shadow-card hover:bg-surface-2"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Link>
            {/* #82: contextual entry into the derived-layer wizard
                from a data_layer detail page.  Pre-seeds the source
                picker with this item so authors discover derivation
                without having to know the type name.  Only shown
                for data_layer items because that's the only source
                kind the wizard supports today; once derived-of-
                derived chaining lands (#78 engine work) this gate
                can widen to include derived_layer items too. */}
            {item.type === 'data_layer' ? (
              <Link
                href={`/items/new?type=derived_layer&source=${item.id}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 shadow-card hover:bg-surface-2"
                title="Create a derived layer with this layer as its source"
              >
                <FlaskConical className="h-3.5 w-3.5" />
                Derive...
              </Link>
            ) : null}
            <ReassignOwnerButton
              itemId={item.id}
              itemTitle={item.title}
              currentOwnerId={item.ownerId}
              currentOwnerLabel={(() => {
                if (item.ownerId === me.id) return 'you';
                const ownerInfo = (
                  item as unknown as {
                    owner?: { fullName?: string; username?: string } | null;
                  }
                ).owner;
                if (ownerInfo?.fullName?.trim()) return ownerInfo.fullName;
                if (ownerInfo?.username) return ownerInfo.username;
                return item.ownerId.slice(0, 8);
              })()}
            />
            <DeleteItemButton
              itemId={item.id}
              itemTitle={item.title}
              itemType={item.type}
            />
          </div>
        ) : null}
      </header>
      {/* Collapsed details: description + owner + updated + tags.
          Uses the native <details> element so it works without any
          client-side JS and stays accessible. Shown only when the
          user has something worth seeing (description OR tags). */}
      {item.description || item.tags.length > 0 ? (
        <details className="group mb-4 rounded-md border border-border bg-surface-1">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs text-muted hover:text-ink-1">
            <span className="inline-flex items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Updated {new Date(item.updatedAt).toLocaleString()}
              </span>
              <span className="inline-flex items-center gap-1">
                <User className="h-3 w-3" />
                Owner:{' '}
                {item.ownerId === me.id
                  ? 'you'
                  : (item as unknown as { owner?: { fullName?: string; username?: string } | null }).owner?.fullName?.trim() ||
                    (item as unknown as { owner?: { username?: string } | null }).owner?.username ||
                    item.ownerId.slice(0, 8)}
              </span>
              {item.tags.length > 0 ? (
                <span className="text-muted">
                  · {item.tags.length}{' '}
                  {item.tags.length === 1 ? 'tag' : 'tags'}
                </span>
              ) : null}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-3 border-t border-border px-3 py-3">
            {item.description ? (
              <p className="text-sm text-ink-1">{item.description}</p>
            ) : null}
            {item.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {item.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-2xs text-muted"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </details>
      ) : (
        // No description/tags: still show the updated + owner line
        // so users have at least the audit trail visible.
        (<div className="mb-4 flex items-center gap-3 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            Updated {new Date(item.updatedAt).toLocaleString()}
          </span>
          <span className="inline-flex items-center gap-1">
            <User className="h-3 w-3" />
            Owner:{' '}
            {item.ownerId === me.id
              ? 'you'
              : (item as unknown as { owner?: { fullName?: string; username?: string } | null }).owner?.fullName?.trim() ||
                (item as unknown as { owner?: { username?: string } | null }).owner?.username ||
                item.ownerId.slice(0, 8)}
          </span>
        </div>)
      )}
      {item.type === 'map' && isBuilderView ? (
        <MapEditor
          itemId={item.id}
          itemTitle={item.title}
          initial={{ ...DEFAULT_MAP, ...((item.data ?? {}) as Partial<MapData>) }}
          canEdit={canManage}
          {...(searchParams?.add ? { addItemId: searchParams.add } : {})}
          basemaps={basemaps}
          defaultExtentBoundary={defaultExtentBoundary}
          geoBoundaries={geoBoundaries.map((g) => ({
            id: g.id,
            title: g.title,
          }))}
          currentUser={{
            id: me.id,
            displayName:
              (me.fullName && me.fullName.trim().length > 0
                ? me.fullName
                : null) ??
              me.username ??
              'Reviewer',
          }}
        />
      ) : item.type === 'map' && !isBuilderView ? (
        <section className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 p-4 shadow-card">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink-0">Map configuration</p>
            <p className="mt-0.5 text-xs text-muted">
              Open the full-screen builder to add layers, configure
              basemaps and search, and arrange the canvas.
            </p>
          </div>
          {canManage ? (
            <Link
              href={`/items/${item.id}?view=configure`}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90"
            >
              <Pencil className="h-4 w-4" />
              Configure
            </Link>
          ) : null}
        </section>
      ) : item.type === 'data_layer' ? (
        <>
          {/* #115: live banner for async import jobs. Self-hides when
              there's nothing to show; polls every 2.5s while jobs are
              active and triggers router.refresh() once the queue
              drains so the SSR feature counts re-render with the
              freshly-imported rows. */}
          <ImportJobsBanner itemId={item.id} />
          {/* #52: the hero. A v3 data_layer previously showed no map
              and no statistics anywhere on this page (the count card
              and bbox preview live in the v1/v2 editor, which v3 does
              not mount), so the modern path was the poorer one. The
              preview draws the same MVT tiles the map editor draws,
              which is what keeps it honest under row scoping. */}
          {v3Layers ? (
            <section className="mb-4 space-y-3">
              <ItemMapPreview itemId={item.id} layers={v3Layers} />
              <ItemStatsStrip
                itemId={item.id}
                layers={v3Layers.map((l) => ({
                  id: l.id,
                  geometryType: l.geometryType,
                  fieldCount: l.fields.length,
                }))}
                updatedAt={item.updatedAt}
                sourceSrs={v3Layers.find((l) => l.source?.sourceSrs)?.source?.sourceSrs}
              />
            </section>
          ) : null}
          {/* Provenance panel runs above the schema editor so 'where
              did this come from?' is answered before 'here's the
              field list.' Silent when the item has no source block
              recorded (legacy / hand-seeded). */}
          <DataLayerProvenance
            data={item.data as DataLayerData | null}
            userNames={userNamesForProvenance}
          />
          {/* Schema inspector collapses by default (the editor below
              is the primary surface); opens to show the field table
              and a raw JSON disclosure for debugging. */}
          <DataLayerSchema
            data={item.data as DataLayerData | null}
          />
          {/* Version history: prior snapshots of item.data with
              point-in-time revert. Editors / admins only; the panel
              itself guards on canEdit so the mount here is cheap. */}
          <VersionHistoryPanel itemId={item.id} canEdit={canManage} />
          {/* v3 items route to the new multi-layer schema editor. v1/v2
              continue to use the legacy single-layer editor so existing
              items keep working exactly as before. */}
          {v3Data ? (
            <section className="mb-6">
              <DataLayerV3SchemaEditor
                itemId={item.id}
                initial={v3Data}
                canEdit={canManage}
                canDownload={canDownload}
              />
            </section>
          ) : (
            <section className="mb-6">
              <DataLayerEditor
                itemId={item.id}
                initial={
                  (item.data as DataLayerData | null)?.version === 2
                    ? (item.data as DataLayerData)
                    : ({
                        ...DEFAULT_DATA_LAYER,
                        ...((item.data ?? {}) as Partial<DataLayerData>),
                      } as DataLayerData)
                }
                canEdit={canManage}
              />
            </section>
          )}
        </>
      ) : item.type === 'arcgis_service' ? (
        <section className="mb-6">
          {/* #304 slice 8: defensive route. If the row already carries
              the unified `protocol` discriminator (e.g. it was written
              through the new wizard before its type field was rewritten,
              or the migration partially landed), prefer the unified
              ServiceEditor over the legacy ArcgisServiceEditor so the
              user sees one consistent surface. */}
          {(() => {
            const sd = item.data as ServiceData | null;
            if (sd && typeof sd === 'object' && 'protocol' in sd) {
              return (
                <ServiceEditor
                  itemId={item.id}
                  initial={sd}
                  canEdit={canManage}
                />
              );
            }
            return (
              <ArcgisServiceEditor
                itemId={item.id}
                initial={{
                  ...DEFAULT_ARCGIS_SERVICE,
                  ...((item.data ?? {}) as Partial<ArcgisServiceData>),
                }}
                canEdit={canManage}
              />
            );
          })()}
        </section>
      ) : item.type === 'derived_layer' ? (
        <DerivedLayerDetail
          data={(item.data ?? {}) as DerivedLayerData}
        />
      ) : item.type === 'tool' ? (
        // #90: tool item detail page.  Minimal editor for the
        // tool's stored action.  Lives in its own component so the
        // detail page stays narrow.
        (<section className="mb-6">
          <ToolDetail
            itemId={item.id}
            initial={(item.data ?? null) as ToolItemData | null}
            canEdit={canManage}
          />
        </section>)
      ) : item.type === 'pick_list' ? (
        <section className="mb-6">
          <PickListEditor
            itemId={item.id}
            initial={{
              ...DEFAULT_PICK_LIST,
              ...((item.data ?? {}) as Partial<PickListData>),
            }}
            canEdit={canManage}
          />
        </section>
      ) : item.type === 'geo_boundary' ? (
        <GeoBoundaryEditor
          itemId={item.id}
          initial={{
            ...DEFAULT_GEO_BOUNDARY,
            ...((item.data ?? {}) as Partial<GeoBoundaryData>),
          }}
          canEdit={canManage}
        />
      ) : item.type === 'folder' ? (
        <section className="mb-6">
          <FolderDetail
            itemId={item.id}
            initial={{
              ...DEFAULT_FOLDER,
              ...((item.data ?? {}) as Partial<FolderData>),
            }}
            updatedAt={item.updatedAt}
            initialChildren={folderChildren as Parameters<typeof FolderDetail>[0]['initialChildren']}
            breadcrumb={folderBreadcrumb}
            canEdit={canManage}
            canCreate={me.orgRole !== 'viewer'}
            folderShares={item.shares}
            folderAccess={item.access}
          />
        </section>
      ) : isEditorItem(item) ? (
        <section className="mb-6">
          <EditorDetail
            itemId={item.id}
            initial={{
              ...DEFAULT_EDITOR,
              ...((readEditorData(item) ?? {}) as Partial<EditorData>),
            }}
            canEdit={canManage}
          />
        </section>
      ) : isViewerItem(item) ? (
        <section className="mb-6">
          {/* #259 slice 3: real configuration surface. Pick a
              reference map, manage target layers, and trim the
              read-side toolbar. canEdit follows the same owner /
              admin gate every other detail editor uses. */}
          <ViewerDetail
            itemId={item.id}
            initial={{
              ...DEFAULT_VIEWER,
              ...((readViewerData(item) ?? {}) as Partial<ViewerData>),
            }}
            canEdit={canManage}
          />
        </section>
      ) : isCustomAppItem(item) && isBuilderView ? (
        <CustomAppDetail
          itemId={item.id}
          itemTitle={item.title}
          initial={{
            ...DEFAULT_CUSTOM_APP,
            ...((readCustomAppData(item) ?? {}) as Partial<CustomAppData>),
          }}
          canEdit={canManage}
          themeItems={themeItems}
        />
      ) : isCustomAppItem(item) && !isBuilderView ? (
        <section className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 p-4 shadow-card">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink-0">
              Custom web app configuration
            </p>
            <p className="mt-0.5 text-xs text-muted">
              Open the full-screen builder to drag widgets onto the
              canvas, arrange pages, and bind data layers.
            </p>
          </div>
          {canManage ? (
            <Link
              href={`/items/${item.id}?view=configure`}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90"
            >
              <Pencil className="h-4 w-4" />
              Configure
            </Link>
          ) : null}
        </section>
      ) : item.type === 'data_collection' ? (
        <section className="mb-6">
          <DataCollectionDetail
            itemId={item.id}
            initial={
              // The wizard always writes a complete DataCollectionData,
              // but tolerate partial shapes the same way the other
              // detail bodies do: a future migration that adds a field
              // shouldn't 500 the page on items written before the
              // bump. mapId is required by the type but we trust the
              // server-side validation and the Slice 1 wizard's
              // mapId guard.
              (item.data ?? {}) as DataCollectionData
            }
          />
        </section>
      ) : item.type === 'form' ? (
        <section className="mb-6">
          {/* #328: pretty pill row of actions sits ABOVE the form
              designer so it's reachable without scrolling past the
              question canvas. Mirrors the page-header buttons (#323)
              for users who land here scrolled down -- the canvas can
              be tall enough that the header pushes offscreen, so
              having the same affordances in two places is intentional
              redundancy. The row also gains a Copy link button for
              the "paste this somewhere" workflow that the inline
              URL used to serve. */}
          {(() => {
            const linkedLayerId =
              item.data &&
              typeof item.data === 'object' &&
              'linkedLayerId' in (item.data as object)
                ? ((item.data as { linkedLayerId?: unknown }).linkedLayerId)
                : undefined;
            return (
              <FormActionsRow
                formId={item.id}
                linkedLayerId={
                  typeof linkedLayerId === 'string' && linkedLayerId
                    ? linkedLayerId
                    : null
                }
              />
            );
          })()}
          <FormDesigner
            itemId={item.id}
            initial={
              item.data && typeof item.data === 'object' && 'questions' in (item.data as object)
                ? ((item.data as unknown) as FormSchema)
                : null
            }
            canEdit={canManage}
          />
        </section>
      ) : item.type === 'wms_service' || item.type === 'wfs_service' ? (
        <section className="mb-6">
          {/* #304 slice 8: same defensive-route check as the
              arcgis_service branch above. After the migration runs,
              new items land here as type='service' so this branch only
              executes for legacy rows: but if any happen to already
              carry the unified `protocol` discriminator (partial-
              migration edge case), prefer the unified ServiceEditor. */}
          {(() => {
            const sd = item.data as ServiceData | null;
            if (sd && typeof sd === 'object' && 'protocol' in sd) {
              return (
                <ServiceEditor
                  itemId={item.id}
                  initial={sd}
                  canEdit={canManage}
                />
              );
            }
            return (
              <OgcServiceEditor
                itemId={item.id}
                kind={item.type === 'wms_service' ? 'wms' : 'wfs'}
                initial={
                  (item.data ?? {}) as WmsServiceData | WfsServiceData
                }
                canEdit={canManage}
              />
            );
          })()}
        </section>
      ) : item.type === 'service' ? (
        <section className="mb-6">
          {/* #304 slice 4: unified Connected Service detail page.
              Branches on data.protocol internally so all six
              protocol variants share one editor. Falls through to
              ComingSoon if data is missing or malformed; in
              practice the wizard always writes a complete
              ServiceData payload (the probe-or-bail submit guard
              in slice 3). */}
          {(() => {
            const sd = item.data as ServiceData | null;
            if (!sd || typeof sd !== 'object' || !('protocol' in sd)) {
              return <ComingSoon type={item.type} data={item.data} />;
            }
            return (
              <ServiceEditor
                itemId={item.id}
                initial={sd}
                canEdit={canManage}
              />
            );
          })()}
        </section>
      ) : item.type === 'file' ? (
        <section className="mb-6">
          {/* #296: file items render their metadata + an inline preview
              when the MIME type supports one (image / PDF). The
              Download button is gated by canDownload so a view-only
              share doesn't get a free copy of the bytes. The
              underlying MinIO URL is bucket-public, so "view only"
              just hides the affordance -- not a perfect ACL but it
              matches every other public asset we serve and keeps the
              UI honest about what the share actually grants. */}
          {(() => {
            const fileData =
              item.data && typeof item.data === 'object' && !Array.isArray(item.data)
                ? (item.data as Partial<FileData>)
                : ({} as Partial<FileData>);
            // Defensive read: an item written before #296 (or one with
            // a corrupted data blob) should still render the page with
            // a friendly empty state rather than blowing up server-
            // side. Required string fields default to empty so the
            // detail body shows "No file" gracefully.
            const safe: FileData = {
              version: 1,
              storageKey:
                typeof fileData.storageKey === 'string' ? fileData.storageKey : '',
              storageUrl:
                typeof fileData.storageUrl === 'string' ? fileData.storageUrl : '',
              fileName:
                typeof fileData.fileName === 'string' ? fileData.fileName : '',
              mimeType:
                typeof fileData.mimeType === 'string'
                  ? fileData.mimeType
                  : 'application/octet-stream',
              sizeBytes:
                typeof fileData.sizeBytes === 'number' ? fileData.sizeBytes : 0,
              uploadedAt: (typeof fileData.uploadedAt === 'string'
                ? fileData.uploadedAt
                : new Date(0).toISOString()) as FileData['uploadedAt'],
            };
            // canDownload comes from the server's permissions
            // endpoint (#32) via the parallel fetch batch above, so
            // per-share download grants are honored here too.
            return <FileDetail data={safe} canDownload={canDownload} />;
          })()}
        </section>
      ) : item.type === 'tile_layer' ? (
        <section className="mb-6">
          {/* #179: tile_layer detail editor. Upload a PMTiles
              file, see metadata + preview, copy the pmtiles://
              tile URL for use in basemaps. */}
          <TileLayerEditor
            itemId={item.id}
            initial={
              (item.data && typeof item.data === 'object'
                ? item.data
                : {
                    version: 1,
                    format: 'pmtiles',
                    kind: 'raster',
                    storageKey: '',
                    storageUrl: '',
                    fileName: '',
                    sizeBytes: 0,
                    uploadedAt: new Date(0).toISOString(),
                  }) as import('@gratis-gis/shared-types').TileLayerData
            }
            canEdit={canManage}
          />
        </section>
      ) : item.type === 'point_cloud' ? (
        <section className="mb-6">
          {/* #179: point_cloud detail panel. Upload a COPC file,
              see header metadata, copy the streaming URL. 3D
              preview arrives with the viewer unit. */}
          <PointCloudPanel
            itemId={item.id}
            initial={
              (item.data && typeof item.data === 'object'
                ? item.data
                : {
                    version: 1,
                    format: 'copc',
                    storageKey: '',
                    storageUrl: '',
                    fileName: '',
                    sizeBytes: 0,
                    uploadedAt: new Date(0).toISOString(),
                  }) as import('@gratis-gis/shared-types').PointCloudData
            }
            canEdit={canManage}
          />
        </section>
      ) : item.type === 'script' ? (
        <section className="mb-6">
          {/* #221: user-authored Python, run server-side. A textarea
              rather than a code editor on purpose: authoring belongs
              in the author's own editor, and this surface exists to
              paste, save, run, and read what happened. */}
          <ScriptPanel
            itemId={item.id}
            initial={
              (item.data && typeof item.data === 'object'
                ? item.data
                : { version: 1, source: '' }) as ScriptData
            }
            canEdit={canManage}
          />
        </section>
      ) : item.type === 'geocoding_service' ? (
        <section className="mb-6">
          {/* #74: geocoding_service detail editor. Authoring flow
              (pick source layer, pick fields, configure weights /
              label / bbox) + a test panel that runs against the
              saved config so the author can validate. */}
          <GeocodingServiceEditor
            itemId={item.id}
            initial={
              (item.data && typeof item.data === 'object'
                ? item.data
                : { version: 1, sourceLayerId: '', searchFields: [] }) as import('@gratis-gis/shared-types').GeocodingServiceData
            }
            canEdit={canManage}
          />
        </section>
      ) : item.type === 'basemap' ? (
        <section className="mb-6">
          {/* #144: basemap detail editor. Wraps the same
              BasemapConfigSection the new-item wizard uses
              (including the Probe URL tab) so a misconfigured
              basemap can be fixed in place rather than deleted
              and recreated. Read-only viewers see the source
              but can't edit it. Defensive read with isBasemapData
              would be tidier, but the api guarantees the shape
              for type='basemap' so the cast is safe in practice. */}
          <BasemapEditor
            itemId={item.id}
            initial={
              (item.data && typeof item.data === 'object'
                ? item.data
                : { version: 1, kind: 'tile-url' }) as BasemapData
            }
            canEdit={canManage}
          />
        </section>
      ) : item.type === 'app_template' ? (
        <AppTemplateDetail
          itemId={item.id}
          blueprint={
            (item.data && typeof item.data === 'object'
              ? item.data
              : { version: 3, themePresetId: 'default', targets: [], pages: [] }) as CustomAppData
          }
          seedKind={(item as { seedKind?: string | null }).seedKind ?? null}
        />
      ) : item.type === 'theme' ? (
        <AppThemeDetail
          itemId={item.id}
          initialBlueprint={
            (item.data && typeof item.data === 'object'
              ? item.data
              : { version: 1, swatch: '', tokens: {} }) as {
              version?: number;
              swatch?: string;
              tokens?: Record<string, string>;
            }
          }
          seedKind={(item as { seedKind?: string | null }).seedKind ?? null}
          canEdit={canManage}
        />
      ) : item.type === 'print_template' && isBuilderView ? (
        <PrintTemplateDetail
          itemId={item.id}
          initialBlueprint={
            (item.data && typeof item.data === 'object'
              ? item.data
              : DEFAULT_PRINT_TEMPLATE) as PrintTemplateData
          }
          seedKind={(item as { seedKind?: string | null }).seedKind ?? null}
          canEdit={canManage}
        />
      ) : item.type === 'print_template' && !isBuilderView ? (
        // Metadata-first landing for print templates -- same shape as
        // the map / web_app gates above.  The full-screen designer
        // opens via ?view=configure so it gets the BuilderShell's
        // full real estate (paper canvas + element palette + props
        // panel won't fit comfortably inside the regular item-detail
        // chrome).
        (<section className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 p-4 shadow-card">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink-0">Print template designer</p>
            <p className="mt-0.5 text-xs text-muted">
              Open the full-screen builder to edit the paper layout,
              element positions, and declared parameters.
            </p>
          </div>
          {canManage ? (
            <Link
              href={`/items/${item.id}?view=configure`}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent/90"
            >
              Open builder
            </Link>
          ) : null}
        </section>)
      ) : (
        <section className="mb-6">
          <ComingSoon type={item.type} data={item.data} />
        </section>
      )}
      {/* Dependency panel runs above Sharing for everyone: knowing
          what else will break if you touch this item is the same
          shape of question whether you're the owner or a viewer. */}
      <section className="mb-8">
        <ItemDependencies itemId={item.id} />
      </section>
      {canManage ? (
        <section id="sharing" className="mb-8">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-medium text-muted">
            <Users className="h-4 w-4" />
            Sharing
          </h2>
          {/* #91: forms have a paired data_layer where every
              submission lands; the form's own ACL controls who can
              SUBMIT, the layer's ACL controls who can VIEW
              responses. Surface the paired layer's current tier
              + deep-link so authors don't have to discover the
              dual-ACL model the hard way. */}
          {item.type === 'form' ? (
            <PairedLayerSharingNotice
              formId={item.id}
              linkedLayerId={
                item.data &&
                typeof item.data === 'object' &&
                'linkedLayerId' in (item.data as object) &&
                typeof (item.data as { linkedLayerId?: unknown })
                  .linkedLayerId === 'string'
                  ? ((item.data as { linkedLayerId: string }).linkedLayerId)
                  : null
              }
            />
          ) : null}
          <SharingPanel
            itemId={item.id}
            itemTitle={item.title}
            // #258: editor-templated web_apps need the same
            // dep-chain pre-share audit the legacy 'editor' type
            // gets. Pass 'editor' for either shape so SharingPanel's
            // internal `'editor'` branches fire correctly without
            // having to plumb the WebAppData shape into it. Rename
            // the prop to something less type-shaped (like
            // `dependencyChainKind`) when the deprecation window
            // closes and the literal 'editor' type goes away.
            itemType={isEditorItem(item) ? 'editor' : item.type}
            initialAccess={item.access}
            initialShares={item.shares}
            // #80: tier-level geo-boundary refs surface in
            // SharingPanel's tier-scope picker. The fields are
            // optional on the Item type since slice 1 added them as
            // nullable columns; defaulting to null keeps callers
            // pre-#80 deploy compatible during the rolling deploy.
            initialPublicGeoBoundaryId={
              (item as { publicGeoBoundaryId?: string | null })
                .publicGeoBoundaryId ?? null
            }
            initialOrgGeoBoundaryId={
              (item as { orgGeoBoundaryId?: string | null })
                .orgGeoBoundaryId ?? null
            }
            geoBoundaryItems={geoBoundaries.map((b) => ({
              id: b.id,
              title: b.title,
            }))}
            groups={groups}
            orgLabel="Your organization"
          />
        </section>
      ) : null}
    </div>
  );
}
