// SPDX-License-Identifier: AGPL-3.0-or-later
import { computeFolderCascade } from './items.service.js';

/**
 * Cascade-walk regression suite (#156). The DB-touching wrapper
 * (previewFolderDeleteCascade on ItemsService) only loads folders
 * and maps them into the shape this helper consumes; every
 * branching decision -- "which subfolders survive", "which kids are
 * non-folder unlinks", "how does multi-parent interact with the
 * cascade" -- lives in computeFolderCascade. Testing the helper
 * directly keeps the assertions readable and avoids a Prisma mock.
 */
describe('computeFolderCascade', () => {
  // Helper to keep the fixtures legible.
  function folder(
    id: string,
    title: string,
    childItemIds: string[],
  ): { id: string; title: string; childItemIds: string[] } {
    return { id, title, childItemIds };
  }

  it('returns an empty cascade for a folder with no children', () => {
    const result = computeFolderCascade('a', [folder('a', 'A', [])]);
    expect(result).toEqual({ folders: [], unlinkedItemCount: 0 });
  });

  it('lists every subfolder when the tree is single-parent (the common case)', () => {
    // A
    // +- B
    //    +- C
    // +- D
    const folders = [
      folder('a', 'A', ['b', 'd']),
      folder('b', 'B', ['c']),
      folder('c', 'C', []),
      folder('d', 'D', []),
    ];
    const result = computeFolderCascade('a', folders);
    // BFS order: A's direct children first (B, D), then C from
    // the B branch.
    expect(result.folders.map((f) => f.id)).toEqual(['b', 'd', 'c']);
    expect(result.unlinkedItemCount).toBe(0);
  });

  it('counts non-folder children as unlinks rather than cascade deletes', () => {
    // A
    // +- B (folder)
    // +- x1 (data_layer; not in folder list)
    // +- x2 (file; not in folder list)
    const folders = [folder('a', 'A', ['b', 'x1', 'x2']), folder('b', 'B', [])];
    const result = computeFolderCascade('a', folders);
    expect(result.folders.map((f) => f.id)).toEqual(['b']);
    expect(result.unlinkedItemCount).toBe(2);
  });

  it('preserves a subfolder whose other parent is outside the cascade', () => {
    // A      G (outside cascade, still alive)
    // +- B   +- B   <-- B is filed under both A and G
    //    +- C
    // Deleting A should NOT cascade to B because G still claims it.
    // C is reached via B's surviving branch (from G), so the
    // cascade preview should also leave C alone.
    const folders = [
      folder('a', 'A', ['b']),
      folder('g', 'G', ['b']),
      folder('b', 'B', ['c']),
      folder('c', 'C', []),
    ];
    const result = computeFolderCascade('a', folders);
    expect(result.folders).toEqual([]);
    expect(result.unlinkedItemCount).toBe(0);
  });

  it('cascades a multi-parent subfolder when every parent is in the cascade set', () => {
    // A
    // +- B
    // +- C
    //    +- B   <-- B is also filed under C
    // Deleting A starts the cascade; both B and C are descendants
    // of A. The only parents of B are A and C, both in the cascade,
    // so B should cascade too.
    const folders = [
      folder('a', 'A', ['b', 'c']),
      folder('c', 'C', ['b']),
      folder('b', 'B', []),
    ];
    const result = computeFolderCascade('a', folders);
    expect(result.folders.map((f) => f.id).sort()).toEqual(['b', 'c']);
  });

  it('returns a no-op preview when the root is not a folder in the list', () => {
    // Defensive: a stale id (the row was already trashed) should
    // produce an empty preview, not throw.
    const result = computeFolderCascade('does-not-exist', [
      folder('a', 'A', []),
    ]);
    expect(result).toEqual({ folders: [], unlinkedItemCount: 0 });
  });

  it('handles deep chains without revisiting nodes (visited-set sanity)', () => {
    // A -> B -> C -> D -> E (single-parent chain)
    const folders = [
      folder('a', 'A', ['b']),
      folder('b', 'B', ['c']),
      folder('c', 'C', ['d']),
      folder('d', 'D', ['e']),
      folder('e', 'E', []),
    ];
    const result = computeFolderCascade('a', folders);
    expect(result.folders.map((f) => f.id)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('does not double-count a non-folder child reachable via two cascade-set folders', () => {
    // A
    // +- B
    // +- C
    // Both B and C list the SAME non-folder item x. The unlink
    // count should be 1, not 2, because the same UUID is the
    // same item; the visited-set guards against re-counting.
    const folders = [
      folder('a', 'A', ['b', 'c']),
      folder('b', 'B', ['x']),
      folder('c', 'C', ['x']),
    ];
    const result = computeFolderCascade('a', folders);
    expect(result.folders.map((f) => f.id).sort()).toEqual(['b', 'c']);
    expect(result.unlinkedItemCount).toBe(1);
  });

  it('cycle in the folder graph terminates rather than looping (defense in depth)', () => {
    // The save-time cycle check should prevent this, but the BFS
    // must still terminate if data is corrupt: A -> B -> A.
    const folders = [folder('a', 'A', ['b']), folder('b', 'B', ['a'])];
    const result = computeFolderCascade('a', folders);
    // B's only parent is A (in cascade) so it cascades; A is the
    // root so it doesn't appear in the returned `folders` list.
    expect(result.folders.map((f) => f.id)).toEqual(['b']);
  });

  // Anyone can list any folder in their own folder's childItemIds, so
  // the cascade must not take folders the caller cannot delete.
  it('leaves out and does not name folders the caller cannot delete', () => {
    const folders = [
      folder('a', 'Mine', ['b', 'x']),
      folder('b', 'Their private folder', ['c']),
      folder('c', 'Their subfolder', []),
      folder('x', 'My subfolder', []),
    ];
    const result = computeFolderCascade('a', folders, (id) => id !== 'b' && id !== 'c');
    expect(result.folders).toEqual([{ id: 'x', title: 'My subfolder' }]);
  });
});
