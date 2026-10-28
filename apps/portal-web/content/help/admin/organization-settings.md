---
id: admin-organization-settings
title: Organization settings
summary: "Org-wide preferences: default basemap, default item sharing, storage budget, allowed file types, contact info."
category: admin
order: 40
complexity: basic
tags:
  - admin
  - organization
  - settings
related:
  - admin-roles
  - admin-branding
---
![Admin section in the portal sidebar](/help/admin/users.png)

The **organization settings** page (admin → organization) is
where the org-level defaults and policies live. Settings here
affect every member of the org and every item they create.

## What's configurable

- **Org name and short id.** The short id appears in URLs and
 in API responses; once set, changing it breaks every existing
 link. Pick deliberately.
- **Contact information.** Org admin email (where alerts go);
 support contact (shown in the portal footer if set).
- **Default basemap.** The basemap new maps start with. Override
 per map.
- **Default item sharing.** What sharing tier new items default
 to (Owner only, Organization, or Public).
- **Allowed file types.** Whitelist of MIME types the portal
 accepts on file uploads. Default is permissive; tighten if
 your org has a policy.
- **Maximum file size.** Per-upload cap. Default 1 GB.
- **Storage budget.** Soft cap on MinIO bytes; admins are
 notified when the org crosses 80% / 95%. Hard caps are an
 infra-side configuration, not exposed here.
- **Per-user item quotas** (optional). Maximum number of items
 per user. Useful in classroom or evaluation deployments.
- **Session timeout.** How long a sign-in lasts; default 7
 days.
- **Show "Coming from ArcGIS Online?"** card on the portal
 home page. Toggle if your audience is not a migration cohort.

## What's NOT here

- **User account management.** Lives in **Roles** (admin →
 roles). Adding users, role changes, disabling accounts.
- **Keycloak realm config.** External Keycloak surface; not a
 portal setting. See **admin → identity** for the bridge that
 the portal needs (issuer URL, audience).
- **Branding (logo, colors, fonts).** Lives in **Branding**
 (admin → branding).

## Notes

- **Multi-org deployments.** Each org has its own settings.
 Cross-org defaults aren't a thing today; the portal is
 designed for one org per portal instance, with multi-org
 layered on top as a tenanting concern.
- **Settings audit log.** Every settings change is logged with
 who, when, and what changed. View at admin → organization →
 history.
