import { notFound } from 'next/navigation';
import type {
  BasemapData,
  DataLayerData,
  DataLayerSublayer,
  EditorData,
  GeoBoundaryData,
  Item,
  MapData,
} from '@gratis-gis/shared-types';
import { DEFAULT_EDITOR } from '@gratis-gis/shared-types';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { apiFetch } from '@/lib/api';
import { buildEditorMapData, type ResolvedTarget } from '../build-map-data';
import { EditorRuntime } from '../editor-runtime';

interface Props {
  params: { id: string };
}

/**
 * Map a basemap item into the CustomBasemap shape MapCanvas
 * consumes. Mirrors the helper in the standard item detail page;
 * extracted here to avoid a deep cross-file import. We can lift to
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
 * Editor runtime page (slice 3b-1, read-only).
 *
 * Server-side: fetch editor, current user, target data_layers,
 * referenced map, basemap library. Synthesize the runtime MapData
 * once on the server so the client lands ready-to-render with no
 * follow-up I/O. Hand everything to <EditorRuntime>.
 *
 * Auth: ItemsService.get() on the API enforces visibility (404 on
 * not-found-or-not-allowed). The standard detail page handles 404s
 * the same way; we follow the pattern. canEdit is owner-or-admin
 * for now; per-share edit grants for non-owners flow in alongside
 * the actual editing tools in slice 3b-2.
 */
export default async function EditorRuntimePage({ params }: Props) {
  let editorItem: Item<EditorData>;
  let me: { id: string; orgRole: string };
  try {
    [editorItem, me] = await Promise.all([
      apiFetch<Item<EditorData>>(`/api/items/${params.id}`),
      apiFetch<{ id: string; orgRole: string }>('/api/users/me'),
    ]);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }
  if (editorItem.type !== 'editor') notFound();

  // Merge persisted data with defaults so older editors that predate
  // a field don't crash the runtime.
  const editor: EditorData = {
    ...DEFAULT_EDITOR,
    ...((editorItem.data ?? {}) as Partial<EditorData>),
  };

  // Phase 2 fetches in parallel:
  //   - basemap library (for MapCanvas's basemap swap)
  //   - referenced map (its full MapData becomes the composition base)
  //   - all unique target data_layers (for resolving sublayer
  //     metadata used in the layer panel)
  const uniqueDataLayerIds = Array.from(
    new Set(editor.targets.map((t) => t.dataLayerId)),
  );

  const [basemapItems, referencedMap, targetItems] = await Promise.all([
    apiFetch<Array<Item<BasemapData>>>('/api/items?type=basemap').catch(
      () => [] as Array<Item<BasemapData>>,
    ),
    editor.mapId
      ? apiFetch<Item<MapData>>(`/api/items/${editor.mapId}`).catch(
          () => null,
        )
      : Promise.resolve(null),
    Promise.all(
      uniqueDataLayerIds.map((id) =>
        apiFetch<Item<DataLayerData>>(`/api/items/${id}`).catch(() => null),
      ),
    ),
  ]);

  const basemaps: CustomBasemap[] = basemapItems
    .map(basemapItemToCustomBasemap)
    .filter((b): b is CustomBasemap => b !== null);

  // Index resolved data_layers by id so target metadata lookup is O(1).
  const dataLayerById = new Map<string, Item<DataLayerData>>();
  for (let i = 0; i < uniqueDataLayerIds.length; i += 1) {
    const item = targetItems[i];
    if (item) dataLayerById.set(uniqueDataLayerIds[i]!, item);
  }

  // Resolve each target to its (data_layer item, sublayer) pair.
  // Targets pointing at a deleted data_layer or a missing sublayer
  // get a null layer; the synthesis silently drops those, and the
  // config page warns the author with a banner.
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

  const canEdit = me.id === editorItem.ownerId || me.orgRole === 'admin';

  return (
    <EditorRuntime
      editorId={editorItem.id}
      editorTitle={editorItem.title}
      editor={editor}
      referencedMapTitle={referencedMap?.title ?? null}
      initialMapData={mapData}
      targetLayerIds={targetLayerIds}
      basemaps={basemaps}
      canEdit={canEdit}
    />
  );
}

// Suppress the items detail layout's max-w container so the
// runtime canvas can fill the full viewport.
export const dynamic = 'force-dynamic';
