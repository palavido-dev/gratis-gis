---
id: items-folder
title: Folder
summary: An item that groups other items into a named collection. An item can live in more than one folder at once.
category: items/organize
order: 150
complexity: basic
tags:
  - folder
  - item-type
  - organization
related:
  - items-map
---

A **folder** is an item whose body is a list of child item ids.
Folders organize your items the way real folders organize files,
with two important differences:

- **Multi-membership.** An item can live in more than one folder
 at once. A map can be in your "Storm response" folder AND your
 "2026 deliverables" folder. There's no master copy and no
 shortcuts; both references point at the same item.
- **Subfolders are just folders.** A folder appears inside another
 folder by being one of its child item ids. There's no separate
 "subfolder" type or path-based hierarchy.

## When to use folders vs. tags

- **Folders** organize for browsing. You walk a folder tree on the
 items page (the rail-tree on the left). One folder represents
 "things I work on together."
- **Tags** organize for search. A tag is free-form, applies in
 bulk, and surfaces in search filters. Tags don't appear as
 navigation; they appear as facets.

Use both, freely. They don't compete.

## Membership

The folder owns the list. Adding an item to a folder doesn't
modify the item itself; the item doesn't carry a `folderId`
column. This is why an item can be in many folders without any
data-model contortion.

Sharing is per-item, not per-folder. Putting an item into a folder
visible to your org doesn't share the item with the org; you still
share the item itself. The folder's contents are filtered to what
the viewer can read.

## Editing

From the items page, drag an item card onto a folder in the rail
tree. The folder's child list updates. The item's own page shows
which folders it's in (the **Folders** chip row), with one-click
removal.

## Deleting a folder

Deleting a folder removes the grouping. The child items are
unaffected; they remain in the system and stay in any other
folders that reference them. There's no "delete folder and its
contents" action; that would conflict with multi-membership.

## Notes

- **Per-user folders** aren't a separate item type. Folders are
 standard items with standard sharing. Set a folder to Owner-only
 if you don't want anyone else seeing it.
- **Folder ordering** is alphabetical by default; you can pin
 children to override.
