---
id: admin-housekeeping
title: Housekeeping
summary: The admin dashboard that surfaces stale items, quiet users, and orphaned dependencies, with bulk actions to clean up.
category: admin
order: 10
complexity: intermediate
tags:
  - admin
  - housekeeping
  - cleanup
related:
  - admin-organization-settings
  - admin-roles
---
![Admin Housekeeping settings](/help/admin/housekeeping.png)

The **Housekeeping** dashboard (admin → housekeeping) surfaces
items and users that have gone stale, alongside one-click bulk
actions. The goal is to keep the portal's item list current
without manually auditing every item.

## What it shows

The dashboard is sectioned. Each section is one signal:

- **Stale items.** Items not updated in N months (default: 12).
 Sorted by last-update date. Bulk action: archive or delete.
- **Untouched items.** Items created but never edited after
 creation. Often abandoned drafts. Same bulk actions.
- **Items with no readers.** Items whose detail page hasn't
 been opened in N months. The "is this still useful" signal.
- **Quiet users.** Users with no sign-in in N months. Bulk
 action: disable account.
- **Broken dependencies.** Maps referencing data layers that
 were deleted; web apps referencing maps that no longer exist.
 Bulk action: surface each on its respective detail page.
- **Storage hogs.** Items consuming the most MinIO bytes. Sort
 by size. Useful when an org hits its storage budget.

## Customizing the thresholds

The dashboard's thresholds (N months) are admin-tunable at
**admin → housekeeping → settings**. Defaults are:

- Stale: 12 months.
- Untouched: 6 months.
- No readers: 12 months.
- Quiet user: 6 months.

Conservative defaults; pick what matches your org's churn.

## Bulk actions

Each section has a multi-select with bulk actions appropriate to
the signal. Bulk archive moves items to an archived state where
they're hidden from default lists but recoverable. Bulk delete is
soft-delete by default (recoverable for 30 days); a hard-delete
option requires an extra confirmation.

## Notes

- **Soft delete is reversible** for 30 days. Restored items
 come back with the same id and references intact.
- **Don't bulk-delete on first run.** The first time you open
 housekeeping on a long-running portal, the stale-items list
 can be huge. Archive first; come back to delete after a few
 weeks of confirming no one notices.
- **Per-user views.** A regular admin sees their own org only.
 Cross-org views are restricted to super-admin.
