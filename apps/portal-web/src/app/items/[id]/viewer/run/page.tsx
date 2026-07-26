// SPDX-License-Identifier: AGPL-3.0-or-later
import { notFound } from 'next/navigation';
import type {
  BasemapData,
  DataLayerData,
  DataLayerSublayer,
  EditorData,
  EditorTarget,
  Item,
  MapData,
  PickListData,
  ViewerData,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_VIEWER,
  isViewerItem,
  readViewerData,
} from '@gratis-gis/shared-types';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { apiFetch, hasSession, publicApiFetch } from '@/lib/api';
import {
  buildEditorMapData,
  type ResolvedTarget,
} from '../../editor/build-map-data';
import { EditorRuntime } from '../../editor/editor-runtime';

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Map a basemap item into the CustomBasemap shape MapCanvas
 * consumes. Mirrors the helper in editor/run/page.tsx; extracted to
 * a shared util once a third caller appears.
 */
function basemapItemToCustomBasemap(
  it: Item<BasemapData>,
): CustomBasemap | null {
  const d = it.data ?? ({} as BasemapData);
  let url: string | undefined;
  let sourceKind: CustomBasemap['sourceKind'];
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

/**
 * Synthesize an EditorData payload from a ViewerData so the runtime
 * (which is the read-side substrate the editor already runs on) can
 * render the viewer with no behavioral branching. Every target gets
 * its capability flags zeroed out and its templates dropped so the
 * runtime + the server agree the user has no write capability here.
 *
 * The returned shape is what EditorRuntime expects; we set
 * canEdit=false at the call site too as a belt-and-suspenders gate
 * against any future runtime path that consults the prop directly.
 *
 * The viewer's own `tools` list is intentionally not piped into the
 * editor's `tools` field: those refer to write-side tools the editor
 * exposes (add, edit, delete, snap, undo, redo). The viewer's
 * read-side tools (select, query, measure, attribute-table, legend,
 * print) are always available in the runtime today; print is the
 * follow-up slice that adds a new toolbar entry.
 */
function viewerToEditor(viewer: ViewerData): EditorData {
  const targets: EditorTarget[] = viewer.targets.map((t) => ({
    dataLayerId: t.dataLayerId,
    layerKey: t.layerKey,
    canCreate: false,
    canEditGeometry: false,
    canEditAttributes: false,
    canDelete: false,
    editableFields: [],
    rowScope: 'all',
    templates: [],
  }));
  // The viewer's tool list overlaps with EditorTool for the read-side
  // affordances ('select', 'measure'). Pipe those through to the
  // synthesized EditorData so the existing top-left palette in the
  // runtime renders them. Viewer-specific tools that aren't in
  // EditorTool ('query', 'attribute-table', 'legend', 'print') stay
  // out of this list:
  //   - print is handled by `printEnabled` (#259 slice 4)
  //   - attribute-table / legend are always-on chrome today; a
  //     follow-up slice can gate them on the toggle
  //   - query is not implemented yet (Phase 2)
  const passthrough: Array<'select' | 'measure'> = [];
  if (viewer.tools.includes('select')) passthrough.push('select');
  if (viewer.tools.includes('measure')) passthrough.push('measure');
  // exactOptionalPropertyTypes: only set mapId when defined; the
  // editor type's `mapId` is string-or-absent, not string-or-undefined.
  const out: EditorData = {
    version: 1,
    targets,
    tools: passthrough,
    snapping: { enabled: false, selfSnap: false, tolerancePx: 10 },
  };
  if (viewer.mapId) out.mapId = viewer.mapId;
  return out;
}

/**
 * Viewer runtime page (#259). Mirrors editor/run/page.tsx structurally
 * and reuses the EditorRuntime as the read-side substrate. The only
 * differences: we call readViewerData / isViewerItem, synthesize an
 * EditorData with all-readonly targets, and pass canEdit=false.
 *
 * Auth: ItemsService.get() on the API enforces visibility (404 on
 * not-found-or-not-allowed). canEdit is forced to false here for the
 * runtime; per-share grants flow through the API.
 */
export default async function ViewerRuntimePage(props: Props) {
  const params = await props.params;
  // #307: viewer/run is in the middleware allowlist, so anonymous
  // visitors can land here. Branch the fetch path: signed-in users
  // get full per-share visibility via /api/items/:id; anonymous
  // users get the public-only surface at /api/public/items/:id,
  // which returns 404 unless access='public'. The page renders
  // identically downstream -- the runtime is read-only either
  // way for viewers.
  const isAnonymous = !(await hasSession());
  const fetchItem = <T,>(path: string): Promise<T> =>
    isAnonymous
      ? publicApiFetch<T>(path.replace('/api/items/', '/api/public/items/'))
      : apiFetch<T>(path);
  const fetchItemList = <T,>(path: string): Promise<T> =>
    isAnonymous
      ? publicApiFetch<T>(path.replace('/api/items', '/api/public/items'))
      : apiFetch<T>(path);

  let viewerItem: Item<unknown>;
  try {
    viewerItem = await fetchItem<Item<unknown>>(`/api/items/${params.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }
  if (!isViewerItem(viewerItem)) notFound();

  const viewer: ViewerData = {
    ...DEFAULT_VIEWER,
    ...((readViewerData(viewerItem) ?? {}) as Partial<ViewerData>),
  };
  const editor = viewerToEditor(viewer);

  const uniqueDataLayerIds = Array.from(
    new Set(editor.targets.map((t) => t.dataLayerId)),
  );

  const [basemapItems, referencedMap, targetItems] = await Promise.all([
    // full=1: the runtime builds renderable basemaps from each row's
    // data payload, which the list now strips by default.
    fetchItemList<Array<Item<BasemapData>>>(
      '/api/items?type=basemap&full=1',
    ).catch(() => [] as Array<Item<BasemapData>>),
    editor.mapId
      ? fetchItem<Item<MapData>>(`/api/items/${editor.mapId}`).catch(
          () => null,
        )
      : Promise.resolve(null),
    Promise.all(
      uniqueDataLayerIds.map((id) =>
        fetchItem<Item<DataLayerData>>(`/api/items/${id}`).catch(() => null),
      ),
    ),
  ]);

  const basemaps: CustomBasemap[] = basemapItems
    .map(basemapItemToCustomBasemap)
    .filter((b): b is CustomBasemap => b !== null);

  const dataLayerById = new Map<string, Item<DataLayerData>>();
  for (let i = 0; i < uniqueDataLayerIds.length; i += 1) {
    const item = targetItems[i];
    if (item) dataLayerById.set(uniqueDataLayerIds[i]!, item);
  }

  const resolvedTargets: ResolvedTarget[] = editor.targets.map((t) => {
    const item = dataLayerById.get(t.dataLayerId);
    let layer: DataLayerSublayer | null = null;
    if (item) {
      const data = item.data as DataLayerData | undefined;
      if (data && data.version === 3) {
        layer = data.layers.find((l) => l.id === t.layerKey) ?? null;
      }
    }
    return {
      dataLayerId: t.dataLayerId,
      layerKey: t.layerKey,
      layer,
      dataLayerTitle: item?.title ?? t.dataLayerId.slice(0, 8),
    };
  });

  const { mapData, targetLayerIds } = buildEditorMapData({
    editor,
    referencedMap,
    resolvedTargets,
  });

  const pickListItemIds = new Set<string>();
  for (const t of resolvedTargets) {
    if (!t.layer) continue;
    for (const f of t.layer.fields) {
      if (f.domain && f.domain.type === 'coded-value-ref') {
        pickListItemIds.add(f.domain.pickListItemId);
      }
    }
  }
  const pickListItems = await Promise.all(
    Array.from(pickListItemIds).map((id) =>
      fetchItem<Item<PickListData>>(`/api/items/${id}`).catch(() => null),
    ),
  );
  const pickLists: Record<string, PickListData> = {};
  for (const it of pickListItems) {
    if (it && it.data) pickLists[it.id] = it.data as PickListData;
  }

  return (
    <EditorRuntime
      editorId={viewerItem.id}
      editorTitle={viewerItem.title}
      editor={editor}
      resolvedTargets={resolvedTargets}
      pickLists={pickLists}
      referencedMapTitle={referencedMap?.title ?? null}
      initialMapData={mapData}
      targetLayerIds={targetLayerIds}
      basemaps={basemaps}
      canEdit={false}
      // #259 slice 4: surface the Print toolbar entry when the
      // viewer's tools list opted into it. Today this is a basic
      // window.print() call; #132 (Print Template item type) will
      // upgrade it to a layout chooser.
      printEnabled={viewer.tools.includes('print')}
    />
  );
}

export const dynamic = 'force-dynamic';
