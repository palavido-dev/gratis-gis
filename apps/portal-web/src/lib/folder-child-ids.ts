// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The id list a folder edit writes back.
 *
 * `/folder-contents` returns only what the caller can see and leaves
 * out trashed items, and for a smart folder it returns the query
 * results instead of the saved list. The server stores
 * `childItemIds` exactly as sent, so writing back what the page
 * displayed removed hidden and trashed items from the folder for
 * everyone, and turned a smart folder's saved manual list into its
 * query results. The stored list stays the base; a static folder
 * only gains ids the server shows that the page did not know yet.
 */
export function mergeFolderChildIds(
  stored: readonly string[],
  shown: readonly string[],
  isSmart: boolean,
): string[] {
  const out = [...stored];
  // Smart results are not members; never fold them into the list.
  if (isSmart) return out;
  const have = new Set(out);
  for (const id of shown) {
    if (!have.has(id)) {
      out.push(id);
      have.add(id);
    }
  }
  return out;
}
