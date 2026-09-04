---
id: sharing-an-item
title: Sharing an item
summary: Every item carries its own ACL.  This page shows you the three sharing tiers and how to change them.
category: getting-started
order: 30
complexity: basic
controls:
  - id: sharing-panel
    label: "Sharing section on the item detail page"
tags:
  - sharing
  - permissions
related:
  - what-is-gratisgis
---

Every item in GratisGIS has a sharing tier. The tier decides who
can find and open the item.

Sharing has two layers, and it helps to keep them apart. **Visibility**
is the broad question of who can find the item at all. **Shares** are
grants to a named person or group, each with its own permission level.

## Visibility: the three tiers

- **Owner only** (default). Only you, anyone you share with
 explicitly, and org admins can see the item.
- **Organization**. Anyone signed in to your organization can find and
 open the item.
- **Public**. Anyone with the link can see the item, even without
 signing in. Used for shareable web apps and embeddable maps.

Visibility on its own grants read access. It never grants editing.

## Shares: giving one person or group more

On the item's **Access** tab you can add a user or a group and choose
what they get:

- **can view**. Open it and look at it.
- **can download**. View, plus export the data out.
- **can edit**. View, plus change the item and its contents.
- **can admin**. Everything except ownership itself.

So you do not have to hand over an item to let a colleague work on it.
Add them at **can edit** and they can. Reassigning ownership is for
when someone is actually taking the item over, usually because the
owner is leaving.

Two further controls sit on a share once you have made one: a **row
scope**, which can limit an editor to the rows they created
themselves, and a **geographic limit**, which clips what they see to a
boundary. Both are described in the sharing granularity reference.

## How to change visibility

1. Open the item's detail page.
2. Go to the **Access** tab.
3. Pick a tier. The change saves immediately.

## What sharing does NOT do
- **It doesn't override file-system permissions.** If a layer is
 shared publicly, its underlying PostGIS rows are readable through
 the API. Don't share a layer publicly if any of its attributes
 are sensitive.

## Dependencies

If you share a map but not the data layer the map references, users
who can open the map still won't see the layer. The **Dependency**
panel above Sharing surfaces this: a yellow warning appears when
the item depends on something less-shared than itself.

For forms, sharing is double-keyed: the **form item** controls who
can submit, the **paired data layer** controls who can view
submissions. See **Forms → Sharing a form** for the details.
