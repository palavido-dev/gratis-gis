---
id: admin-backups
title: Backups
summary: How GratisGIS backups work, where they live, how to restore, and what they don't cover.
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
![Admin Backup settings](/help/admin/backup.png)

GratisGIS persists state in two places: **PostgreSQL** (every
item's metadata, every feature, the observation log) and **MinIO**
(uploaded files, tile layers, attachments, generated PDFs).
Backups have to cover both, and a restore has to restore both
together.

## What's backed up

- **PostgreSQL** dump. The default backup job runs `pg_dump` on
 the `gratisgis` database with the custom format (`-Fc`).
 Includes schema, data, and the observation log.
- **MinIO bucket sync**. `mc mirror` of the `gratisgis` bucket
 to the backup store. Preserves the directory tree and content
 types.

Both run on the same schedule so a recovery point is consistent
(give or take seconds; in-flight uploads at backup time may
appear in PG but not in MinIO yet).

## Backup destinations

The portal supports three backup destinations:

- **Local disk** (a host path mounted into the container). Cheap
 and simple; not safe against host loss.
- **S3-compatible** (another MinIO instance, AWS S3, Backblaze
 B2). Set credentials in admin → backups.
- **SFTP** (host, port, key). Useful for "ship to the org's
 existing fileserver" deployments.

Multiple destinations are supported; backups fan-out.

## Schedule

The default schedule is **nightly at 2am local time**. Adjust at
admin → backups → schedule. The portal supports a fuller cron
expression if you need it.

Retention is **N most recent** by default (default N: 14). Older
backups are pruned automatically.

## Restore

There is no one-click restore from inside the portal; restoring
is a deliberate operation by a sysadmin. The high-level
procedure:

1. Stop the portal-api and portal-web containers.
2. Restore Postgres from the dump: `pg_restore -d gratisgis
 backup.dump`.
3. Restore MinIO from the bucket sync: `mc mirror backup-store
 minio/gratisgis`.
4. Start the containers; the portal boots against the restored
 state.

The detailed restore runbook lives at **docs/operations/
restore.md** in the repo (out of scope for this help page; this
page is the operator's reference for what the backup system
does).

## What's NOT backed up

- **Keycloak's database.** Users, realms, and credentials live
 in Keycloak's own Postgres database, backed up separately.
 Restoring portal state without Keycloak leaves you with items
 but no one to log in as.
- **Local-disk caches** (the field PWA's IndexedDB, the
 browser's MapLibre tile cache). These regenerate on demand
 and don't need to be preserved.
- **In-memory state**. Active sessions, in-progress feature
 edits not yet saved. Lost on restart by design.

## Notes

- **Backup health.** The dashboard at admin → backups shows last
 success/failure timestamps and file sizes. A failed backup
 surfaces an admin notification.
- **Test restores periodically.** A backup you've never
 restored is a backup you don't have. Cycle a restore against
 a staging instance quarterly at minimum.
