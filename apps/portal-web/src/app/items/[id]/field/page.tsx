// SPDX-License-Identifier: AGPL-3.0-or-later
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
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
import { apiFetch, hasSession, publicApiFetch } from '@/lib/api';
import { FieldRuntime, type EditableLayer } from './field-runtime';

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Point this route at the FIELD manifest, not the portal's.
 *
 * This page is the installed app's actual home: the catalog at /field
 * is a list you pass through once. /app/field/layout.tsx cannot supply
 * the manifest here, because Next layouts follow the URL and this
 * route is a different branch of the tree, so without this the runtime
 * inherited the root manifest (start_url "/", scope "/") while the
 * installed app was launched from one with scope "/field/". An
 * installed PWA therefore treated every deployment as out of scope:
 * Android opens an out-of-scope navigation in a Custom Tab and iOS
 * drops standalone mode, so tapping a deployment ejected the collector
 * from the app they had just installed to do that one thing.
 */
export const metadata: Metadata = {
  manifest: '/field/manifest.webmanifest',
};

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
export default async function FieldRuntimePage(props: Props) {
  const params = await props.params;
  // Anonymous-public access mirrors viewer/run + custom/run +
  // responses: a public-shared data_collection renders for visitors
  // without a session, the runtime hides Add affordances (anonymous
  // can't author features), and a private data_collection 404s
  // server-side so the page falls back to "not found" rather than
  // a sign-in redirect we can't recover from in a PWA context.
  const isAnonymous = !(await hasSession());
  // Stale-cookie defense: when a viewer carries a NextAuth cookie
  // whose Keycloak accessToken has been invalidated (typical after
  // a Keycloak realm reset), hasSession() still returns true but
  // portal-api will 401 the request. Fall back to the public
  // surface in that case so a public-shared data_collection still
  // renders. A genuinely-private item 404s on the public route,
  // which the caller's existing 404 handling catches.
  const fetchItem = async <T,>(path: string): Promise<T> => {
    const publicPath = path.replace('/api/items/', '/api/public/items/');
    if (isAnonymous) return publicApiFetch<T>(publicPath);
    try {
      return await apiFetch<T>(path);
    } catch (err) {
      const status = (err as Error & { status?: number })?.status;
      if (status === 401) return publicApiFetch<T>(publicPath);
      throw err;
    }
  };
  const fetchItemList = async <T,>(path: string): Promise<T> => {
    const publicPath = path.replace('/api/items', '/api/public/items');
    if (isAnonymous) return publicApiFetch<T>(publicPath);
    try {
      return await apiFetch<T>(path);
    } catch (err) {
      const status = (err as Error & { status?: number })?.status;
      if (status === 401) return publicApiFetch<T>(publicPath);
      throw err;
    }
  };

  let dcItem: Item<DataCollectionData>;
  let me: { id: string; orgRole: string } = { id: '', orgRole: '' };
  try {
    dcItem = await fetchItem<Item<DataCollectionData>>(
      `/api/items/${params.id}`,
    );
    if (!isAnonymous) {
      // Only authenticated viewers have a /me; anonymous public
      // viewers carry an empty currentUserId, which the runtime
      // treats as "no Add affordance, read-only view of the map."
      // Stale-cookie defense: if the call 401s (the NextAuth
      // cookie is signed correctly but its Keycloak access token
      // has been invalidated, typical after a realm reset),
      // degrade to the anonymous path so the page still renders.
      try {
        me = await apiFetch<{ id: string; orgRole: string }>(
          '/api/users/me',
        );
      } catch (err) {
        const status = (err as Error & { status?: number })?.status;
        if (status !== 401) throw err;
      }
    }
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
    fetchItem<Item<MapData>>(`/api/items/${dc.mapId}`).catch(() => null),
    // full=1: the field runtime builds renderable basemaps from each
    // row's data payload, which the list now strips by default.
    fetchItemList<Array<Item<BasemapData>>>('/api/items?type=basemap&full=1').catch(
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
  type LayerRef = {
    dataLayerId: string;
    layerKey?: string;
    /**
     * Per-map-layer override of the data_layer's `editingEnabled`
     * flag. When the map's layer-settings panel marks a layer as
     * "not editable in field deployments", we skip it from the
     * Add picker even if the underlying data_layer would
     * otherwise permit edits. Lets the WV parcels map include
     * parcels for reference while only offering the building-
     * inventory sublayer as an Add target. Defaults to true
     * (editable) so existing maps keep their current behavior.
     */
    mapLayerEditable: boolean;
  };
  const dataLayerRefs: LayerRef[] = [];
  const seenRefKeys = new Set<string>();
  for (const ml of mapData.layers ?? []) {
    if (ml.source?.kind !== 'data-layer') continue;
    const ref: LayerRef = {
      dataLayerId: ml.source.itemId,
      mapLayerEditable: ml.interactions?.editingEnabled !== false,
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
      fetchItem<Item<DataLayerData>>(`/api/items/${id}`).catch(() => null),
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
  // the data_collection. Spatial sublayers come from the map's
  // layer refs (one entry per map layer); table sublayers reachable
  // as event-tracking related tables get added too so the field
  // runtime's "Add related" affordance can target them. Without the
  // table-sublayer entries, the related-records list shows them but
  // the Add button stays disabled.
  const editableLayers: EditableLayer[] = [];
  // Track (dataLayerId, layerKey) we've already pushed so the
  // table-sublayer pass below doesn't duplicate spatial entries.
  const seenLayerKey = new Set<string>();
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
    if (sublayer.geometryType === null) continue; // spatial-only at this pass
    // #271: skip layers the data_layer marks as not editable. A
    // read-only reference layer (e.g. Riverside County Parcels with
    // editingEnabled=false) is on the map for context, but the
    // field PWA's Add picker should not offer it as an Add target.
    // Without this gate, the picker shows every map data-layer
    // regardless of editability and the worker can attempt an Add
    // that the API would reject anyway.
    // Editability gate (data_layer + per-map). The layer always
    // makes it into editableLayers so the LayerVisibilityPanel can
    // look up its geometry type and surface a toggle row in the
    // layer list. The `addable` flag carries the gate forward to
    // the Add picker, which filters on it. Without this split, a
    // reference-only data-layer source (parcels included on a
    // building-inventory map) would vanish from the layer-toggle
    // list because the panel falls back to "isTable" when it
    // can't find a matching entry.
    const addable =
      sublayer.editingEnabled !== false && ref.mapLayerEditable !== false;
    const binding = dc.formBindings?.[sublayer.id];
    // Phase C: enumerate child layers within the same data_layer
    // item that reference this layer via parentFkColumn. Used by
    // FormModal's "Add related" affordance so a worker editing a
    // tree feature can drop an inspection under it in one tap.
    const childLayers = (data.layers ?? [])
      .filter(
        (l) =>
          typeof l.parentFkColumn === 'string' &&
          l.parentFkColumn.length > 0 &&
          // Convention: parentFkColumn is the FK back to THIS sublayer
          // when the column name encodes the parent's id (e.g., the
          // wizard's Add-event-tracking-related-layer flow names it
          // <parentLayerName>_id). Filter to only those.
          l.id !== sublayer.id,
      )
      .map((l) => ({
        layerKey: l.id,
        layerLabel: l.label ?? l.id,
        geometryType: l.geometryType,
        parentFkColumn: l.parentFkColumn as string,
      }));
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
      addable,
      ...(binding ? { boundFormItemId: binding.formItemId } : {}),
      ...(childLayers.length > 0 ? { childLayers } : {}),
    });
    seenLayerKey.add(`${dlItem.id}:${sublayer.id}`);
  }
  // Second pass: pull in table-typed child sublayers referenced from
  // any spatial parent we just registered. These don't show on the
  // map (no geometry) but the parent-feature edit drawer's "Add
  // related" button needs an EditableLayer entry to wire onto.
  // Without this pass the button stays disabled even when the
  // schema declares a child relationship.
  for (const parent of [...editableLayers]) {
    const dlItem = dataLayerById.get(parent.dataLayerId);
    if (!dlItem) continue;
    const data = dlItem.data as DataLayerData | undefined;
    if (!data || data.version !== 3) continue;
    for (const child of parent.childLayers ?? []) {
      if (child.geometryType !== null) continue; // spatial children already covered by their own map ref
      const key = `${parent.dataLayerId}:${child.layerKey}`;
      if (seenLayerKey.has(key)) continue;
      const sub = data.layers.find((l) => l.id === child.layerKey);
      if (!sub) continue;
      const binding = dc.formBindings?.[sub.id];
      editableLayers.push({
        dataLayerId: parent.dataLayerId,
        dataLayerTitle: parent.dataLayerTitle,
        layerKey: sub.id,
        layerLabel: sub.label ?? sub.id,
        geometryType: sub.geometryType,
        fields: sub.fields,
        editingPolicy: sub.editingPolicy ?? 'all-rows',
        ...(binding ? { boundFormItemId: binding.formItemId } : {}),
      });
      seenLayerKey.add(key);
    }
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
      fetchItem<Item<PickListData>>(`/api/items/${id}`).catch(() => null),
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
      fetchItem<Item<FormSchema>>(`/api/items/${id}`).catch(() => null),
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
      mapId={mapItem.id}
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
