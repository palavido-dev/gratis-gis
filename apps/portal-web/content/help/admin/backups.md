---
id: admin-backups
title: Backups
summary: What an admin backup contains, how to restore it, and what it does not cover.
category: admin
order: 30
complexity: advanced
tags:
  - admin
  - backup
  - restore
  - postgres
  - minio
related:
  - admin-organization-settings
---

GratisGIS keeps portal content in two places: **PostgreSQL** (items,
features, the observation log, sharing, form submissions) and
**object storage** (uploads, tile files, photos, signatures, and
other attachments). An admin backup is one `.tar.gz` that holds both.

Create and restore archives from **Admin → Backup**. The schedule
defaults to daily at 02:00 in the server's clock, and retention
keeps the **7** newest archives unless you change the count on that
page. A run that fails is marked failed on that page. It does not
send mail.

## What's in the archive

- A `pg_dump` custom-format dump of the **portal** database
  (`gratisgis`), including schema, features, and the observation log.
- A copy of every object in the portal bucket at the moment the
  backup read it.
- A `manifest.json` with the time, sizes, and the portal version
  when it was recorded.

An upload that is still in flight can land in one of those and not
the other. The gap is seconds, not a second copy of the system.

## What is not in the archive

- **Identity.** Usernames and passwords live in Keycloak's own
  database. The archive does not include that database, the realm,
  or client configuration. Item ownership in the portal database is
  the username, so the same usernames still own the same items after
  a portal restore. A person recreated under a different username
  does not inherit the old items. Signing in with a different role
  overwrites the restored role.
- **The encryption key and deployment secrets.**
  `CREDENTIAL_ENCRYPTION_KEY`, database passwords, and the sign-in
  URL live in `infra/.env.prod` or, on a home NAS, the `boot`
  volume. Without that same key, credentials the portal stored for
  external services cannot be decrypted. A freshly generated install
  has a new key. Restore the archive on this portal, or on a copy
  of the machine that still has the original env file and volumes.
- **Encryption of the archive itself.** The `.tar.gz` is not
  encrypted. If you need that, wrap the file with your own tool
  before it leaves the machine.
- **Off-site storage.** The archive is written to the
  `portal-api-backups` volume on this host. Downloading it to a
  browser on this same machine is not an off-site copy. Copy the
  file, and the env file or `boot` volume, to another disk.
- **Phones and browsers.** The field app's unsynced edits stay on
  the device until they sync. A portal backup cannot see them.
- **Point-in-time recovery.** There is no WAL archive. The recovery
  point is the newest archive you have stored somewhere else.

## Restore

Restore is a button on **Admin → Backup**. It asks you to type the
portal's name, turns maintenance mode on, replaces the portal
database and the object bucket from the archive, then turns
maintenance mode off only if that finishes.

If restore fails, maintenance stays on so a half-applied database is
not served. Do not clear that flag until the database is known good.
The host steps are in `docs/deployment.md` under "When a restore
fails", and the checker is `infra/restore-maintenance.sh`. It will
not clear maintenance while the portal tables are missing.

Take a snapshot of the PostgreSQL and object-storage volumes before
the first restore. The in-portal restore is destructive.

Keycloak is not restored by this button. If you also need identity
from a particular time, you need a separate dump of the Keycloak
database taken at the same time. The portal archive is not that dump.

## Before an upgrade

Create a backup, download it, and copy it off the host together with
`infra/.env.prod` or the NAS `boot` volume. The upgrade guide is `docs/UPGRADING.md`.
