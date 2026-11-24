# Continuous backups and point-in-time restore

Status: draft for review (RB-18 stage 1). Nothing here is turned on for
any install until the owner approves it and runs `infra/pitr-setup.sh`.

Goal (D10): restore the database to any minute in the last 14 days,
from backups kept at a different company than the server. Losing the
server loses at most about 5 minutes of writes.

Related: [restore runbook](restore-runbook.md),
[test plan](pitr-test-plan.md).

## Decision: pgBackRest

Use **pgBackRest 2.60.1** (or newer), installed from the PostgreSQL
apt repository (PGDG) in our Postgres image.

### Its status today (checked 2026-11-24)

- 2026-04-27: the maintainer announced "pgBackRest is no longer being
  maintained" and the repository was archived. Source:
  [pgBackRest news](https://pgbackrest.org/news.html).
- 2026-05-04: maintainer said funding was "all but certain". Same page.
- 2026-05-18: "pgBackRest Will Continue!": a sponsor group (AWS,
  Supabase, pgEdge, Tiger Data, Percona, Eon.io) funds development.
  Same page. Percona's account, 2026-05-19:
  [Backrest's back, alright!](https://percona.community/blog/2026/05/19/backrests-back-alright/)
  (written by one of the sponsors).
- Releases since then, all on the news page: 2.59.0 (2026-07-20),
  2.59.1 (2026-08-17), 2.59.2 (2026-09-27), 2.59.3 (2026-10-04),
  2.60.0 (2026-10-18), **2.60.1 (2026-11-16)**. Six releases in four
  months, including PostgreSQL 19 support. That is active maintenance.
- 2026-10-04 security notice: versions before 2.59.3 could make weak
  encryption subkeys and salts. Our image build stops if the installed
  version is older than 2.59.3.
- Packages: PGDG `trixie-pgdg` has `2.60.1-1.pgdg13+1` (apt index read
  2026-11-24). Debian's own trixie package is 2.55.1
  ([sources.debian.org](https://sources.debian.org/src/pgbackrest/)),
  which is older than the fix. apt picks the PGDG one because it is
  newer; the version check in the Dockerfile makes sure.
- 2.59.0 changed one thing that matters here: non-restore commands
  refuse to run as root. Our scripts always run it as `postgres`.

### Compared with Barman and WAL-G, for this setup

Setup: one Postgres 17 + PostGIS container, S3-compatible bucket on
Backblaze B2, client-side encryption, restore to a time, one operator.

| Need | pgBackRest 2.60 | WAL-G 3.0.9 | Barman 3.20 (barman-cloud) |
| --- | --- | --- | --- |
| Latest release | 2026-11-16 | 2026-08-20 ([releases](https://github.com/wal-g/wal-g/releases)) | 2026-08-27 ([notes](https://newreleases.io/project/github/EnterpriseDB/barman/release/release%2F3.20.0)) |
| Runs inside the Postgres container, no extra server | yes | yes | yes (barman-cloud scripts) |
| S3-compatible bucket | yes | yes | yes |
| Client-side encryption | yes, AES-256 built in | yes, libsodium or OpenPGP | not in barman-cloud; only server-side options (SSE, SSE-C on AWS S3) in the notes we read |
| Restore to a time in one command | yes (`--type=time --target=...`) | no: fetch backup, then write recovery settings by hand | no: restore, then write recovery settings by hand |
| Retention by days ("keep 14 days restorable") | yes (`repo1-retention-full-type=time`) | by count or date in a separate `delete` command | by policy in a separate delete command |
| One command that proves WAL reaches the bucket | yes (`check`) | partly (`wal-verify` checks what is stored) | no equivalent found |
| Read a versioned bucket as it was at a time | yes (`--repo-target-time`) | not found | not found |
| Differential and block-level incremental | yes | delta backups | full backups only, as documented for barman-cloud |

Why pgBackRest: it does every step of our runbook with one tool and
one config file, encrypts before upload, keeps a 14-day window by
itself, and has a `check` command we can alert on. For one person
running this at 2 a.m., fewer hand-written steps is the main safety
feature. WAL-G is the close second: a single binary with good S3 and
encryption support, but restore-to-time is more manual.

### What would make us switch (to WAL-G)

- No pgBackRest release for six months, or a security fix announced
  without a release.
- The sponsor group breaks up, or PGDG stops packaging it for our
  Debian release.
- The B2 checks in the test plan fail in a way pgBackRest cannot work
  around (for example, `expire` cannot run with a key that cannot
  delete, and no lifecycle setup fixes it).

The design below does not depend on the tool: WAL archiving, a weekly
base backup, a 14-day window, encryption and a no-delete key all carry
over.

## What is covered

- pgBackRest copies the **whole Postgres cluster**: the portal
  database, the Keycloak database, roles and passwords. Both databases
  come back together, at the same moment, so a user can sign in after
  a restore.
- **Not covered**: files in object storage, `infra/.env.prod`,
  `CREDENTIAL_ENCRYPTION_KEY`, TLS certificates. Those come from the
  sealed recovery bundle (`infra/recovery/`) and the password manager.
- The existing in-portal backups (`apps/portal-api/src/backup/`,
  `pg_dump` of the portal database plus MinIO objects) stay as they
  are. They are a second, slower, logical copy. Continuous backups do
  not replace them.

## Pieces

| File | What it does |
| --- | --- |
| `infra/postgres/Dockerfile` | installs pgBackRest (unused unless the overlay is on) |
| `infra/docker-compose.pitr.yml` | overlay: archive settings, config mount, env file |
| `infra/pitr/pgbackrest.conf` | settings with no secrets |
| `infra/pitr/pitr.env.example` | template for `infra/.env.pitr` (bucket, key, passphrase) |
| `infra/pitr-setup.sh` | first-time setup, first full backup, `check` |
| `infra/pitr-backup.sh` | one scheduled backup (full or diff) |
| `infra/pitr-status.sh` | health check and metrics file |
| `infra/pitr-restore.sh` | restore to latest or to a time |
| `infra/pitr-missing-objects.sh` | after a restore, keys the database needs that the bucket lacks |
| `infra/systemd/gg-pitr-*` | timers for backups, status and check |

Self-hosted installs: nothing changes unless `infra/.env.pitr` exists.
`deploy.sh` adds the overlay only then. The NAS compose file is not
covered.

## Archiving settings

Set by the overlay on the postgres command line:

- `wal_level=replica` (the default, set so nobody lowers it)
- `archive_mode=on`
- `archive_command=pgbackrest --stanza=gratisgis archive-push %p`
- `archive_timeout=60`: a WAL file is closed after at most 60 seconds
  when anything was written. Worst-case loss on a quiet system is
  about a minute plus upload time.
- All other flags from `docker-compose.prod.yml` are repeated,
  including `shared_preload_libraries=pg_partman_bgw,pg_stat_statements`.
  Compose replaces `command` instead of merging it, so
  `infra/test_prod_config.py` fails when the two drift.

pgBackRest settings (`infra/pitr/pgbackrest.conf`):

- Async archiving, 2 parallel uploads. A bulk import does not wait on
  one upload per WAL file.
- `archive-push-queue-max=8GiB`: if the bucket is unreachable long
  enough that 8 GB of WAL is waiting, pgBackRest drops WAL instead of
  letting the disk fill and the database stop. The restore chain is
  then broken until the next full backup. Alerts fire long before.
- zstd compression, bundling of small files, block incremental.

## Schedule

| What | When | How |
| --- | --- | --- |
| WAL | continuously, at least every 60 s when there are writes | `archive_command` |
| Full backup | Sunday 02:15 UTC | `gg-pitr-full.timer` |
| Differential | Monday to Saturday 02:15 UTC | `gg-pitr-diff.timer` |
| Status | every 5 minutes | `gg-pitr-status.timer` |
| `pgbackrest check` | hourly | `gg-pitr-check.timer` |
| Restore drill | monthly, on a throwaway server | test plan, part D (RB-18 step 7, cloud repo) |

## Retention

- `repo1-retention-full-type=time`, `repo1-retention-full=14`.
  pgBackRest keeps the full backups (and their WAL) needed to restore
  to any moment in the last 14 days. With weekly fulls that is two or
  three full sets at any time.
- Differential backups are kept with their full backup.
- Expiry runs after each successful backup.

**Differs from the runbook.** RB-18 says "2 full sets, 14 days of
WAL". With weekly fulls, keeping exactly 2 full sets gives a window
that shrinks to 7 days right after a new full. Retention by time
guarantees the 14 days D10 promises, at the cost of sometimes storing
a third full set. Owner to confirm.

## Encryption and where the key lives

- `repo1-cipher-type=aes-256-cbc`. Files are encrypted on the server
  before upload. B2 server-side encryption (SSE-B2) is also turned on
  for the bucket, as a second layer.
- The passphrase is 64 random letters and digits, made by
  `pitr-setup.sh --new-key`.
- It lives in two places only:
  1. `infra/.env.pitr` on the server (mode 600, git-ignored). The
     server needs it to write WAL.
  2. The owner's password manager, under "GratisGIS backup
     passphrase". This is the copy used after losing the server.
- It is never in the bucket, never in git, never in the sealed
  recovery bundle unless the owner adds it.
- Never change it while backups exist: old backups would be unreadable.

## Backblaze B2 bucket

Separate bucket for database backups (not the portal's file bucket),
in a US region, private.

- **Encryption:** default SSE-B2 on.
- **Versioning:** B2 keeps versions by default. Lifecycle rule:
  `daysFromHidingToDeleting = 14`, nothing else. A file that
  pgBackRest expires (or an attacker "deletes") is hidden, and stays
  recoverable for 14 more days.
- **Object lock:** enable it when creating the bucket. Default
  retention: governance mode, 14 days. A locked version cannot be
  deleted by anyone without the bypass capability, even with the
  master key, until the 14 days pass.
- **Application key for the server:** restricted to this bucket, with
  `listBuckets, listFiles, readFiles, writeFiles` only. Not
  `deleteFiles`, `writeBuckets`, `writeBucketRetentions`,
  `writeFileRetentions`, `writeFileLegalHolds` or
  `bypassGovernance`. Per Backblaze's
  [capability mapping](https://www.backblaze.com/docs/cloud-storage-map-iam-policies-and-s3-acls-to-backblaze-b2-access-controls),
  deleting by name (no version id) needs only `writeFiles` and creates
  a hide marker; deleting a specific version needs `deleteFiles`. So
  this key can hide but never destroy.
- **Key for drills:** a second key with `listBuckets, listFiles,
  readFiles` only. A drill server cannot write into the real
  repository even by mistake.
- **Master key:** only in the password manager. Needed to undo hide
  markers after an attack, and to change bucket settings.

Example with the `b2` command-line tool (check flag names against
`b2 bucket create --help` for the installed version):

```sh
b2 bucket create --file-lock-enabled \
  --default-server-side-encryption SSE-B2 \
  --lifecycle-rule '{"fileNamePrefix":"","daysFromHidingToDeleting":14,"daysFromUploadingToHiding":null}' \
  <bucket> allPrivate
b2 bucket update --default-retention-mode governance \
  --default-retention-period 14d <bucket>
b2 key create --bucket <bucket> gg-pgbackrest-server \
  listBuckets,listFiles,readFiles,writeFiles
b2 key create --bucket <bucket> gg-pgbackrest-drill \
  listBuckets,listFiles,readFiles
```

**To verify on staging before relying on it** (test plan, part C):
`pgbackrest expire` and `stanza-create` work with the no-delete key on
a bucket with object lock; hiding a locked file is allowed.

### Portal files bucket (not this tool)

D12 puts the portal's files on B2 as well. That bucket needs its own
lifecycle rule `daysFromHidingToDeleting = 14` so files deleted after
a restore target can be brought back. This is configured when the
file bucket moves to B2; it is listed here because the restore
runbook depends on it.

## Object storage is not rolled back

A database restore to time T does not touch the file bucket.

- Files uploaded after T: the restored database does not refer to
  them. They are orphans. Harmless; the housekeeping orphan report
  lists them (RB-07 reconcile job).
- Files deleted after T: the restored database still refers to them,
  but the bucket no longer shows them. With versioning, they are
  hidden, not gone, for 14 days.
  `infra/pitr-missing-objects.sh` lists them; the runbook shows how to
  un-hide them.
- Thumbnails, avatars and hero images are referenced as loose URLs and
  are not in the missing-objects list. A broken image after a restore
  is the sign.

## Monitoring

`infra/pitr-status.sh` prints a summary and exits 1 on any ALERT.
With `--textfile` it writes Prometheus text-format metrics to
`/var/lib/gratis-gis/pitr/` (RB-24 reads them).

| Signal | Alert when | Metric |
| --- | --- | --- |
| WAL waiting to be archived | oldest waiting file over 10 minutes | `gg_pitr_wal_ready_files`, `gg_pitr_wal_ready_oldest_seconds` |
| Archive failing | last failure newer than last success | `gg_pitr_last_archive_failed_timestamp_seconds`, `gg_pitr_last_archived_timestamp_seconds` |
| Archiving turned off | `archive_mode` not on (stack started without the overlay) | `gg_pitr_archive_mode_on` |
| Full backup age | over 8 days 6 hours | `gg_pitr_last_backup_timestamp_seconds{type="full"}` |
| Any backup age | over 30 hours | `gg_pitr_last_backup_timestamp_seconds{type="any"}` |
| Backup run failed | the timer run exited non-zero | `gg_pitr_backup_last_ok{type=...}` |
| Backup recorded errors | pgBackRest marked the last backup with errors | `gg_pitr_last_backup_error` |
| Repository size jump | newest full more than twice the previous and 1 GiB bigger | `gg_pitr_full_backup_repo_bytes` |
| `check` fails | hourly check exits non-zero | `gg_pitr_check_ok` |
| Database disk | under 10 GiB free | `gg_pitr_pgdata_free_bytes` |
| Status itself stale | file timestamp older than 15 minutes | `gg_pitr_status_timestamp_seconds` |

The WAL signal counts files in `pg_wal/archive_status/*.ready`, not
the time since the last archive. A quiet database with nothing to send
does not alert.

### Emergency: archive stuck and disk filling

1. `infra/pitr-status.sh` and `docker logs gratis-gis-prod-postgres
   --tail 100` show why (bad key, B2 outage, full bucket quota).
2. Fix the cause if quick (key, network).
3. If the disk will fill first: pgBackRest drops WAL at 8 GiB waiting
   by itself. To act sooner, lower `archive-push-queue-max` in
   `infra/pitr/pgbackrest.conf` (no restart needed; it is read on each
   push).
4. Never delete files from `pg_wal` by hand.
5. Once archiving works again, take a full backup at once:
   `infra/pitr-backup.sh full`. The window restarts from it.

## Costs (rough)

Storage is two or three compressed full copies plus 14 days of
compressed WAL. At B2's $6.95 per TB a month (D12), a database under
50 GB costs well under a dollar a month. WAL from `archive_timeout` on
an idle system is mostly empty and compresses to almost nothing.

## Known limits

- One repository. A second in another region is optional later.
- Restore time is unknown until the first drill. The 2-hour target in
  D10 is a guess until then.
- After a restore to a time, Postgres starts a new timeline. A standby
  (RB-19, not in stage 1) would have to be rebuilt.
- The portal's database role is the cluster superuser, so anything
  that can run SQL as it can also read the bucket key and passphrase
  from the server's environment. The no-delete key and object lock
  limit what a stolen key can do.
