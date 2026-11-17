---
id: admin-roles
title: Roles
summary: The three roles, who can do what, and how to change a role or disable an account.
category: admin
order: 50
complexity: basic
tags:
  - admin
  - roles
  - permissions
related:
  - admin-organization-settings
  - sharing-an-item
---

A **role** is a coarse permission level for a user across your
organization. The role decides what a user can do in general.
Sharing decides which items they can open or edit.

## The three roles

- **Viewer.** Reads public items and the items shared with them.
  Cannot create or share items.
- **Contributor.** Everything a viewer can do, plus creating items
  (data layers, maps, forms, web apps and the rest), editing their
  own items, and sharing them.
- **Admin.** Everything a contributor can do, plus editing any item
  and the admin pages: users, branding, sign-in, notifications,
  housekeeping, backups and the rest.

There are no custom roles. On the Users page, **Access** and the
capability list in **Edit** show what one person can do, and an admin
can grant or remove a single capability for that person.

## Change a role

1. Open **Admin -> Users**.
2. Find the user. Search matches name, email and username.
3. Choose **Edit**, pick the role, and save.

The new role applies the next time the user signs in or their
session refreshes.

To add someone, use **Invite user**. You pick the role there. The
portal emails a link where they set their own password, so email
must be set up first (Admin -> Notifications).

## Safety rules the portal enforces

- **You cannot change your own role, disable yourself, or delete
  yourself.** Another admin has to do it.
- **The last active admin cannot be demoted, disabled or deleted.**
  Promote someone else to admin first.
- **The protected master account** cannot be changed from this page.

Keep at least two admins anyway. A second admin can recover the
organization if the first one cannot sign in. Admin -> Getting
started reminds you until you have one.

## Disable a user

Use **Disable** in the user's row, or turn off **Account active** in
**Edit**. A disabled user cannot sign in, and their browser session
ends when it next refreshes. Disabling also revokes the user's API
keys and stops their scheduled scripts. Their items stay where they
are, owned by them.

**Enable** turns sign-in back on. Revoked API keys stay revoked; the
user creates new ones.

**Auto-disable on** (in **Edit**) disables an account on a date you
pick, which suits contractors and temporary access. Admin ->
Housekeeping lists accounts with an upcoming date.

## Delete a user

**Delete** removes the account permanently. If the user owns items,
the portal asks who should own them first, and moves them before it
deletes the account.

## A user signs in but does not appear

A user created directly in Keycloak appears on the Users page after
their first sign-in. If every request they make fails with "JWT is
missing required org claim", their Keycloak account has no `org`
attribute. Users invited from this page always get one.
