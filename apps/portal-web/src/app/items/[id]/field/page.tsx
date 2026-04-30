import { notFound } from 'next/navigation';
import type {
  BasemapData,
  DataCollectionData,
  DataLayerData,
  Item,
  MapData,
  PickListData,
} from '@gratis-gis/shared-types';
import type { FormSchema } from '@gratis-gis/form-schema';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { apiFetch } from '@/lib/api';
import { FieldRuntime, type EditableLayer } from './field-runtime';

interface Props {
  params: { id: string };
}

/**
 * Map a basemap item into the CustomBasemap shape MapCanvas
 * consumes. Same helper as the editor /run page; lifting to a shared
 * util once a third caller appears (current callers: standard item
 * detail, editor runtime, this field runtime).
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
 * Field-mode runtime page (Field Maps Slice 2, #193).
 *
 * The collector-facing surface for a `data_collection` item: opens
 * the bound map full-screen, lets a user tap features to edit them
 * or tap empty space to add new ones using forms drawn from each
 * editable layer's schema. Equivalent to Esri Field Maps' deployed
 * map view, minus the offline machinery (Slice 4+, #194+).
 *
 * Server-side: fetch the data_collection, the bound map, every
 * data_layer the map references via a `data-layer` source kind, and
 * any pick_list items those layers' fields reference. Hand the
 * whole bundle to <FieldRuntime> so the client lands ready to render
 * with no follow-up I/O. Authorization: ItemsService.get() on the
 * API gates visibility (404 on not-found-or-forbidden).
 *
 * Form resolution at runtime (Field Maps default, see Slice 1):
 * editable layers without an entry in
 * `data_collection.data.formBindings` get a form auto-generated
 * from their FeatureField schema via generateFormFromLayer. Layers
 * with an explicit binding fetch the bound form item lazily on
 * first tap so we don't pay the cost for unused bindings.
 */
export default async function FieldRuntimePage({ params }: Props) {
  let dcItem: Item<DataCollectionData>;
  let me: { id: string; orgRole: string };
  try {
    [dcItem, me] = await Promise.all([
      apiFetch<Item<DataCollectionData>>(`/api/items/${params.id}`),
      apiFetch<{ id: string; orgRole: string }>('/api/users/me'),
    ]);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }
  if (dcItem.type !== 'data_collection') notFound();

  const dc = (dcItem.data ?? { version: 1, mapId: '' }) as DataCollectionData;
  if (!dc.mapId) {
    // A data_collection without a mapId is a wizard-skipped state we
    // shouldn't reach; if we do, fall back to 404 rather than render a
    // broken canvas.
    notFound();
  }

  // Pull the map and the basemap library in parallel. Map missing /
  // soft-deleted = 404 (a deployment without a map has nothing for
  // collectors to do).
  const [mapItem, basemapItems] = await Promise.all([
    apiFetch<Item<MapData>>(`/api/items/${dc.mapId}`).catch(() => null),
    apiFetch<Array<Item<BasemapData>>>('/api/items?type=basemap').catch(
      () => [] as Array<Item<BasemapData>>,
    ),
  ]);
  if (!mapItem) notFound();

  const mapData = (mapItem.data ?? null) as MapData | null;
  if (!mapData) notFound();

  // Walk the map's layers and collect every unique data_layer id that
  // backs a `data-layer` source. v1/v2 single-table layers have
  // source.itemId only; v3 layers carry an extra layerKey identifying
  // a sublayer within the data_layer item.
  type LayerRef = { dataLayerId: string; layerKey?: string };
  const dataLayerRefs: LayerRef[] = [];
  const seenRefKeys = new Set<string>();
  for (const ml of mapData.layers ?? []) {
    if (ml.source?.kind !== 'data-layer') continue;
    const ref: LayerRef = {
      dataLayerId: ml.source.itemId,
    };
    if (ml.source.layerKey) ref.layerKey = ml.source.layerKey;
    const key = `${ref.dataLayerId}:${ref.layerKey ?? ''}`;
    if (seenRefKeys.has(key)) continue;
    seenRefKeys.add(key);
    dataLayerRefs.push(ref);
  }

  const uniqueDataLayerIds = Array.from(
    new Set(dataLayerRefs.map((r) => r.dataLayerId)),
  );

  // Fetch each unique data_layer in parallel. Some may fail (deleted /
  // not visible to caller); we drop those silently and let the runtime
  // surface a "couldn't load this layer" hint per missing entry.
  const dataLayerItems = await Promise.all(
    uniqueDataLayerIds.map((id) =>
      apiFetch<Item<DataLayerData>>(`/api/items/${id}`).catch(() => null),
    ),
  );
  const dataLayerById = new Map<string, Item<DataLayerData>>();
  for (let i = 0; i < uniqueDataLayerIds.length; i += 1) {
    const item = dataLayerItems[i];
    if (item) dataLayerById.set(uniqueDataLayerIds[i]!, item);
  }

  // Build the per-layer "editable target" descriptors the runtime
  // consumes. Each entry pairs a v3 sublayer with its parent
  // data_layer id and (when present) the explicit form binding from
  // the data_collection. Spatial-only for Slice 2: table sublayers
  // (geometryType=null) are excluded because there's no point of
  // entry on the map for them yet -- they're event-tracking related
  // tables, surfaced via parent-feature popups in a later slice.
  const editableLayers: EditableLayer[] = [];
  for (const ref of dataLayerRefs) {
    const dlItem = dataLayerById.get(ref.dataLayerId);
    if (!dlItem) continue;
    const data = dlItem.data as DataLayerData | undefined;
    if (!data || data.version !== 3) continue;
    // Pick the sublayer matching the map layer's layerKey when present;
    // if absent, fall through to the first spatial layer (matches the
    // v1/v2 single-table convention).
    const sublayer = ref.layerKey
      ? data.layers.find((l) => l.id === ref.layerKey)
      : data.layers.find((l) => l.geometryType !== null);
    if (!sublayer) continue;
    if (sublayer.geometryType === null) continue; // tables: out-of-scope for Slice 2
    const binding = dc.formBindings?.[sublayer.id];
    editableLayers.push({
      dataLayerId: dlItem.id,
      dataLayerTitle: dlItem.title,
      layerKey: sublayer.id,
      layerLabel: sublayer.label ?? sublayer.id,
      geometryType: sublayer.geometryType,
      fields: sublayer.fields,
      // Mirror the layer's editing policy so the runtime can hide
      // policy='none' layers from the Add picker. When unset we
      // assume 'all-rows' which permits edits subject to the user's
      // share grant.
      editingPolicy: sublayer.editingPolicy ?? 'all-rows',
      ...(binding ? { boundFormItemId: binding.formItemId } : {}),
    });
  }

  // Resolve any pick_list items referenced by an editable layer's
  // fields up front so the auto-form path can render real <select>
  // elements without a per-keystroke fetch. Bound forms (the explicit
  // formItemId path) carry their own pick lists in the form schema's
  // questions and don't need this index, but we resolve them all in
  // one pass since the lookup table is cheap to maintain.
  const pickListIds = new Set<string>();
  for (const e of editableLayers) {
    for (const f of e.fields) {
      if (f.domain && f.domain.type === 'coded-value-ref') {
        pickListIds.add(f.domain.pickListItemId);
      }
    }
  }
  const pickListItems = await Promise.all(
    Array.from(pickListIds).map((id) =>
      apiFetch<Item<PickListData>>(`/api/items/${id}`).catch(() => null),
    ),
  );
  const pickLists: Record<string, PickListData> = {};
  for (const it of pickListItems) {
    if (it && it.data) pickLists[it.id] = it.data as PickListData;
  }

  // Bound forms: fetch every uniquely-referenced form item up front.
  // The runtime keys into `boundForms[formItemId]` when an editable
  // layer carries a binding; layers without a binding fall back to
  // schema-derived auto-forms.
  const boundFormIds = Array.from(
    new Set(
      editableLayers
        .map((e) => e.boundFormItemId)
        .filter((s): s is string => typeof s === 'string'),
    ),
  );
  const boundFormItems = await Promise.all(
    boundFormIds.map((id) =>
      apiFetch<Item<FormSchema>>(`/api/items/${id}`).catch(() => null),
    ),
  );
  const boundForms: Record<string, FormSchema> = {};
  for (const it of boundFormItems) {
    if (it && it.data) boundForms[it.id] = it.data as FormSchema;
  }

  const basemaps: CustomBasemap[] = basemapItems
    .map(basemapItemToCustomBasemap)
    .filter((b): b is CustomBasemap => b !== null);

  return (
    <FieldRuntime
      dataCollectionId={dcItem.id}
      title={dcItem.title}
      mapData={mapData}
      mapTitle={mapItem.title}
      basemaps={basemaps}
      editableLayers={editableLayers}
      pickLists={pickLists}
      boundForms={boundForms}
      currentUserId={me.id}
    />
  );
}

// Force the field runtime to fill the viewport (no items-detail
// max-w wrapper) and revalidate per request -- collectors are
// always working against fresh data.
export const dynamic = 'force-dynamic';
