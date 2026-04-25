# Folders

How users organize items in a GratisGIS portal.

Replaces the AGO conflation of "folder" with "storage / ownership."
Here a folder is a *view*: a way to group items, not a permission
gate or a single-owner storage location. An item can sit in zero
folders or many. Per-item authorization decides what a viewer
actually sees inside any folder. Sharing a folder shares only its
arrangement, not access to its contents.

## Goal

Three pain points to solve, all from real AGO usage:

1. **Per-user folders break in multi-owner orgs.** AGO folders are
   storage scoped to one owner, so sites with multiple data owners
   end up funnelling everything through a single admin user. We will
   not have a single owner; folders cannot be ownership-scoped.
2. **Categories require a single curator.** AGO categories are
   admin-defined and the lone curator is always a bottleneck. Anyone
   should be able to make a curated bucket.
3. **Tags are not filterable.** A separate slice (#X) makes existing
   tags filterable in the items list. Folders solve a different
   problem (hierarchy + curated grouping); tags stay flat.

## Data model

A folder is a regular item with `type = 'folder'`. Its `data` is:

```ts
interface FolderData {
  childItemIds: string[];
}
```

That is the entire payload. Folder ownership, sharing, soft-delete,
license, tags, dependency tracking, geo-limit (irrelevant for
folders but the field exists), housekeeping: all inherited from the
item model. No new tables; no per-subfolder shares; no nested data.

A subfolder is a folder whose UUID appears in another folder's
`childItemIds`. There is no separate "subfolder" type, no parent FK
column, no nested JSON. "Top-level" vs "subfolder" is a UI
presentation question, not a schema distinction.

A folder may sit in any number of parent folders. The structure is
formally a DAG; most users will treat it as a tree but we do not
enforce one. Cycle detection runs at save time: a folder's
`childItemIds` save fails if any reachable child eventually points
back to the folder being saved. Same shape as the cycle check
planned for #73 (map-as-basemap).

## Resolution semantics

Whenever a folder's contents are rendered, the API:

1. Loads the folder's `childItemIds`.
2. Joins against `item` table, dropping any UUID that does not match
   a row (defensive against orphaned references).
3. Filters by the caller's normal item authorization (private/org/
   public + share rules + caller is owner / admin).
4. Returns the surviving items, in `childItemIds` order.

This means three things, intentionally:

- **Items the caller cannot see do not appear**, even if they exist
  and are listed in the folder. The folder appears smaller to that
  caller. There is no "you have N hidden items" hint; that would
  itself be an information leak.
- **Trashed (soft-deleted) items disappear from the folder
  automatically** because the items list filter already drops them.
  Restoring an item from `recently-deleted` makes it reappear in
  every folder that referenced it.
- **Hard-deleted (purged) items get spliced out of `childItemIds`
  proactively** by the dependency tracker (see below). Stale
  references are bookkeeping debt, not a UX problem; the resolution
  layer handles them either way.

Folders are themselves items, so the same rules apply when a
subfolder appears inside a parent: the subfolder card only renders
if the caller can see the subfolder item.

## Dependency tracking

Folders integrate with the existing dependency-extractor
(`apps/portal-api/src/items/dependency-extractor.ts`). The extractor
emits one edge per UUID in `data.childItemIds` for every folder
item, exactly the same shape as `map -> basemap`,
`map -> defaultExtentBoundary`, `share -> geo_boundary`.

Two effects:

1. **Item detail pages show the folders containing this item** in
   their existing "Used by" surface. Useful for an author looking at
   a data layer who wants to know "what projects is this in?"
2. **Hard-delete cascades into folder cleanup.** When an item is
   purged, the existing dependency-driven cleanup walks dependents,
   finds folder items, and splices the now-gone UUID out of each
   `childItemIds`. Soft-delete is intentionally a no-op (so trash
   restoration restores folder membership too).

Permission changes are NOT a delete; they are not seen by the
dependency tracker. The view-time authorization filter handles them.

## UI

### Items page

The items list (`/items`) gains a left-rail folder tree. The rail
shows top-level folders eagerly; subfolders fetch on expand. A
folder is "top-level" when no other folder references it via
`childItemIds` (a cheap NOT EXISTS query) -- equivalent to `lsblk`'s
notion of a tree root.

The grid on the right is unchanged for the no-folder-selected state:
it shows every content item the caller can see, the same as today.
Click a folder in the rail and the grid scopes to that folder's
contents. Subfolders inside the current folder render as folder
cards in the grid; clicking one drills in.

**The grid never shows folders in the global "All items" view.**
Folders surface only through the rail tree, the folder detail
context, search results, and the admin folders list. This is the
explicit fix for the "thousands of folder cards in /items" failure
mode.

Breadcrumbs above the grid show the current folder path:
`Project A > 2026 Surveys > Stream Surveys`. When the same folder
appears in two parents (multi-membership DAG), the breadcrumb
reflects the path the user navigated, not a canonical path.

### Search and admin

Search results that include folder items render each folder row
with breadcrumbs ("Project A > 2026 Surveys") so collisions like
two `Surveys` folders in different projects are immediately
distinguishable. Same rule for the admin folders surface under
`/admin` and any future "folders that I own" view.

This is the contract: a folder out of context always carries enough
breadcrumb to disambiguate.

### Wizard tiles

The new-item wizard offers a "Folder" tile alongside maps, data
layers, etc. Creating from the tile makes a top-level folder.
Creating from inside another folder (`+ New subfolder` button on
the folder detail page) creates a folder and atomically appends
its UUID to the parent's `childItemIds`. The "Add to folder"
multi-select on the items list bulk-action bar adds existing
items to a folder.

### Drag-drop and move

Drag a folder card onto another folder card moves it: remove the
moved folder's UUID from the source parent's `childItemIds`, append
to the destination parent's. To allow multi-membership, holding a
modifier (Alt? Shift?) copies instead of moves. v1 ships move-only;
copy is a follow-up.

## Phased rollout

### Phase 1a (this slice)

- Add `folder` to the `ItemType` enum in Prisma + shared-types.
- `FolderData = { childItemIds: string[] }`.
- New-item wizard tile.
- Folder detail page renders contents using a new
  `GET /api/items/:id/folder-contents` endpoint that wraps the
  existing items list with the resolution semantics above.
- Items list left-rail folder tree (top-level eagerly,
  subfolders on expand).
- Items list grid filters out type=folder by default; the rail is
  the only path to folders.
- Bulk-action "Add to folder" multi-select.
- Dependency-extractor emits child edges for `childItemIds`.
- Hard-delete cleanup splices stale references.
- Cycle detection at save time.

### Phase 1b

- Drag-drop reorder and move within the rail and grid.
- Search results breadcrumbs.
- Admin folders surface under `/admin`.

### Phase 2

- Smart folders: `data.kind = 'query'` saves a query
  (type, tag, bbox, etc.) instead of a fixed `childItemIds`.
  Renders identically; resolution layer runs the saved query
  instead of joining UUIDs. Solves the "stale curated category"
  problem without a curator.
- Copy-vs-move modifier on drag-drop.

## Non-goals

- **Folders do not constrain access.** A user with read access to a
  data layer can find that layer through search or any folder it
  appears in. Hiding it requires a sharing change, not a folder
  rearrangement.
- **No "primary" folder.** An item is in N folders or zero.
  Removing it from one folder does not remove it from the others
  and never deletes the item.
- **No folder ownership transfer separate from item ownership.**
  Reassign a folder's owner the same way you reassign any item.
- **No "system folders" baked in.** The portal does not seed
  folders per org. Admins who want them can create org-shared
  folders themselves.