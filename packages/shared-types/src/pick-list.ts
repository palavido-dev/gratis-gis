/**
 * Shared pick list: a named, authoritative list of coded values that
 * can be referenced from feature-service field domains, form choices,
 * dashboard filters, etc. Versioned on the data blob so future shape
 * changes can be detected without inspecting keys.
 *
 * Design notes:
 *  - `code` is the persisted value (what lands in a PostGIS column or
 *    form response). `label` is the human-facing display. `description`
 *    is optional flavour text surfaced in tooltips.
 *  - Codes are unique within a list. The UI and server both validate
 *    this at write time; do not rely on consumers to de-dupe.
 *  - `sort` is the stable display order. Adding a row appends to the
 *    end; drag-reorder rewrites the whole sequence. Reordering doesn't
 *    alter the list's identity: downstream references still resolve.
 *  - We intentionally skip hierarchy (parent/child cascading) for v1.
 *    It can slot in later as an optional `parentCode?: string` without
 *    breaking consumers, which was the design goal of pinning a
 *    version on the root.
 */
export type PickListDataVersion = 3;

export interface PickListEntry {
  /** Stable code written to databases / form responses. */
  code: string;
  /** Human-facing label shown to end users. */
  label: string;
  /** Optional long-form description (tooltip, help text). */
  description?: string;
}

export interface PickListData {
  version: PickListDataVersion;
  entries: PickListEntry[];
  /**
   * Optional note / source / maintainer reminder shown in the editor.
   * Not displayed to end users; authors only.
   */
  note?: string;
}

export const DEFAULT_PICK_LIST: PickListData = {
  version: 3,
  entries: [],
};

/**
 * Narrow unknown JSON to a PickListData if it looks right. Lenient on
 * optional fields and version bumps so older blobs still read: the
 * UI can then offer a migration on save.
 */
export function isPickListData(value: unknown): value is PickListData {
  if (!value || typeof value !== 'object') return false;
  const v = value as { version?: unknown; entries?: unknown };
  if (typeof v.version !== 'number') return false;
  if (!Array.isArray(v.entries)) return false;
  return v.entries.every(
    (e): e is PickListEntry =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as PickListEntry).code === 'string' &&
      typeof (e as PickListEntry).label === 'string',
  );
}
