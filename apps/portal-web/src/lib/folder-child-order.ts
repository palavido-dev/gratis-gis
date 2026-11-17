// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How a folder page orders its rows.
 *
 * 'az': subfolders first, then everything else, each by title.
 * 'custom': the folder's saved order (childItemIds), which drag and
 * drop writes. Drag used to be offered while the list always sorted
 * A to Z, so a drop saved a new order the page never showed.
 */
export type FolderSort = 'az' | 'custom';

export function orderFolderChildren<T extends { id: string; type: string; title: string }>(
  children: readonly T[],
  sort: FolderSort,
  orderedIds: readonly string[],
): T[] {
  const copy = [...children];
  if (sort === 'custom') {
    const at = new Map(orderedIds.map((id, i) => [id, i] as const));
    // A child missing from the saved order (it should not happen) goes
    // last rather than jumping to the top.
    const pos = (c: T) => at.get(c.id) ?? Number.MAX_SAFE_INTEGER;
    copy.sort((a, b) => pos(a) - pos(b));
    return copy;
  }
  copy.sort((a, b) => {
    const af = a.type === 'folder' ? 0 : 1;
    const bf = b.type === 'folder' ? 0 : 1;
    if (af !== bf) return af - bf;
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });
  return copy;
}

const STORAGE_KEY = 'gratisgis.folderSort';

/** The viewer's last choice on this device; A to Z when none. */
export function readFolderSort(): FolderSort {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === 'custom' ? 'custom' : 'az';
  } catch {
    return 'az';
  }
}

export function writeFolderSort(sort: FolderSort): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, sort);
  } catch {
    // Storage blocked: the choice just is not remembered.
  }
}
