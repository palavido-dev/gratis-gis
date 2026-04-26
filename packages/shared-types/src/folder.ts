/**
 * Folder = view, not gate. A folder item exists to group other items
 * under a curated label. Sharing a folder shares the arrangement
 * (the list of UUIDs); per-item authz still decides what each viewer
 * actually sees inside. An item can sit in zero or many folders;
 * removing it from a folder never affects the item itself.
 *
 * A subfolder is just a folder whose UUID appears in another folder's
 * `childItemIds`. There is no separate "subfolder" type, no parent FK
 * column, no nested data. Multi-parent (DAG) is allowed; cycle
 * detection runs at save time.
 *
 * See docs/folders.md for the full design rationale.
 */
export type FolderDataVersion = 1;

/**
 * Smart-folder query (#38). When set on a folder, the folder's
 * contents are computed at view time by running this query against
 * the items list endpoint instead of reading from `childItemIds`.
 * A folder is EITHER static (childItemIds drives membership) OR
 * smart (smartQuery drives membership), not both at once -- the
 * resolver picks smart when the field is present and non-null.
 *
 * Field semantics mirror the controller's @Get('/api/items') query
 * params so smart-folder resolution can reuse the same authz path.
 * All fields optional; an empty smartQuery resolves to "every item
 * the caller can see," which is occasionally useful (e.g., "all
 * items, newest first" as a smart top-level folder).
 *
 * Trash items are always excluded by the resolver regardless of
 * what the query says. Per-share access still applies; smart
 * folders can never widen a caller's visible set.
 */
/** Which fields the smart folder's search-text query targets.
 *  Default (when absent) is all three -- matches the all-items
 *  list behaviour. Subset lets the author scope a search to,
 *  say, just tags ("everything tagged with 'parcels'"). */
export type FolderSmartSearchField = 'title' | 'description' | 'tags';

export interface FolderSmartQuery {
  /** Comma-tolerant: a single ItemType or several (matches the
   *  controller's multi-type filter shape). */
  type?: string | string[];
  /** Free-text search. Targets the fields listed in
   *  `searchFields`; defaults to all three when omitted. */
  q?: string;
  /** Restrict the `q` search to a subset of fields. Each entry
   *  contributes one OR-clause in the SQL; an empty / missing
   *  list is interpreted as "all three" so an existing static
   *  smart folder picks up the same behaviour it had before. */
  searchFields?: FolderSmartSearchField[];
  /** Restrict to items owned by this user UUID. */
  ownerId?: string;
  /** Spatial filter: [west, south, east, north] in EPSG:4326. */
  bbox?: [number, number, number, number];
  /** Buffer (km) widening the bbox before the intersect check. */
  bufferKm?: number;
  /** Cap the resolved item count so a "everything" smart folder
   *  doesn't accidentally render 10,000 cards. Server clamps. */
  limit?: number;
}

export interface FolderData {
  version: FolderDataVersion;
  /**
   * Ordered list of item UUIDs claimed by this folder. The order is
   * authoritative for rendering; UI drag-drop writes a new order
   * back. Stale UUIDs (items the caller cannot see, items in trash,
   * items that have been purged but not yet cleaned up) are dropped
   * by the API resolution layer at view time.
   *
   * Ignored when `smartQuery` is set; smart folders compute their
   * contents from the query and don't curate a fixed list.
   */
  childItemIds: string[];
  /**
   * Whether this folder inherits shares from its parent folder
   * (#44 phase 1c, slice 3). When true (default), every share on
   * any folder ancestor that has inheritsParentShares=true grants
   * access to this folder's contents. When false, the inheritance
   * chain breaks here -- only the folder's own direct shares apply
   * downward.
   *
   * Resolution semantics: walking from a folder up to the root, we
   * collect shares from every folder where inheritsParentShares is
   * true. The first folder with inheritsParentShares=false stops
   * the walk; its own shares still count, but no further ancestors
   * contribute. Owner / admin / public-org bypass survive (the
   * safety-valve invariant). See docs/folders.md.
   *
   * Optional with `true` semantics when absent so existing folders
   * keep working unchanged after this field lands.
   */
  inheritsParentShares?: boolean;
  /**
   * Smart-folder query (#38). When present, the folder is "smart":
   * its contents are computed by running the query through the
   * standard items.list path at view time. childItemIds is ignored
   * for membership but kept around so toggling back to a static
   * folder restores any prior curation.
   *
   * Owner / admin / public / org bypass paths in items.list still
   * apply, so a smart folder author seeing 200 items as the owner
   * may legitimately differ from a viewer who only sees 5; this is
   * the same authz boundary every other items query honors.
   */
  smartQuery?: FolderSmartQuery;
}

export const DEFAULT_FOLDER: FolderData = {
  version: 1,
  childItemIds: [],
  inheritsParentShares: true,
};

export function isFolderData(value: unknown): value is FolderData {
  if (!value || typeof value !== 'object') return false;
  const v = value as { version?: unknown; childItemIds?: unknown };
  if (v.version !== 1) return false;
  if (!Array.isArray(v.childItemIds)) return false;
  return v.childItemIds.every((id) => typeof id === 'string');
}

/** True when this folder resolves its contents from a saved query
 *  rather than a curated childItemIds list (#38). */
export function isSmartFolder(data: FolderData | null | undefined): boolean {
  return !!data && !!data.smartQuery;
}