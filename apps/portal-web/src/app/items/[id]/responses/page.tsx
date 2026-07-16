// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, AlertTriangle, FileText } from 'lucide-react';
import type {
  BasemapData,
  DataLayerData,
  DataLayerSublayer,
  EditorData,
  EditorTarget,
  Item,
  MapData,
  PickListData,
} from '@gratis-gis/shared-types';
import type { FormSchema } from '@gratis-gis/form-schema';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { apiFetch, hasSession, publicApiFetch } from '@/lib/api';
import {
  buildEditorMapData,
  editorTargetLayerId,
  type ResolvedTarget,
} from '../../[id]/editor/build-map-data';
import { EditorRuntime } from '../../[id]/editor/editor-runtime';

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Map a basemap item into the CustomBasemap shape MapCanvas
 * consumes. Same helper that survey/run/page.tsx and viewer/run/page.tsx
 * inline; extracting to a shared util when a fourth caller appears.
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
 * Loose shape we read off the form item. The form's `data` is a full
 * FormSchema (questions, title, schemaVersion, responseView) plus the
 * form-app specific fields (linkedLayerId, linkedLayerKey) layered on
 * top. Keep this shape narrow so a future schema bump doesn't crash
 * this page.
 */
interface FormShape {
  /** v3 paired data_layer materialized for this form (#283). */
  linkedLayerId?: string;
  /** When the paired layer has multiple sublayers, the specific
   *  layer this form maps onto. Single-layer pairs omit this. */
  linkedLayerKey?: string;
  /** Schema fields used by the FormView side panel (#320). */
  schemaVersion?: number;
  questions?: FormSchema['questions'];
  title?: string;
  /** #91: per-form Responses tab config. Replaces the legacy Survey
   *  web_app template. Authors edit this from the Form designer's
   *  Responses tab. Absent values fall through to defaults below. */
  responseView?: FormSchema['responseView'];
}

/**
 * Per-form Response Viewer (#321 / #320 / #91).
 *
 * Every Form item gets a built-in Response Viewer at
 * `/items/<formId>/responses`. The form item's data has everything
 * we need: a paired data_layer (#283), a FormSchema for the side
 * panel (#320), the linkedLayerKey when the pair is multi-layer,
 * and an optional responseView config block (#91) where the author
 * picks a reference map, the toolbar tools to expose, and other
 * read-side knobs.
 *
 * The runtime mounts EditorRuntime with the FormView side panel
 * open by default (so the user lands on a recognizable response
 * renderer rather than a bare map). Authors who want to tweak the
 * viewer (different basemap, narrower toolbar, "last 30 days"
 * default filter) edit the responseView block on the form -- no
 * separate Survey item to create.
 *
 * Auth: ItemsService.get() on the API enforces visibility. Anonymous
 * public-share visitors land here too -- branch the fetch path the
 * same way Viewer does. Submissions are read-only by design, so
 * canEdit is forced false regardless of the caller's permissions
 * on the form.
 */
export default async function FormResponsesPage(props: Props) {
  const params = await props.params;
  const isAnonymous = !(await hasSession());
  const fetchItem = <T,>(path: string): Promise<T> =>
    isAnonymous
      ? publicApiFetch<T>(path.replace('/api/items/', '/api/public/items/'))
      : apiFetch<T>(path);
  const fetchItemList = <T,>(path: string): Promise<T> =>
    isAnonymous
      ? publicApiFetch<T>(path.replace('/api/items', '/api/public/items'))
      : apiFetch<T>(path);

  let formItem: Item<FormShape>;
  try {
    formItem = await fetchItem<Item<FormShape>>(`/api/items/${params.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }
  if (formItem.type !== 'form') notFound();

  const formData = (formItem.data ?? {}) as FormShape;

  // #91: per-form responses config. Author sets these knobs on the
  // form designer's Responses tab; absent values fall through to
  // safe defaults below. The legacy Survey app type's three runtime-
  // affecting knobs (mapId, tools, printEnabled) live here now; the
  // other two (defaultLookbackDays, hideSubmitter) are persisted on
  // the schema but await runtime filtering UX in a follow-up slice.
  const responseView = formData.responseView ?? {};
  const configuredMapId =
    typeof responseView.mapId === 'string' && responseView.mapId.length > 0
      ? responseView.mapId
      : null;
  // Default toolbar mirrors the previous implicit viewer plus the
  // common read-side complements (legend / attribute-table) so an
  // unconfigured Responses tab still feels useful. Authors can
  // narrow the set via the Responses tab.
  const configuredTools: ReadonlyArray<
    'select' | 'query' | 'measure' | 'attribute-table' | 'legend' | 'print'
  > = Array.isArray(responseView.tools)
    ? responseView.tools
    : ['select', 'measure', 'attribute-table', 'legend'];

  // ---- Empty states ------------------------------------------------
  if (!formData.linkedLayerId) {
    return (
      <UnboundShell
        item={formItem}
        message="no paired data layer yet (this should auto-materialize on form save)"
      />
    );
  }

  // Resolve the paired data_layer + (if needed) pick the right
  // sublayer key. A multi-layer pair stores `linkedLayerKey`; a
  // single-layer pair omits it and we default to the first layer.
  let dataLayerItem: Item<DataLayerData> | null;
  try {
    dataLayerItem = await fetchItem<Item<DataLayerData>>(
      `/api/items/${formData.linkedLayerId}`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) {
      return (
        <UnboundShell
          item={formItem}
          message="paired data layer is missing or unreadable"
        />
      );
    }
    throw err;
  }
  const dlData = dataLayerItem.data as DataLayerData | undefined;
  let layerKey: string | null = null;
  if (dlData && dlData.version === 3) {
    if (formData.linkedLayerKey) {
      layerKey =
        dlData.layers.find((l) => l.id === formData.linkedLayerKey)?.id ??
        null;
    }
    if (!layerKey && dlData.layers.length > 0) {
      layerKey = dlData.layers[0]!.id;
    }
  }
  if (!layerKey) {
    return (
      <UnboundShell
        item={formItem}
        message="paired data layer has no readable sublayer"
      />
    );
  }

  // Forms without a geo question pair to a non-spatial table
  // (geometryType=null). Until the table-only mode lands (slice 2 of
  // docs/survey-runtime.md), route to an unbound shell so the user
  // gets a clear message instead of a broken map. The form-view
  // side panel still works in that mode; the table layout is what's
  // missing.
  const matchedSublayer =
    dlData && dlData.version === 3
      ? dlData.layers.find((l) => l.id === layerKey) ?? null
      : null;
  if (matchedSublayer && !matchedSublayer.geometryType) {
    return (
      <UnboundShell
        item={formItem}
        message="this form has no map question, so submissions can't be plotted (table-only response viewer is on the way)"
      />
    );
  }

  // Synthesize a read-only EditorData with one target = paired layer.
  const target: EditorTarget = {
    dataLayerId: dataLayerItem.id,
    layerKey,
    canCreate: false,
    canEditGeometry: false,
    canEditAttributes: false,
    canDelete: false,
    editableFields: [],
    rowScope: 'all',
    templates: [],
  };
  // EditorData.tools is a subset of the read-side affordances the
  // canvas understands; map the author-chosen responseView.tools
  // onto that subset the same way the legacy Survey runtime did.
  // Print is a separate prop on EditorRuntime so it's hoisted out
  // here.
  const passthrough: Array<'select' | 'measure'> = [];
  if (configuredTools.includes('select')) passthrough.push('select');
  if (configuredTools.includes('measure')) passthrough.push('measure');
  const editor: EditorData = {
    version: 1,
    targets: [target],
    tools: passthrough,
    snapping: { enabled: false, selfSnap: false, tolerancePx: 10 },
  };
  if (configuredMapId) editor.mapId = configuredMapId;

  const [basemapItems, referencedMap] = await Promise.all([
    fetchItemList<Array<Item<BasemapData>>>('/api/items?type=basemap').catch(
      () => [] as Array<Item<BasemapData>>,
    ),
    // #91: when the author picked a reference map in the Responses
    // tab, fetch it so its basemap + viewport flow into the runtime.
    // Absent means "build the map from just the paired layer", same
    // as the pre-#91 implicit viewer behavior.
    configuredMapId
      ? fetchItem<Item<MapData>>(`/api/items/${configuredMapId}`).catch(
          () => null,
        )
      : Promise.resolve(null as Item<MapData> | null),
  ]);

  const basemaps: CustomBasemap[] = basemapItems
    .map(basemapItemToCustomBasemap)
    .filter((b): b is CustomBasemap => b !== null);

  const layer: DataLayerSublayer | null =
    dlData && dlData.version === 3
      ? dlData.layers.find((l) => l.id === layerKey) ?? null
      : null;
  const resolvedTargets: ResolvedTarget[] = [
    {
      dataLayerId: dataLayerItem.id,
      layerKey,
      layer,
      dataLayerTitle: dataLayerItem.title,
    },
  ];

  const { mapData: builtMapData, targetLayerIds } = buildEditorMapData({
    editor,
    referencedMap,
    resolvedTargets,
  });

  // #354: frame the map to the extent of all submissions on first
  // open. Two ways to find the bbox:
  //   1. The sublayer's stored bbox, populated by the periodic
  //      Recompute extents pass (#93). Cheap when present.
  //   2. Live compute from the geojson endpoint when (1) is empty
  //      -- the Recompute pass might not have fired yet for a
  //      brand-new form's paired layer, and forcing the user to
  //      pan-find their submissions on first load is bad UX.
  // Fall back to buildEditorMapData center/zoom only when both
  // paths come up empty (truly no features yet).
  const submissionsBbox: [number, number, number, number] | null =
    (() => {
      const sub = layer;
      const subBbox = sub?.bbox;
      if (
        Array.isArray(subBbox) &&
        subBbox.length === 4 &&
        subBbox.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) {
        const [minX, minY, maxX, maxY] = subBbox as [
          number,
          number,
          number,
          number,
        ];
        if (minX <= maxX && minY <= maxY) return [minX, minY, maxX, maxY];
      }
      return null;
    })();
  const liveBbox: [number, number, number, number] | null =
    submissionsBbox === null
      ? await computeFeatureBboxFromGeojson(
          fetchItem,
          dataLayerItem.id,
          layerKey,
        )
      : null;
  const finalBbox = submissionsBbox ?? liveBbox;
  const mapData: MapData = finalBbox
    ? viewportFromBbox(builtMapData, finalBbox)
    : builtMapData;

  // Pick lists referenced by the paired layer's columns; same as
  // survey/run -- the form mirror writes coded VALUES, so the side
  // panel resolves them back to labels here.
  const pickListItemIds = new Set<string>();
  if (layer) {
    for (const f of layer.fields) {
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

  // The form item's data IS a FormSchema (the designer writes the
  // entire schema there). Pass it through to the FormView side panel
  // so each selected feature renders as a proper form readout.
  const formViewSchema: FormSchema | null =
    formData && formData.questions
      ? (formItem.data as unknown as FormSchema)
      : null;
  const surveyTargetLayerId = editorTargetLayerId(dataLayerItem.id, layerKey);

  return (
    <EditorRuntime
      editorId={formItem.id}
      editorTitle={formItem.title}
      editor={editor}
      resolvedTargets={resolvedTargets}
      pickLists={pickLists}
      referencedMapTitle={referencedMap?.title ?? null}
      initialMapData={mapData}
      targetLayerIds={targetLayerIds}
      basemaps={basemaps}
      canEdit={false}
      printEnabled={configuredTools.includes('print')}
      formViewSchema={formViewSchema}
      surveyTargetLayerId={surveyTargetLayerId}
      surveyAttachmentsLayerItemId={dataLayerItem.id}
      surveyAttachmentsLayerKey={layerKey}
      tableOpenDefault
    />
  );
}

/**
 * Empty-state shell used when the form is not fully configured.
 * Centralized so the "no paired layer / no sublayer / non-spatial"
 * branches all render identically and link back to the form's
 * detail page so the author can finish setup.
 */
function UnboundShell({
  item,
  message,
}: {
  item: { id: string; title: string };
  message: string;
}) {
  return (
    <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col bg-surface-0">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface-1 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/items"
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to items
          </Link>
          <span className="text-muted">/</span>
          <span className="inline-flex items-center gap-1.5 text-base font-semibold text-ink-0">
            <FileText className="h-4 w-4 text-orange-500" />
            {item.title}
          </span>
        </div>
        <Link
          href={`/items/${item.id}`}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2"
        >
          Open form
        </Link>
      </header>
      <div className="flex flex-1 items-center justify-center p-10">
        <div className="max-w-md rounded-lg border border-dashed border-border bg-surface-1 p-8 text-center shadow-card">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-warn/10">
            <AlertTriangle className="h-5 w-5 text-warn" />
          </span>
          <h2 className="mt-3 text-base font-semibold text-ink-0">
            Responses not ready to render
          </h2>
          <p className="mt-2 text-sm text-muted">
            This form has {message}. Open{' '}
            <Link
              href={`/items/${item.id}`}
              className="text-accent hover:underline"
            >
              the form's page
            </Link>{' '}
            to finish setup or collect a first submission.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Compute a bbox from the live geojson endpoint when the sublayer
 * doesn't have one stored yet (#354 followup). The Recompute Extents
 * pass (#93) populates layer bboxes periodically, but for a brand-
 * new form's paired layer the user might Open Responses before that
 * pass has fired and the auto-frame would silently no-op.
 *
 * This is a one-shot server-side fetch on page render: cheap for the
 * usual form-paired layer (handful to a few hundred features). If
 * the layer eventually grows to the point where this is wasteful,
 * the periodic pass will be populating the stored bbox by then and
 * this branch never runs.
 */
async function computeFeatureBboxFromGeojson(
  fetchItem: <T>(path: string) => Promise<T>,
  itemId: string,
  layerKey: string,
): Promise<[number, number, number, number] | null> {
  let fc: GeoJSON.FeatureCollection;
  try {
    fc = await fetchItem<GeoJSON.FeatureCollection>(
      `/api/items/${itemId}/layers/${layerKey}/geojson`,
    );
  } catch {
    return null;
  }
  if (!fc || !Array.isArray(fc.features) || fc.features.length === 0) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  function walkCoords(coords: unknown): void {
    if (!Array.isArray(coords)) return;
    if (
      coords.length >= 2 &&
      typeof coords[0] === 'number' &&
      typeof coords[1] === 'number'
    ) {
      const [x, y] = coords as [number, number];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }
    for (const c of coords) walkCoords(c);
  }
  for (const f of fc.features) {
    if (!f || !f.geometry) continue;
    const g = f.geometry as { coordinates?: unknown };
    if (g.coordinates) walkCoords(g.coordinates);
  }
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Apply a bbox-derived center + zoom to a base MapData (#354).
 * Heuristic zoom: log2(360 / span) - 0.5 gives some headroom around
 * features so they aren't pinned to the viewport edges; clamped to
 * [1, 18] so a single-point bbox doesn't try to zoom past street
 * level.
 */
function viewportFromBbox(
  base: MapData,
  bbox: [number, number, number, number],
): MapData {
  const [minX, minY, maxX, maxY] = bbox;
  const center: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];
  const lngSpan = Math.max(maxX - minX, 0.0001);
  const latSpan = Math.max(maxY - minY, 0.0001);
  const span = Math.max(lngSpan, latSpan);
  const zoom = Math.max(1, Math.min(18, Math.log2(360 / span) - 0.5));
  return { ...base, center, zoom };
}

export const dynamic = 'force-dynamic';
