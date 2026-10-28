---
id: admin-roles
title: Roles
summary: How user roles work, who can do what, and how to assign or change a user's role.
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
![Admin Users and roles list](/help/admin/users.png)

A **role** is a coarse permission level applied to a user across
their entire org membership. Roles control what the user can do
in general; per-item sharing controls what specific items they
can read or edit.

## The four built-in roles

- **Viewer.** Can read shared items. Can't create new items or
 edit anyone's items.
- **Data editor.** Same as Viewer, plus can edit features on
 layers that are shared to them with edit access. Common role
 for field crews and inspectors.
- **Contributor.** Same as Data editor, plus can create new
 items (data layers, maps, forms, web apps). The standard
 "I publish stuff" role.
- **Admin.** Full org control. Can manage users, change org
 settings, run housekeeping actions, configure backups and
 geocoders.

Custom roles are not in v1; everyone falls into one of these
four buckets.

## Assigning a role

1. **Admin → Roles.**
2. Find the user (search by name or email).
3. Pick their role from the dropdown.
4. Click **Save**.

The change takes effect on the user's next page load; existing
sessions continue at the old role until they refresh.

## A user signs in but doesn't appear

Two cases:

- **Provisioned by Keycloak, not yet seen by the portal.** A
 user can exist in Keycloak before the portal has any record
 of them; they're created in the portal's user table on
 first sign-in. Have them sign in once; they then appear in
 admin → roles.
- **Missing the org claim on the JWT.** Some pre-schema-change
 Keycloak users may have an empty attribute set; their JWTs
 lack the `org` claim and every API call 401s. Fix by setting
 the org attribute via Keycloak admin (`PUT
 /admin/realms/.../users/{id}`).

The roles dashboard's "Pending users" tab shows users who've
signed in but lack a role assignment; assigning one is the
typical onboarding step.

## Disabling a user

Use the **Disable** action in the user row. A disabled user's
session is invalidated; they can't sign back in. Their items
are kept; ownership doesn't transfer automatically. If you
want to reassign ownership of orphaned items, the housekeeping
dashboard has a bulk **Transfer ownership** action.

To re-enable, set the role back from Disabled to anything else.

## Per-item access

A user with role Viewer can still be granted edit access on a
specific layer through custom per-item sharing. The role is the
floor; per-item sharing adjusts the ceiling.

## Notes

- **Admins can demote themselves.** There's no "you can't take
 admin away from yourself" check; if you're the only admin
 and you demote yourself to Contributor, you have to ask
 someone with backing-store access to fix it. Keep two admins
 per org for this reason.
