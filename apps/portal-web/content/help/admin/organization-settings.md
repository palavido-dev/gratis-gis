---
id: admin-organization-settings
title: Organization settings
summary: Where the organization-wide settings live, and which limits come from the server rather than a page.
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

There is no single organization settings page. Organization-wide
settings are spread across the admin pages by topic, and some limits
are server settings that the person who runs the portal sets.

## Settings by page

- **Admin -> Branding**: organization name and the public landing
  page.
- **Admin -> Users**: invite people, set roles, disable or delete
  accounts, and set auto-disable dates.
- **Admin -> Sign-in**: add a work account provider people already
  have, and require an authenticator at the next sign-in.
- **Admin -> Notifications**: SMTP for outgoing email and the email
  delivery queue.
- **Admin -> Housekeeping**: stale content, quiet accounts and
  scheduled cleanup.
- **Admin -> Backup**: backup schedule, retention and restore.
- **Admin -> AI**: optional connection to an AI provider.
- **Admin -> Updates**: the running version and what is available.
- **Admin -> Audit** and **Admin -> Permissions**: what admins did,
  and who can reach which items.

## Limits that are server settings

These are environment variables on the server, not portal pages:

- **Email on or off.** Email is sent only when
  `NOTIFICATIONS_ENABLED=true`, even with SMTP saved.
- **Session length.** The portal sign-in cookie lasts 365 days by
  default (`GRATIS_SESSION_MAX_AGE_SECONDS`), with an optional idle
  limit (`GRATIS_SESSION_IDLE_SECONDS`). Keycloak's own web session
  ends after 1 hour idle or 10 hours in total.
- **Retention.** The recycle bin keeps items 30 days
  (`RECYCLE_BIN_RETENTION_DAYS`) and the admin audit log 400 days
  (`GRATIS_ADMIN_AUDIT_RETENTION_DAYS`).

## What does not exist

There is no storage budget or storage alert, no per-user item quota,
no allowed file type list, and no history of setting changes beyond
the admin audit log. Watch disk use on Admin -> Housekeeping.
