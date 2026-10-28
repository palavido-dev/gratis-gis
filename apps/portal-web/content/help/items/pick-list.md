---
id: items-pick-list
title: Pick list
summary: A reusable list of coded values with labels, referenced by fields on data layers and forms.
category: items/data
order: 90
complexity: intermediate
tags:
  - pick-list
  - item-type
  - schema
related:
  - items-data-layer
  - items-form
---

A **pick list** is an item whose body is a list of values, each
with a code and a label, optionally grouped, optionally with a
description and an icon. Fields on a data layer or form can
reference a pick list instead of carrying their own enum.

## Why pick lists are their own item

Reusable domain vocabularies (priority levels, status codes,
material types, asset categories) often appear in many layers and
many forms. If each carries its own copy of the list, renaming a
value or adding a new one means editing every layer. A pick list
item centralizes the vocabulary so the rename happens once.

## What's in a pick list

- **Entries**, each with:
  - **Code** (the value stored in the database; usually short).
  - **Label** (what users see; can change without rewriting data).
  - **Description** (optional, surfaced in tooltips).
  - **Color and icon** (optional, used by symbology and form
    rendering).
  - **Sort order**.
- **Groups** (optional). A two-level hierarchy for long lists.

## Referencing a pick list from a field

In the data layer schema editor (or form question editor), pick
**Pick list** as the field's type and select the item. The field
stores the **code**; UIs that render the value (attribute table,
popups, form rendering) substitute the **label** automatically.

You can override the displayed labels per-binding without forking
the pick list (useful when a field on one layer wants "Critical"
where the canonical label is "Severity 1").

## Editing entries

Adding new entries is always safe. Renaming a label is always
safe. **Changing a code** is constrained: if there's data already
written with the old code, the portal warns you and offers to
remap existing rows during the save.

**Deleting an entry** is similarly constrained: if any row
references the entry's code, deletion is blocked until those rows
are remapped or cleared.

## Sharing

Pick lists are usually broadly shared (Organization or Public) so
many items can reference them. The standard three-tier sharing
applies; if a user can read a layer but not its referenced pick
list, they see the raw code, not the label.

## See also

- **Geo boundary**. The same item-pattern for reusable polygons.
