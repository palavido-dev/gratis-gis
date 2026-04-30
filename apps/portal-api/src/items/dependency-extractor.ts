import type { ItemType } from '@prisma/client';

/**
 * Walks an item's data payload and returns the references it holds to
 * other items. Two kinds of reference exist:
 *
 *   - `itemIds`: direct UUID references (feature-service layers).
 *   - `urls`:    URL references the caller can match against other
 *                items with structured URL data (today: arcgis_service
 *                items whose `data.url` matches).
 *
 * Keeping these separate lets the service build two reverse indexes
 * and match each kind of reference without a schema-wide JSON scan.
 *
 * Today's coverage for map layers (shared-types MapLayerSource):
 *   - source.kind === 'data-layer'  -> itemIds += source.itemId
 *   - source.kind === 'arcgis-rest'      -> urls    += source.url
 *   - source.kind === 'geojson-url'      -> (not tracked; external URL)
 *   - source.kind === 'geojson-inline'   -> (not tracked; inline data)
 *
 * Plus the map's own basemap reference:
 *   - data.basemap (UUID string)         -> itemIds += data.basemap
 *
 * Future candidates as those item types ship:
 *   - dashboard.data.panels[].itemId
 *   - form.data.targetItemId
 *   - report_template.data.sources[].itemId
 *   - web_app.data.mapItemId
 */
export interface Dependencies {
  itemIds: string[];
  urls: string[];
}

export function extractDependencies(
  item: { type: ItemType; data: unknown },
): Dependencies {
  const data = item.data as Record<string, unknown> | null;
  const itemIds = new Set<string>();
  const urls = new Set<string>();
  if (!data) return { itemIds: [], urls: [] };

  if (item.type === 'map') {
    // The map's basemap is a basemap item (since #21 / Phase 1c, the
    // built-ins also live as items), referenced by UUID through
    // `data.basemap`. Record it so the basemap shows up in the map's
    // "Depends on" panel and the map shows up in the basemap's "Used
    // by" panel. The empty-string sentinel from DEFAULT_MAP is
    // intentionally skipped.
    const basemapRef = (data as { basemap?: unknown }).basemap;
    if (typeof basemapRef === 'string' && basemapRef.length > 0) {
      itemIds.add(basemapRef);
    }

    const layers = Array.isArray((data as { layers?: unknown }).layers)
      ? ((data as { layers: unknown[] }).layers as Array<Record<string, unknown>>)
      : [];
    for (const l of layers) {
      const source = l?.source as Record<string, unknown> | undefined;
      if (!source || typeof source !== 'object') continue;
      const kind = source.kind;
      if (kind === 'data-layer') {
        const id = source.itemId;
        if (typeof id === 'string' && id.length > 0) itemIds.add(id);
      } else if (kind === 'arcgis-rest') {
        // Prefer the direct back-reference when the layer was added
        // from a portal item; URL matching is brittle (trailing
        // slashes, alternate hostnames, query strings). Fall back to
        // URL matching for layers added by raw-URL paste.
        const direct = source.sourceItemId;
        if (typeof direct === 'string' && direct.length > 0) {
          itemIds.add(direct);
        }
        const raw = source.url;
        if (typeof raw === 'string' && raw.length > 0) {
          urls.add(normalizeArcgisUrl(raw));
        }
      }
    }
  }

  if (item.type === 'folder') {
    // A folder claims a list of item UUIDs (childItemIds). Each one
    // is a hard dependency: the folder "depends on" the items it
    // contains so that purging an item can cascade-splice the now-
    // gone UUID out of every folder that referenced it. The reverse
    // edge ("Used by: this folder") shows up on each child's detail
    // page so authors can see what folders an item lives in.
    // See docs/folders.md.
    const children = (data as { childItemIds?: unknown }).childItemIds;
    if (Array.isArray(children)) {
      for (const c of children) {
        if (typeof c === 'string' && c.length > 0) itemIds.add(c);
      }
    }
  }

  if (item.type === 'editor') {
    // An Editor item references:
    //   - data.mapId         -> the map providing basemap + reference
    //                            layers in the runtime
    //   - data.targets[].dataLayerId
    //                        -> each target data_layer the editor
    //                            exposes for write
    // Tracking these lets the dependency panel show "this editor
    // depends on X map and Y data_layers", and the reverse edge
    // ("Used by: this editor") shows up on the map / data_layer
    // detail pages so authors can see which editors expose them
    // before purging or restructuring. See docs/editing-and-collection.md.
    const mapRef = (data as { mapId?: unknown }).mapId;
    if (typeof mapRef === 'string' && mapRef.length > 0) {
      itemIds.add(mapRef);
    }
    const targets = (data as { targets?: unknown }).targets;
    if (Array.isArray(targets)) {
      for (const t of targets as Array<Record<string, unknown>>) {
        const dl = t?.dataLayerId;
        if (typeof dl === 'string' && dl.length > 0) itemIds.add(dl);
      }
    }
  }

  if (item.type === 'form') {
    // A form item references:
    //   - data.linkedLayerId            -> the data_layer the form is
    //                                       bound to (where submissions
    //                                       land for the Field-mode
    //                                       runtime).
    //   - question.bindTo.layerItemId   -> a separate data_layer item
    //                                       targeted by a repeating
    //                                       group (cross-item related
    //                                       table). bindTo.layerKey is
    //                                       a sublayer KEY inside the
    //                                       form's already-linked
    //                                       layer item, so it doesn't
    //                                       contribute a new ref.
    //   - question.pickListId           -> a pick_list item whose
    //                                       entries populate the
    //                                       choices. Same field exists
    //                                       on individual choices via
    //                                       choice.pickListId; keep
    //                                       both paths.
    // Tracking these surfaces the bound layer in the form's "Depends
    // on" panel and the form in each layer's / pick list's "Used by".
    const linked = (data as { linkedLayerId?: unknown }).linkedLayerId;
    if (typeof linked === 'string' && linked.length > 0) itemIds.add(linked);

    const questions = Array.isArray(
      (data as { questions?: unknown }).questions,
    )
      ? ((data as { questions: unknown[] }).questions as Array<
          Record<string, unknown>
        >)
      : [];
    walkQuestionRefs(questions, itemIds);
  }

  if (item.type === 'data_layer') {
    // v3 multi-layer: walk each layer's fields and collect pick-list
    // refs (domain type === 'coded-value-ref'). v1/v2 items store
    // `fields` at the top level; handle both shapes.
    const topLevelFields = Array.isArray((data as { fields?: unknown }).fields)
      ? ((data as { fields: unknown[] }).fields as Array<Record<string, unknown>>)
      : [];
    const nestedLayers = Array.isArray((data as { layers?: unknown }).layers)
      ? ((data as { layers: unknown[] }).layers as Array<Record<string, unknown>>)
      : [];
    const fieldSets: Array<Array<Record<string, unknown>>> = [topLevelFields];
    for (const layer of nestedLayers) {
      if (Array.isArray(layer?.fields)) {
        fieldSets.push(
          layer.fields as Array<Record<string, unknown>>,
        );
      }
    }
    for (const fields of fieldSets) {
      for (const f of fields) {
        const domain = f?.domain as Record<string, unknown> | undefined;
        if (!domain) continue;
        if (domain.type === 'coded-value-ref') {
          const pid = domain.pickListItemId;
          if (typeof pid === 'string' && pid.length > 0) itemIds.add(pid);
        }
      }
    }
  }

  if (item.type === 'derived_layer') {
    // A derived layer always references its source data_layer through
    // `data.source.itemId`. Each step in `data.pipeline` may also
    // reference items (a future intersect tool's second-input layer,
    // a pickList referenced in a where clause). v1 buffer holds none.
    // When a tool with item-typed params is added, give it a `case`
    // branch here AND a matching `extractDependencies` on its
    // generator (the latter for callers that want a single-tool view).
    const sourceRef = (data as { source?: { itemId?: unknown } }).source;
    const sourceId = sourceRef?.itemId;
    if (typeof sourceId === 'string' && sourceId.length > 0) {
      itemIds.add(sourceId);
    }
  }

  if (item.type === 'data_collection') {
    // A data_collection references:
    //   - data.mapId: the map item the deployment wraps. Every
    //     data_collection has exactly one (structural).
    //   - data.formBindings[layerKey].formItemId: optional explicit
    //     form bound to a specific editable layer. Multiple bindings
    //     each contribute one ref. Layers without a binding fall
    //     through to schema-derived forms at runtime; nothing to
    //     track for those.
    // Tracking these surfaces the map and any custom forms in the
    // data_collection's "Depends on" panel, and the deployment in
    // each map's / form's "Used by" panel so authors can see what
    // depends on a map before they restructure or trash it.
    const mapRef = (data as { mapId?: unknown }).mapId;
    if (typeof mapRef === 'string' && mapRef.length > 0) {
      itemIds.add(mapRef);
    }
    const bindings = (data as { formBindings?: unknown }).formBindings;
    if (bindings && typeof bindings === 'object' && !Array.isArray(bindings)) {
      for (const b of Object.values(
        bindings as Record<string, unknown>,
      )) {
        if (b && typeof b === 'object') {
          const fid = (b as { formItemId?: unknown }).formItemId;
          if (typeof fid === 'string' && fid.length > 0) itemIds.add(fid);
        }
      }
    }
  }

  // Hook points for other types: extend as those item types come online.

  return { itemIds: Array.from(itemIds), urls: Array.from(urls) };
}

/**
 * Tolerant URL key for matching arcgis-rest layer URLs against
 * arcgis_service item URLs. Strips: surrounding whitespace, query
 * string, fragment, trailing slashes, any trailing `/<digits>` layer
 * index after MapServer/FeatureServer, then lowercases. http/https
 * are collapsed to a schemeless form so a layer URL saved as http and
 * an item URL saved as https still match.
 */
export function normalizeArcgisUrl(u: string): string {
  let s = u.trim();
  // Strip query + fragment: these are presentation artifacts, not
  // part of the service identity.
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#');
  if (h >= 0) s = s.slice(0, h);
  // Collapse scheme so http/https variants match.
  s = s.replace(/^https?:\/\//i, '');
  // Strip trailing slashes (handles both `/` and `///`).
  s = s.replace(/\/+$/, '');
  // Strip a trailing /<layerId> so a layer URL (.../MapServer/2)
  // matches the service root (.../MapServer) the arcgis_service item
  // persists.
  s = s.replace(/\/(MapServer|FeatureServer)\/\d+$/i, '/$1');
  return s.toLowerCase();
}

/**
 * Recursively walk a form's question tree, collecting referenced
 * item ids. Pulls bindTo.layerItemId (cross-item related-table
 * targets) and pickListId (both per-question and per-choice). The
 * form's top-level linkedLayerId is added by the caller; this
 * helper handles only what's nested in the questions.
 *
 * The form schema lives in @gratis-gis/form-schema but the API can't
 * cleanly import it (the package builds for the browser). We treat
 * the tree as untyped JSON and access fields defensively, which
 * matches the rest of this file.
 */
function walkQuestionRefs(
  questions: Array<Record<string, unknown>>,
  out: Set<string>,
): void {
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue;
    const bindTo = q.bindTo as Record<string, unknown> | undefined;
    if (bindTo) {
      const layerItemId = bindTo.layerItemId;
      if (typeof layerItemId === 'string' && layerItemId.length > 0) {
        out.add(layerItemId);
      }
    }
    const pickListId = q.pickListId;
    if (typeof pickListId === 'string' && pickListId.length > 0) {
      out.add(pickListId);
    }
    const choices = q.choices as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(choices)) {
      for (const c of choices) {
        const cpid = c?.pickListId;
        if (typeof cpid === 'string' && cpid.length > 0) out.add(cpid);
      }
    }
    // matrix-dropdown carries per-column choices
    const columns = q.columns as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(columns)) {
      for (const col of columns) {
        const colChoices = col?.choices as
          | Array<Record<string, unknown>>
          | undefined;
        if (Array.isArray(colChoices)) {
          for (const c of colChoices) {
            const cpid = c?.pickListId;
            if (typeof cpid === 'string' && cpid.length > 0) out.add(cpid);
          }
        }
      }
    }
    // Recurse into group children.
    const children = q.children as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(children)) walkQuestionRefs(children, out);
  }
}

/** Item types that can reference other items. The service uses this
 *  list to drive reverse-index scans -- e.g. when computing a
 *  data_layer's "Used by" panel, only items of these types are
 *  searched for forward refs. If we expand this, update the
 *  service's dependents scan to include the new types. */
export const REFERENCER_TYPES: ItemType[] = [
  'map',
  'data_layer',
  'derived_layer',
  'folder',
  'editor',
  'form',
  'data_collection',
];
