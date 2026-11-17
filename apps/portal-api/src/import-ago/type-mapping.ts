// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * AGO item-type -> GratisGIS item-type mapping table for the
 * AGO migration importer.
 *
 * AGO's type vocabulary is large (50+ values across "ArcGIS
 * type categories"). We don't need to support all of them on
 * day one; the mapping below covers everything that makes
 * sense to mirror into a GratisGIS portal and explicitly
 * classifies the rest as "skip with reason" so the import
 * report can tell the operator what got left behind.
 *
 * Per-type information the importer needs:
 *
 *   - ``targetType``: the GratisGIS item type the row will
 *     create. Set to ``null`` for types we don't import.
 *
 *   - ``needsDataFetch``: whether the importer should call
 *     ``/sharing/rest/content/items/<id>/data`` to pull the
 *     type-specific payload. Web Maps need it; services don't
 *     (the listing has enough metadata).
 *
 *   - ``needsServiceProbe``: whether the importer should probe
 *     the service URL post-create to populate the layer list.
 *     Saves a manual "fix this up in portal admin" step for
 *     the common hosted-service case.
 *
 *   - ``protocol`` (services only): which ``protocol`` field
 *     to seed on the new ``service`` item's data envelope
 *     (arcgis_map / arcgis_features / arcgis_vector_tiles).
 *
 *   - ``notes``: human-readable description shown in the
 *     dry-run preview + post-import report.
 *
 * Why this is its own file, not buried in a switch: a single
 * source of truth + a test asserting every key category is
 * covered is much harder to drift than a switch scattered
 * across the importer. The classifier function below is the
 * only consumer; it returns a strongly-typed mapping struct.
 */

/** GratisGIS item types we import AGO content into. Subset of
 *  the full ITEM_TYPES list in shared-types -- only the ones
 *  the AGO importer can produce. */
export type GratisGisImportType =
  | 'map'
  | 'service'
  | 'tile_layer'
  | 'form'
  | 'web_app'
  | 'dashboard'
  | 'file'
  | 'data_layer';

/** Hint to the importer about which service protocol to seed
 *  on the new ``service`` item's data envelope. Matches the
 *  values the existing portal service items carry. */
export type ServiceProtocol =
  | 'arcgis_map'
  | 'arcgis_features'
  | 'arcgis_vector_tiles'
  | 'arcgis_image';

/** One row of the mapping table. */
export interface AgoTypeMapping {
  /** AGO type string, e.g. "Web Map", "Feature Service". */
  agoType: string;
  /** Resulting portal item type. ``null`` if this type is
   *  classified but not yet supported by the importer. */
  targetType: GratisGisImportType | null;
  /** Pull /data envelope on import. */
  needsDataFetch: boolean;
  /** Probe the service URL after item create. */
  needsServiceProbe: boolean;
  /** Service protocol seed (only set when targetType==='service'). */
  protocol?: ServiceProtocol;
  /** Whether this item is "supported" in the v1 importer. False
   *  rows are surfaced in dry-run as "will skip" with the
   *  reason in ``notes``. */
  supported: boolean;
  /** Human-readable explanation, surfaced in dry-run and the
   *  post-import report. */
  notes: string;
  /**
   * For Feature Services specifically. Hosted services (AGO owns
   * the data) are promoted to `data_layer` and their features are
   * copied (see classifyAgoType), so this is always false on those.
   * Referenced services stay connected `service` items.
   */
  hostedDataCopyPending?: boolean;
}

/**
 * The mapping table. Keys are AGO's documented type strings;
 * adding a row here is the only step required to teach the
 * importer about a new type.
 */
const MAPPING: Record<string, AgoTypeMapping> = Object.fromEntries(
  (
    [
      // ---- Hosted / referenced services ----
      {
        agoType: 'Feature Service',
        targetType: 'service',
        needsDataFetch: false,
        needsServiceProbe: true,
        protocol: 'arcgis_features',
        supported: true,
        notes:
          'ArcGIS Feature Service -> portal `service` item. Service URL captured; layers probed post-create.',
      },
      {
        agoType: 'Map Service',
        targetType: 'service',
        needsDataFetch: false,
        needsServiceProbe: true,
        protocol: 'arcgis_map',
        supported: true,
        notes:
          'ArcGIS Map Service -> portal `service` item. Renders as a tiled raster on the GratisGIS map page.',
      },
      {
        agoType: 'Image Service',
        targetType: 'service',
        needsDataFetch: false,
        needsServiceProbe: true,
        protocol: 'arcgis_image',
        supported: true,
        notes:
          'ArcGIS Image Service -> portal `service` item. Imagery analytics not yet supported; visualisation only.',
      },
      {
        agoType: 'Vector Tile Service',
        targetType: 'service',
        needsDataFetch: false,
        needsServiceProbe: false,
        protocol: 'arcgis_vector_tiles',
        supported: true,
        notes:
          'ArcGIS Vector Tile Service -> portal `service` item. Tiles served by AGO; the GratisGIS map proxies them through.',
      },
      // ---- Maps + apps ----
      {
        agoType: 'Web Map',
        targetType: 'map',
        needsDataFetch: true,
        needsServiceProbe: false,
        supported: true,
        notes:
          'AGO WebMap JSON -> portal `map` item via the existing WebMap import service.',
      },
      {
        agoType: 'Web Mapping Application',
        targetType: null,
        needsDataFetch: false,
        needsServiceProbe: false,
        supported: false,
        notes:
          'AGO Web Mapping Applications use Esri-proprietary templates that do not translate cleanly. v1 importer skips; rebuild through the portal app templates after the underlying maps + services are imported.',
      },
      {
        agoType: 'Dashboard',
        targetType: null,
        needsDataFetch: false,
        needsServiceProbe: false,
        supported: false,
        notes:
          'AGO Dashboard widget catalog differs significantly from the portal dashboard runtime. v1 importer skips; rebuild through the portal dashboard editor after the underlying maps + layers are imported.',
      },
      {
        agoType: 'StoryMap',
        targetType: 'web_app',
        needsDataFetch: true,
        needsServiceProbe: false,
        supported: false,
        notes:
          'StoryMap not yet supported. The native StoryMap runtime is template-heavy; planned for a later phase.',
      },
      {
        agoType: 'Experience Builder',
        targetType: 'web_app',
        needsDataFetch: true,
        needsServiceProbe: false,
        supported: false,
        notes:
          'Experience Builder app not yet supported. The runtime is Esri-proprietary; importing the configuration is on the roadmap.',
      },
      // ---- Forms / surveys ----
      {
        agoType: 'Form',
        targetType: null,
        needsDataFetch: false,
        needsServiceProbe: false,
        supported: false,
        notes:
          'AGO Forms / Survey123 use XLSForm payloads that have not been round-tripped through the portal form designer yet. v1 importer skips; recreate forms in the portal once the underlying submission layers exist.',
      },
      {
        agoType: 'Survey',
        targetType: null,
        needsDataFetch: false,
        needsServiceProbe: false,
        supported: false,
        notes:
          'Survey123 surveys not supported on v1 import; see the Form row note. The companion Feature Service that backs the survey is imported normally.',
      },
      // ---- Files / docs ----
      {
        agoType: 'Image',
        targetType: 'file',
        needsDataFetch: false,
        needsServiceProbe: false,
        supported: true,
        notes: 'AGO Image -> portal `file` item.',
      },
      {
        agoType: 'PDF',
        targetType: 'file',
        needsDataFetch: false,
        needsServiceProbe: false,
        supported: true,
        notes: 'AGO PDF -> portal `file` item.',
      },
      {
        agoType: 'CSV',
        targetType: 'file',
        needsDataFetch: false,
        needsServiceProbe: false,
        supported: true,
        notes:
          'AGO CSV -> portal `file` item. To use the CSV as a layer, publish it through the portal vector-publish flow after import.',
      },
      {
        agoType: 'Microsoft Word',
        targetType: 'file',
        needsDataFetch: false,
        needsServiceProbe: false,
        supported: true,
        notes: 'AGO Word document -> portal `file` item.',
      },
      {
        agoType: 'Microsoft Excel',
        targetType: 'file',
        needsDataFetch: false,
        needsServiceProbe: false,
        supported: true,
        notes: 'AGO Excel workbook -> portal `file` item.',
      },
      {
        agoType: 'Document Link',
        targetType: 'file',
        needsDataFetch: false,
        needsServiceProbe: false,
        // The importer has no bytes to re-host for a link and skips
        // it, so the preview must not promise an import.
        supported: false,
        notes:
          'AGO Document Link: an external URL with no file to copy. Recreate it as a portal link by hand if you need it.',
      },
      {
        agoType: 'Shapefile',
        targetType: 'file',
        needsDataFetch: false,
        needsServiceProbe: false,
        supported: true,
        notes:
          'AGO Shapefile attachment -> portal `file` item. To use as a layer, publish it through the portal vector-publish flow after import.',
      },
      // ---- Skipped (classified but not imported on v1) ----
      {
        agoType: 'Code Attachment',
        targetType: null,
        needsDataFetch: false,
        needsServiceProbe: false,
        supported: false,
        notes:
          'AGO Code Attachment is a sibling artefact of a Web Mapping Application; imported via the parent app, not standalone.',
      },
      {
        agoType: 'Service Definition',
        targetType: null,
        needsDataFetch: false,
        needsServiceProbe: false,
        supported: false,
        notes:
          'Service Definition (raw service publishing package) not imported. Republish via the portal data_layer flow instead.',
      },
      {
        agoType: 'Layer Package',
        targetType: null,
        needsDataFetch: false,
        needsServiceProbe: false,
        supported: false,
        notes:
          'ArcGIS Pro Layer Package (.lpk/.lpkx) not imported. Publish source data through GratisGIS instead.',
      },
      {
        agoType: 'Notebook',
        targetType: null,
        needsDataFetch: false,
        needsServiceProbe: false,
        supported: false,
        notes:
          'AGO Notebook items are Python notebooks scoped to the AGO compute runtime. Not portable.',
      },
    ] as AgoTypeMapping[]
  ).map((row) => [row.agoType, row]),
);

/**
 * Classify an AGO item by its type string. Returns either the
 * mapped row (with ``supported`` + ``targetType`` set) or a
 * synthetic "unknown" row for AGO types we don't have a mapping
 * for. The importer treats unknown rows as "skip with reason"
 * so the dry-run can tell the operator what's missing without
 * crashing.
 */
export function classifyAgoType(
  agoType: string,
  typeKeywords?: ReadonlyArray<string>,
): AgoTypeMapping {
  const row = MAPPING[agoType];
  if (row) {
    // Promotion for Feature Services: AGO marks hosted services
    // (data lives in AGO's database, not pointing at an external
    // ArcGIS Server) with the `Hosted Service` typeKeyword. These
    // are the ones we can actually migrate -- query their features
    // via REST + insert into a new data_layer. External / referenced
    // feature services stay as `service` items because we don't own
    // their data.
    if (
      row.agoType === 'Feature Service' &&
      Array.isArray(typeKeywords) &&
      typeKeywords.includes('Hosted Service')
    ) {
      return {
        ...row,
        targetType: 'data_layer',
        // Importer no longer needs to probe via the existing
        // service-probe path for these; the hosted-FS importer
        // does its own per-layer schema fetch.
        needsServiceProbe: false,
        hostedDataCopyPending: false,
        notes:
          'AGO hosted Feature Service -> portal `data_layer` item. The service\'s sublayers + their features are copied into PostGIS; the new data_layer is portal-owned and no longer depends on AGO.',
      };
    }
    return row;
  }
  return {
    agoType,
    targetType: null,
    needsDataFetch: false,
    needsServiceProbe: false,
    supported: false,
    notes: `AGO type "${agoType}" has no mapping; nothing will be created for items of this type.`,
  };
}

/**
 * Bulk-classify a list of AGO items (e.g. the entire user
 * content listing). Returns a per-item classification keyed by
 * AGO item id so the dry-run can render counts + skip reasons
 * in the report.
 */
export function classifyAgoItems(
  items: ReadonlyArray<{ id: string; type: string }>,
): Map<string, AgoTypeMapping> {
  const out = new Map<string, AgoTypeMapping>();
  for (const it of items) {
    out.set(it.id, classifyAgoType(it.type));
  }
  return out;
}

/**
 * The full mapping table as an array, for tests + the dry-run
 * preview UI that lists "the importer knows about these AGO
 * types".
 */
export function allAgoTypeMappings(): AgoTypeMapping[] {
  return Object.values(MAPPING);
}

/**
 * Item dependency order. When two items in the same import
 * batch reference each other (Web Map references its service
 * layers; Web Mapping Application references its Web Map),
 * the dependent item must be created AFTER the thing it
 * references so its source-itemId backref can resolve.
 *
 * Returns the items in dependency order: services first, then
 * maps, then apps + dashboards, then forms + files. Items of
 * the same type stay in their input order so the import is
 * predictable.
 */
export function sortByImportOrder<T extends { type: string }>(
  items: ReadonlyArray<T>,
): T[] {
  const order: Record<GratisGisImportType, number> = {
    service: 10,
    tile_layer: 15,
    data_layer: 20,
    map: 30,
    web_app: 40,
    dashboard: 40,
    form: 50,
    file: 60,
  };
  return items
    .map((it, idx) => ({ it, idx, key: classifyAgoType(it.type).targetType }))
    .sort((a, b) => {
      const ao = a.key !== null ? order[a.key] ?? 99 : 99;
      const bo = b.key !== null ? order[b.key] ?? 99 : 99;
      if (ao !== bo) return ao - bo;
      return a.idx - b.idx;
    })
    .map((row) => row.it);
}
