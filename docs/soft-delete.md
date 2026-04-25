# Soft delete and the recycle bin

## Why

"I accidentally deleted that feature layer five minutes before the client
meeting" is a story we want to not have. Delete in GratisGIS is reversible
by default. A hard delete exists, but it is always a second, deliberate
step performed on an already-trashed item.

## Tables that participate

The recycle-bin pattern is applied to first-class, user-owned content:

- `item`: maps, feature services, forms, apps, dashboards, notebooks,
  tools, widgets, files, report templates.
- `group`: sharing principals, so deleting a group preserves the
  possibility of undoing it along with the shares that referenced it.

Tables that are structural or derivative are *not* soft-deleted. Removing
an `item_share` or a `group_member` is a sharing / membership
adjustment, not a content deletion, and bringing it back is trivial.

## Schema

Each participating table has:

```prisma
deletedAt DateTime? @map("deleted_at")

@@index([deletedAt])
```

Nullable timestamp. `NULL` means live. Non-null means trashed, with the
timestamp capturing when it was moved. The index keeps queries that
filter on `deletedAt IS NULL` (the common path) and `deletedAt IS NOT
NULL` (the trash view) both fast on a table of any size.

## Query semantics

- Every list / read query filters `deletedAt IS NULL` by default.
- There is a `listTrash` method per resource for the trash view only.
- A soft-deleted row is invisible to every endpoint except the trash
  view, restore, and purge. In particular:
  - Sharing checks never match. The `visibleWhere` helper excludes
    trashed items so a share recipient does not see a deleted item.
  - Group memberships pointing to a trashed group are stripped from the
    user's effective `groupIds` in `AuthSyncService`, so any `ItemShare`
    still pointing to that group stops granting access.
  - `assertPrincipalExists` rejects a trashed group as a share target,
    so no new shares can accumulate on a soon-to-be-purged group.

## Retention and purge

Trashed rows remain for a retention window (default 30 days). A
scheduled job runs `DELETE FROM item WHERE deleted_at < NOW() - interval
'30 days'` and the equivalent for groups. The window is configurable
per deployment (`RECYCLE_BIN_RETENTION_DAYS`).

Users with owner or org-admin permission can also purge immediately from
the trash view. Immediate purge is the *only* way to permanently remove
content from a running system, and it still requires the two-step
ceremony (delete → then purge) so a bad client cannot skip straight to
hard delete.

## API surface

For items:

```
DELETE /api/items/:id           soft-delete (move to trash)
POST   /api/items/:id/restore   restore from trash
DELETE /api/items/:id/purge     permanent delete (trash-only)
GET    /api/items/trash         list my trash (or org trash if admin)
```

Groups mirror the same four verbs. `GET /api/groups/trash`, the other
three on `/api/groups/:id`.

## Authorization

- Soft-delete requires the existing canAdmin rule for the resource
  (owner or org admin). Same rule as a hard delete would have required.
- Restore and purge both require canAdmin and that the row already be
  in the trash.
- The trash list is scoped to content the caller actually owns, plus
  anything in their org if they are an org admin. A collaborator who
  had edit access while the item was live cannot surface or restore
  it after the owner trashed it. That matches the mental model of
  "my recycle bin, not everyone's."

## Cascade behavior on purge

When a row is purged (hard-deleted), the existing Prisma `onDelete:
Cascade` relations do the right thing:

- Purging an `item` cascades to `item_share`.
- Purging a `group` cascades to `group_member` and, separately, to any
  `item_share` rows whose `(principal_type = 'group', principal_id =
  <group id>)`. Prisma does not model that second cascade because the
  polymorphic FK lives behind a trigger (see `data-model.md`). The
  trigger in `migrations/.../polymorphic_share_fk.sql` handles it.

## UI

The item and group list pages show live content only. A single
"Recently deleted" destination in the sidebar opens `/recently-deleted`,
a tabbed surface covering every kind of soft-deletable content (items
and groups today, users and reports later). Each row has Restore and
"Delete forever" buttons; permanent delete requires typing the title
to confirm. The label is deliberately a noun ("Recently deleted"),
not a verb ("Trash" / "Delete"), so it reads as a destination rather
than an action next to the other buttons on a list page.

The legacy per-section paths `/items/trash` and `/groups/trash`
redirect to `/recently-deleted?kind=items` and `?kind=groups` so
bookmarks keep working.
