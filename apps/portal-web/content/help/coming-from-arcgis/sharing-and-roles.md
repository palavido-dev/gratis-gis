---
id: coming-from-arcgis-sharing
title: Sharing and roles
seoTitle: "ArcGIS Online sharing, groups and user types in GratisGIS"
summary: How ArcGIS Online roles, user types, groups and sharing levels map onto GratisGIS. Three roles, no user types or credits, and per-item shares that can grant editing.
category: getting-started/coming-from-arcgis
order: 15
complexity: basic
tags:
  - migration
  - sharing
  - roles
  - permissions
  - groups
related:
  - sharing-an-item
  - admin-roles
  - coming-from-arcgis-terminology
---

ArcGIS Online controls access with three things: a user type that
you pay for, a role, and the sharing level on each item. GratisGIS
drops the user type and keeps the other two. A role sets what a
person can do in general. Sharing on each item sets what they can
open, download or edit.

## User types and licenses

There are no user types, named-user licenses or credits. You run
the server, so adding a viewer, an editor or a field collector costs
nothing. The limits that do exist come from your server's disk,
memory and CPU.

## Roles

| ArcGIS Online role | GratisGIS role | Notes |
|---|---|---|
| Viewer | **Viewer** | Opens items shared with them. Cannot create items. |
| Data Editor | **Viewer**, plus a **can edit** share | Editing comes from a share on the layer, not from the role. |
| User | **Contributor** | Creates, edits and shares their own items. |
| Publisher | **Contributor** | Any contributor can create data layers. There is no separate publishing step. |
| Administrator | **Admin** | Edits any item and runs the admin pages. |

There are no custom roles. On **Admin -> Users**, an admin can grant
or remove a single capability for one person. See
[Roles](/help/admin/roles).

## Sharing levels

| ArcGIS Online | GratisGIS | Notes |
|---|---|---|
| Owner | **Owner only** | The default. The owner, people it is shared with, and admins. |
| Organization | **Organization** | Anyone signed in to your organization. |
| Everyone (public) | **Public** | Anyone with the link, without signing in. |
| Shared with a group | A **share** with a group | Each share has its own permission level. |

Visibility alone only ever grants read access. See
[Sharing an item](/help/getting-started/sharing-an-item).

## Shares do more than groups do in ArcGIS Online

In ArcGIS Online, sharing an item with a group gives the group the
same access as everyone else who can see it. Editing needs a
separate setting on the layer, or a shared update group. In
GratisGIS each share to a person or a group carries its own level:

- **can view**. Open the item.
- **can download**. View, plus export the data.
- **can edit**. View, plus change the item and its features.
- **can admin**. Everything except ownership.

Two more limits can sit on a share:

- **Row scope** limits an editor to the features they created. This
  covers the common "collectors can only edit their own points"
  setup.
- **Geographic limit** clips what the person or group sees to a
  boundary. Use a [Geo boundary](/help/items/geo-boundary) item for
  the area.

## Things that catch ArcGIS Online users out

- **A map does not lend access to its layers.** If you share a map
  but not its data layer, people can open the map and the layer
  does not draw. The **Dependency** panel on the item warns when an
  item depends on something shared more narrowly.
- **Forms have two keys.** The form item controls who can submit.
  The paired data layer controls who can see the responses.
- **Public means public through the API too.** A public data layer
  can be read in full through the API, every attribute included.
  Do not make a layer public if any field is sensitive.
- **Transfer ownership only when someone takes over.** To let a
  colleague work on your item, add them with **can edit**.

## Moving users over

The ArcGIS Online importer can bring users and groups over. In
**Admin**, **ArcGIS Online import and export**, sign in as an ArcGIS
Online administrator and tick **Also import users and groups** before
**Run import**.

- **Users** get an account with the same username in lower case,
  their name and email. A username or email already in the portal
  is matched instead of duplicated, and a member with no email
  address is skipped.
- **Roles:** Administrator becomes Admin, the built-in Viewer role
  becomes Viewer, and every other role (User, Publisher, Data Editor
  and custom roles) becomes Contributor. Check custom roles by hand
  afterward.
- **Groups** come over with their title, description, sharing level
  and members. The ArcGIS group owner and managers become group
  admins. A group with the same title as one already here is reused.
- **Sharing:** each imported item is shared with the same groups it
  was shared with in ArcGIS Online, with view permission.
- **Passwords** never leave ArcGIS Online. Tick **Email new users a
  link to set their password**, or leave it off and send the links
  later from **Admin -> Users**. Email has to be set up first under
  **Admin -> Email delivery**. If
  your people sign in through a work account (single sign-on), set
  that up under **Sign-in** instead.

You can still invite people one at a time from **Admin -> Users**.
