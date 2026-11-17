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

The **Housekeeping** page (Admin -> Housekeeping) lists items and
accounts that look like they could be reviewed or retired, with bulk
actions. Everything it shows is a suggestion. Nothing is removed
unless you choose to, or turn on scheduled cleanup.

## Review

- **Stale items.** Items with no item edits and no feature edits for
  the stale window, and no shares. The default window is 90 days.
  Tick items and choose **Move to trash**.
- **Quiet users.** Accounts with no sign-in for the quiet window,
  180 days by default. Admins are left out on purpose. Tick users
  and choose **Disable sign-in**. When they own items, the portal
  asks who should own them (you, by default) and moves the items
  before it disables the accounts.
- **Shares expiring soon** and **users auto-disabling soon**, with
  actions to extend by 30 days, cancel, or act now.
- **Storage usage**: host disk, the Postgres database and the object
  store, plus the data layers with the largest feature footprint.

## Cleanup

Tools to recompute item extents, build feature search indexes, and
find broken references, orphaned uploads, unused app templates and
themes.

## Schedule

Scheduled cleanup is off until you turn it on. It can move items
nobody has edited or shared to the trash, pause sign-in for
inactive accounts (admins are skipped), refresh extents, and tidy
the field device queue list. You set the number of days for each.

## Thresholds

The default windows come from the server's environment:
`HOUSEKEEPING_STALE_ITEM_DAYS` (90) and
`HOUSEKEEPING_STALE_USER_DAYS` (180). The schedule tab sets the
windows the scheduled jobs use.

## Notes

- **Trash is not delete.** Items moved to trash stay in Recently
  deleted for 30 days (`RECYCLE_BIN_RETENTION_DAYS`) and can be put
  back with the same id. After that they are purged.
- **Disabled accounts keep their items** unless you reassign them.
  Disabling also revokes the account's API keys and stops its
  scheduled scripts (see Roles).
- **One organization at a time.** An admin sees and acts on their own
  organization only.
