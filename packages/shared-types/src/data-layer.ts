/**
 * Canonical shape stored in an Item's dataJson when `type = 'data_layer'`.
 *
 * Two storage strategies exist:
 *
 * **v1**: inline GeoJSON in `item.data.data`. Works for demos and small
 * datasets; hard cap around 25 MB upload / a few MB parsed JSON.
 *
 * **v2**: PostGIS table per item. `item.data` holds only metadata
 * (field schema, feature count, bbox, updatedAt). The actual geometry
 * and properties live in a table named `fs_<uuid_no_dashes>` in the
 * database. `GET /api/items/:id/geojson` streams from PostGIS with
 * optional `?bbox` and `?at` query parameters. Individual feature
 * CRUD (append, update, delete, history) lives at
 * `GET|POST|PATCH|DELETE /api/items/:id/features[/:fid]`.
 */

import type { ISODateString } from './ids';

/** Authoritative column types. Keep synced with the form-schema package. */
export type FeatureFieldType = 'string' | 'number' | 'boolean' | 'date';

/**
 * Optional value-constraint on a field, modelled after Esri's "domain":
 *
 * - `coded-value` restricts inputs to a small, authoritative list of
 *   allowed code/label pairs. The CODE is persisted, the LABEL is what
 *   the UI shows. Codes must match the field's type (strings for a
 *   string field, numbers for a number field).
 * - `coded-value-ref` references a shared pick_list item. The referenced
 *   item's entries are resolved at read time, so a single authoritative
 *   list can back many fields across many feature services. Renaming or
 *   extending the shared list propagates without touching each field.
 * - `range` restricts a numeric field to a min/max inclusive range.
 *   Not yet rendered in the builder UI; the shape is pinned here so the
 *   data model doesn't change when range support ships.
 */
export type FieldDomain =
  | {
      type: 'coded-value';
      values: Array<{ code: string | number; label: string }>;
    }
  | {
      type: 'coded-value-ref';
      /** UUID of a `pick_list` item in the same org. */
      pickListItemId: string;
    }
  | {
      type: 'range';
      min: number;
      max: number;
    };

/**
 * Optional storage hints attached to a field. None of these are
 * required: PostgreSQL's TEXT and NUMERIC are loose enough to carry
 * anything: but they let authors capture Esri-style declarations
 * (field widths, integer vs decimal) that come in handy when exporting
 * to shapefile / File GDB or doing client-side validation. The
 * backend applies them when provisioning the PostGIS table:
 *
 *   - `maxLength` on a string field â†’ `VARCHAR(maxLength)` instead of `TEXT`.
 *   - `numberKind: 'integer'`        â†’ `INTEGER` instead of `NUMERIC`.
 *   - `numberKind: 'decimal'` + both precision/scale set
 *                                    â†’ `NUMERIC(precision, scale)`.
 */
export interface FeatureFieldStorage {
  /** Cap on string length in characters. Leave unset for unlimited. */
  maxLength?: number;
  /** Number storage class. Default: 'decimal'. */
  numberKind?: 'integer' | 'decimal';
  /** Total digits (NUMERIC precision). */
  precision?: number;
  /** Digits after the decimal point (NUMERIC scale). */
  scale?: number;
}

export interface FeatureField {
  name: string;
  type: FeatureFieldType;
  /** UI-facing display name; falls back to `name` if blank. */
  label: string;
  nullable: boolean;
  /** Optional pick list or numeric range constraint. */
  domain?: FieldDomain;
  /** Optional storage hints (length, number kind, precision). */
  storage?: FeatureFieldStorage;
  /**
   * When true, the portal ensures a btree index on the underlying
   * PostGIS column when the layer is provisioned (#23 explicit
   * half). Picks up filter and equality queries the most common
   * UI surfaces fire (attribute table search, popup-driven feature
   * lookup, the items-list `q` text filter when it grows
   * cross-feature). Defaults to false; the layer author opts in.
   */
  searchable?: boolean;
}

/**
 * Provenance of the data currently on a feature-service item. Stamped
 * when features are uploaded or bulk-replaced so authors can see at a
 * glance what the dataset was built from. Absent on items whose data
 * was inlined by hand or created before the field was added: the UI
 * renders "Source not recorded" in that case rather than fabricating
 * a value.
 */
export interface DataLayerSource {
  /** Original filename uploaded by the user, if any. */
  fileName?: string;
  /** Canonical source format. 'manual' covers paste-GeoJSON + builder
   *  seeded schemas; 'api' covers non-UI replace calls. */
  format:
    | 'geojson'
    | 'kml'
    | 'kmz'
    | 'shapefile'
    | 'gdb'
    | 'xlsx'
    | 'csv'
    | 'manual'
    | 'api';
  /** Size of the original upload in bytes; optional for non-file sources. */
  sizeBytes?: number;
  /** When the current data landed on the item. */
  importedAt: ISODateString;
  /** UserId who ran the import. */
  importedBy: string;
  /** Per-format note (e.g. 'first sheet', 'driver: ESRI File Geodatabase'). */
  note?: string;
  /**
   * The spatial reference of the source file BEFORE we reprojected
   * to EPSG:4326 on ingest. Format: "authName:authCode" (e.g.
   * "EPSG:26911"). Null means the source had no declared SRS so
   * we assumed it was already 4326. Storage is always 4326 in the
   * portal regardless of what the source was.
   */
  sourceSrs?: string | null;
}

/** v1: inline GeoJSON storage. */
export interface DataLayerDataV1 {
  version: 1;
  storageType?: never;
  fields: FeatureField[];
  data: {
    type: 'FeatureCollection';
    features: Array<{
      type: 'Feature';
      geometry: unknown;
      properties: Record<string, unknown>;
    }>;
  };
  updatedAt?: ISODateString;
  source?: DataLayerSource;
}

/** v2: PostGIS-backed storage. `data.data` is absent; features live in the DB. */
export interface DataLayerDataV2 {
  version: 2;
  storageType: 'postgis';
  fields: FeatureField[];
  featureCount: number;
  /** [minX, minY, maxX, maxY] in EPSG:4326. Null when the table is empty. */
  bbox: [number, number, number, number] | null;
  updatedAt?: ISODateString;
  source?: DataLayerSource;
}

/**
 * v3: multi-layer feature service (like an ArcGIS DataLayer).
 *
 * One item contains an ordered list of "layers". A layer with a
 * geometry type is a spatial layer and gets a PostGIS table; a layer
 * with `geometryType: null` is an attribute-only "table" (think
 * related inspection records, comments, etc.).
 *
 * Each layer has its own schema, editing toggle, attachments toggle,
 * and may participate in zero or more parent/child relationships with
 * other layers in the same item.
 *
 * Persistence (Phase C: not yet wired):
 * - Each layer maps to a PostGIS table `fs_<itemIdNoDashes>_<layerId>`.
 * - Per-layer feature CRUD lives at `/items/:id/layers/:layerId/features`.
 * - Relationships are enforced by a FK column on the child layer's
 *   table pointing at the parent layer's global_id UUID.
 */
export type LayerGeometryType = 'point' | 'line' | 'polygon' | null;

export interface DataLayerSublayer {
  /** Stable within the item. Used in table name + API paths. */
  id: string;
  /** Display name: what appears in the legend and layer list. */
  label: string;
  /** Machine-friendly slug; defaults to a sanitized `label`. */
  name: string;
  /** null = attribute-only "related table". */
  geometryType: LayerGeometryType;
  fields: FeatureField[];
  /** Does the viewer allow in-place feature edits? */
  editingEnabled: boolean;
  /**
   * Layer-level row-access baseline (#41). 'all-rows' (default,
   * legacy behaviour) lets every editor see / edit every row in the
   * layer. 'own-rows-only' makes every share behave as if its
   * rowScope were 'own'; per-share rowScope='own' can tighten
   * further but never loosen. Owner / admin / item-public callers
   * always see everything regardless. Useful for inspection layers
   * where every editor (no matter how shared) should only touch
   * their own rows. Optional with 'all-rows' semantics when absent
   * so existing layers keep working unchanged.
   */
  editingPolicy?: 'all-rows' | 'own-rows-only';
  /** Should features in this layer carry attachments (photos, docs)?
   *  Backend support is Phase E; the flag is stored today so Phase B
   *  UIs can read/write it without a second migration. */
  attachmentsEnabled: boolean;
  /** Optional: which layers in THIS item reference this layer as a parent. */
  childLayerIds?: string[];
  /** Optional: if this layer is a child of another in-item layer. */
  parentLayerId?: string;
  /** Column on this layer's table holding the parent's global_id. */
  parentFkColumn?: string;
  /** Per-layer feature counts / bbox, populated after ingest. */
  featureCount?: number;
  bbox?: [number, number, number, number] | null;
  updatedAt?: ISODateString;
  /** Provenance of the most recent ingest into this layer. Per-layer
   *  because different layers in one v3 item might be sourced from
   *  different files. */
  source?: DataLayerSource;
}

export interface DataLayerDataV3 {
  version: 3;
  storageType: 'postgis';
  layers: DataLayerSublayer[];
  /** Item-level updatedAt. Layer-level updatedAt lives on each layer. */
  updatedAt?: ISODateString;
}

export type DataLayerData =
  | DataLayerDataV1
  | DataLayerDataV2
  | DataLayerDataV3;

export const DEFAULT_DATA_LAYER: DataLayerDataV1 = {
  version: 1,
  fields: [],
  data: { type: 'FeatureCollection', features: [] },
};

/**
 * Default v3 shape used when the create wizard's builder is the starting
 * point. Ships with no layers; the builder adds them. When the user
 * hasn't added any layers we still want `version: 3` so the backend
 * knows to treat this item as multi-layer from birth.
 */
export const DEFAULT_DATA_LAYER_V3: DataLayerDataV3 = {
  version: 3,
  storageType: 'postgis',
  layers: [],
};

// ---------------------------------------------------------------------------
// Feature API types (used by portal-web and field-app)
// ---------------------------------------------------------------------------

/** A single GeoJSON feature returned by the features REST API. */
export interface FeatureRecord {
  type: 'Feature';
  /** Stable UUID across all versions of this feature. */
  id: string;
  geometry: unknown;
  properties: Record<string, unknown>;
  _meta?: {
    gid: number;
    validFrom: ISODateString;
    /** null means the feature is current. */
    validTo?: ISODateString;
    createdBy: string;
    createdAt: ISODateString;
    editedBy: string;
    editedAt: ISODateString;
  };
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: FeatureRecord[];
}

/** Body for POST /items/:id/features (append one or more features). */
export interface AppendFeaturesInput {
  features: Array<{
    /** Client-generated UUID: provide for offline-created features so
     *  parent/child GUIDs established offline survive the sync. */
    globalId?: string;
    geometry?: unknown;
    properties?: Record<string, unknown>;
  }>;
}

/** Body for PATCH /items/:id/features/:fid (partial update). */
export interface UpdateFeatureInput {
  geometry?: unknown;
  properties?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Related tables
// ---------------------------------------------------------------------------

/**
 * Registered relationship between two feature-service items.
 * Stored in the parent item's data.relationships array.
 *
 * Example: nest points (parent) â†’ annual_inspections (child).
 * The child table has a `parent_global_id` UUID column (indexed) that
 * references the parent feature's global_id.
 */
export interface FeatureRelationship {
  /** Stable UUID for this relationship: used in API paths. */
  id: string;
  /** Display name shown in map popups and forms. */
  label: string;
  /** Item ID of the child feature service. */
  relatedItemId: string;
  /** Column name on the child table holding the parent's global_id. */
  fkColumn: string;
  /** Cardinality from the parent's perspective (almost always many). */
  cardinality: 'one-to-many' | 'one-to-one';
}

/**
 * Back-reference stored in the child item's data.parentRelationship.
 * Lets the API quickly find which column is the FK without scanning
 * the parent's relationship list.
 */
export interface ChildRelationshipRef {
  /** Item ID of the parent feature service. */
  parentItemId: string;
  /** Column on this table that holds the parent's global_id. */
  fkColumn: string;
  /** Relationship ID on the parent (for cross-referencing). */
  relationshipId: string;
}

/** Body for POST /items/:id/relationships: register a new relationship. */
export interface CreateRelationshipInput {
  label: string;
  /** Item ID of the child feature service. */
  relatedItemId: string;
  /** Column name to add/use on the child table. Defaults to "parent_global_id". */
  fkColumn?: string;
  cardinality?: 'one-to-many' | 'one-to-one';
}
