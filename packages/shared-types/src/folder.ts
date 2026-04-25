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

export interface FolderData {
  version: FolderDataVersion;
  /**
   * Ordered list of item UUIDs claimed by this folder. The order is
   * authoritative for rendering; UI drag-drop writes a new order
   * back. Stale UUIDs (items the caller cannot see, items in trash,
   * items that have been purged but not yet cleaned up) are dropped
   * by the API resolution layer at view time.
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