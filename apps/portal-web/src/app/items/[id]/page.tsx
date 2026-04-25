import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Calendar,
  ChevronDown,
  Globe2,
  Lock,
  Pencil,
  User,
  Users,
} from 'lucide-react';
import type {
  BasemapData,
  FolderData,
  Item,
  ItemShare,
  Group,
  User as UserT,
  ArcgisServiceData,
  DataLayerData,
  GeoBoundaryData,
  PickListData,
  MapData,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_ARCGIS_SERVICE,
  DEFAULT_DATA_LAYER,
  DEFAULT_FOLDER,
  DEFAULT_GEO_BOUNDARY,
  DEFAULT_PICK_LIST,
  DEFAULT_MAP,
} from '@gratis-gis/shared-types';
import { EntityBadge } from '@gratis-gis/ui';
import { ItemTypeBadge, getItemTypeLabel } from '@/lib/item-type-icon';
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
import { SharingPanel } from './sharing-panel';
import { ItemDependencies } from './item-dependencies';
import { DeleteItemButton } from './delete-button';
import { ReassignOwnerButton } from './reassign-owner-button';
import { MapEditor } from './map/map-editor';
import { DataLayerEditor } from './data-layer/editor';
import { DataLayerV3SchemaEditor } from './data-layer/v3-schema-editor';
import { ArcgisServiceEditor } from './arcgis-service/editor';
import { PickListEditor } from './pick-list/editor';
import { GeoBoundaryEditor } from './geo-boundary/editor';
import { FolderDetail } from './folder/folder-detail';
import { DataLayerProvenance } from './data-layer/provenance-panel';
import { DataLayerSchema } from './data-layer/schema-panel';
import { VersionHistoryPanel } from './data-layer/version-history-panel';
import { ComingSoon } from './coming-soon';

interface Props {
  params: { id: string };
}

type ItemWithShares = Item & { shares: ItemShare[] };

const typeBadge: Record<string, string> = {
  map: 'bg-emerald-100 text-emerald-800',
  data_layer: 'bg-sky-100 text-sky-800',
  arcgis_service: 'bg-cyan-100 text-cyan-800',
  form: 'bg-violet-100 text-violet-800',
  web_app: 'bg-amber-100 text-amber-800',
  report_template: 'bg-rose-100 text-rose-800',
  dashboard: 'bg-indigo-100 text-indigo-800',
  file: 'bg-slate-100 text-slate-800',
  notebook: 'bg-fuchsia-100 text-fuchsia-800',
  tool: 'bg-teal-100 text-teal-800',
};

const accessIcon = {
  private: <Lock className="h-3.5 w-3.5" />,
  org: <Building2 className="h-3.5 w-3.5" />,
  public: <Globe2 className="h-3.5 w-3.5" />,
};

export default async function ItemDetailPage({ params }: Props) {
  // Phase 1: the two unconditional fetches in parallel. Item is the
  // only one that can legitimately 404 (item missing / not visible),
  // so we wrap with try/catch but still fan out alongside `me`.
  // Without parallelisation the page paid two sequential round-trips
  // before doing anything else; with it we pay one wall-clock unit
  // for both. Same for the bigger second batch below.
  type InheritedShare = ItemShare & {
    fromFolderId: string;
    fromFolderTitle: string;
  };
  let item: ItemWithShares;
  let me: { id: string; orgRole: string };
  try {
    [item, me] = await Promise.all([
      apiFetch<ItemWithShares>(`/api/items/${params.id}`),
      apiFetch<{ id: string; orgRole: string }>('/api/users/me'),
    ]);
  } catch (err) {
    // apiFetch throws on non-2xx. 404 from the API means "not found
    // or not visible to you" (same response to prevent enumeration).
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }
  const canManage = me.id === item.ownerId || me.orgRole === 'admin';
  const isMap = item.type === 'map';
  const isFolder = item.type === 'folder';
  const mapData = isMap ? (item.data as MapData | null) : null;

  // Phase 2: fan out every other server-side fetch in one parallel
  // batch. Each is independent of the others; the only sequential
  // dependency is "we needed item.type and canManage first," which
  // is now resolved. Wall-clock cost goes from sum-of-7-fetches to
  // max-of-7-fetches. Failures are non-fatal per-fetch (same as the
  // sequential version was).
  const [
    basemaps,
    defaultExtentBoundary,
    folderChildren,
    allFoldersForBreadcrumb,
    geoBoundaries,
    groups,
    inheritedShares,
  ] = await Promise.all([
    // Web map basemap library.
    isMap
      ? apiFetch<Array<Item<BasemapData>>>('/api/items?type=basemap')
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
    isFolder
      ? apiFetch<ItemWithShares[]>('/api/items?type=folder').catch(
          () => [] as ItemWithShares[],
        )
      : Promise.resolve([] as ItemWithShares[]),
    // Geo-boundary library for the map editor's "Default extent" picker.
    isMap
      ? apiFetch<Array<Item<GeoBoundaryData>>>(
          '/api/items?type=geo_boundary',
        ).catch(() => [] as Array<Item<GeoBoundaryData>>)
      : Promise.resolve([] as Array<Item<GeoBoundaryData>>),
    // Groups for the share picker. Only managers see the picker, so
    // skip the fetch otherwise -- saves a round-trip on the read path.
    canManage
      ? apiFetch<Group[]>('/api/groups').catch(() => [] as Group[])
      : Promise.resolve([] as Group[]),
    // Inherited shares (#44 phase 1c slice 3c). Only managers see
    // them; same skip-when-not-needed logic as groups.
    canManage
      ? apiFetch<InheritedShare[]>(
          `/api/items/${item.id}/inherited-shares`,
        ).catch(() => [] as InheritedShare[])
      : Promise.resolve([] as InheritedShare[]),
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

  const badgeClass = typeBadge[item.type] ?? 'bg-slate-100 text-slate-800';
  // "Workspace" item types are content-heavy (map, feature service,
  // arcgis service). For those, we collapse the metadata header so the
  // actual editor is the first thing the user sees. Other types keep
  // the standard, richer header because their "content" is basically
  // metadata + some small payload anyway.
  const isWorkspace =
    item.type === 'map' ||
    item.type === 'data_layer' ||
    item.type === 'arcgis_service';
  // Bump the container up for workspace types so the map gets more
  // horizontal room; other pages keep the old 6xl width.
  const containerWidth = isWorkspace ? 'max-w-7xl' : 'max-w-6xl';

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
      <header className="mb-4 flex items-center gap-3">
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
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {item.title}
            </h1>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide ${badgeClass}`}
            >
              {getItemTypeLabel(item.type)}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
              {accessIcon[item.access]}
              {item.access}
            </span>
          </div>
        </div>
        {canManage ? (
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={`/items/${item.id}/edit`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 shadow-card hover:bg-surface-2"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Link>
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
            <DeleteItemButton itemId={item.id} itemTitle={item.title} />
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
                    className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-muted"
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
        <div className="mb-4 flex items-center gap-3 text-xs text-muted">
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
        </div>
      )}

      {item.type === 'map' ? (
        <section className="mb-6">
          <MapEditor
            itemId={item.id}
            initial={{ ...DEFAULT_MAP, ...((item.data ?? {}) as Partial<MapData>) }}
            canEdit={canManage}
            basemaps={basemaps}
            defaultExtentBoundary={defaultExtentBoundary}
            geoBoundaries={geoBoundaries.map((g) => ({
              id: g.id,
              title: g.title,
            }))}
          />
        </section>
      ) : item.type === 'data_layer' ? (
        <>
          {/* Provenance panel runs above the schema editor so 'where
              did this come from?' is answered before 'here's the
              field list.' Silent when the item has no source block
              recorded (legacy / hand-seeded). */}
          <DataLayerProvenance
            data={item.data as DataLayerData | null}
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
          {(item.data as DataLayerData | null)?.version === 3 ? (
            <section className="mb-6">
              <DataLayerV3SchemaEditor
                itemId={item.id}
                initial={
                  item.data as unknown as import('@gratis-gis/shared-types').DataLayerDataV3
                }
                canEdit={canManage}
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
          <ArcgisServiceEditor
            itemId={item.id}
            initial={{
              ...DEFAULT_ARCGIS_SERVICE,
              ...((item.data ?? {}) as Partial<ArcgisServiceData>),
            }}
            canEdit={canManage}
          />
        </section>
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
            initialChildren={folderChildren as Parameters<typeof FolderDetail>[0]['initialChildren']}
            breadcrumb={folderBreadcrumb}
            canEdit={canManage}
            canCreate={me.orgRole !== 'viewer'}
          />
        </section>
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
          <SharingPanel
            itemId={item.id}
            initialAccess={item.access}
            initialShares={item.shares}
            inheritedShares={inheritedShares}
            groups={groups}
            orgLabel="Your organization"
          />
        </section>
      ) : null}
    </div>
  );
}
