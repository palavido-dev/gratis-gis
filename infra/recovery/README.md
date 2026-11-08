# Host recovery

Opt-in. Nothing here runs from the portal scheduler, and an install
that never runs these scripts is unchanged.

The bundle is not the in-portal archive. That archive stays a version-1
`tar.gz` of a portal `pg_dump` and MinIO objects. This bundle is an
encrypted tar with three components: the portal database, the Keycloak
database, and the MinIO data directory. The recovery passphrase and
`CREDENTIAL_ENCRYPTION_KEY` are not in it. Restore refuses to start
unless the credential key file hashes to the fingerprint recorded at
capture.

## Project name

Name the compose project in `GRATIS_RECOVERY_PROJECT` and pass the same
name to `--confirm-project`. The real names are accepted:
`gratis-gis-prod` for `infra/docker-compose.prod.yml` and `gratis-gis`
for `infra/docker-compose.nas.yml`. `default`, `compose`, and `docker`
are refused. Before anything changes, each script checks that the
compose file defines `postgres`, `keycloak`, and `minio` (and
`portal-api`, unless `GRATIS_RECOVERY_EXTERNAL_API=stopped`), and that
the named project already has those containers with Postgres running.
A wrong name finds no containers and stops there. The scripts never
list other compose projects.

## Capture

```bash
export GRATIS_RECOVERY_PROJECT=gratis-gis-prod
infra/recovery/capture.sh \
  --confirm-project gratis-gis-prod \
  --compose-file infra/docker-compose.prod.yml \
  --recovery-key-file /secure/recovery.key \
  --credential-key-file /secure/credential.key \
  --secrets-key-file /secure/secrets.key \
  --secret-file env=/opt/gratis-gis/infra/.env \
  --out /secure/recovery \
  --status-file /secure/recovery/status.json
```

Each run writes new files named by UTC time and never replaces or
deletes an earlier one:

- `bundle-<YYYYMMDDTHHMMSSZ>.tar.enc` and its `.sha256`
- `secrets-<YYYYMMDDTHHMMSSZ>.tar.enc`
- `latest.tar.enc` and `latest-secrets.tar.enc`, symlinks to the newest

Sealed files are written under a temporary name in `--out` and then
published with a hard link, which fails rather than replace a name. A
failed capture removes only its own temporary files. Old bundles are
yours to prune.

The plaintext tar is built in a staging directory created with
`mktemp -d` under `TMPDIR` (default `/tmp`) and set to 0700. It is
removed on every exit, including an unexpected error. Staging needs
about twice the size of the MinIO data directory; set `TMPDIR` to a
disk with room. `--out` is set to 0700.

Keep `recovery.key`, `secrets.key`, and `credential.key` outside the
bundle directory. All three are read from files. They are not printed,
not passed as argument values, and not put in the environment of a
child process.

Capture stops running writers before it snapshots: `portal-api`,
`portal-web`, `portal-worker`, `pointcloud-worker`, `script-runner`,
`script-executor`, `keycloak`, and `minio`. A bucket Deny does not
stop the root user or an IAM Allow on MinIO
RELEASE.2024-10-02T17-50-41Z, so the process is stopped and the data
directory is copied with no published ports and no network. A service
that was already stopped stays stopped. Only the containers this run
stopped are started again, including when a later step fails. A
maintenance file passed with `--maintenance-file` is created after the
project checks pass, when it does not already exist, and capture
removes it on failure because capture does not change the databases.
Continuous WAL archiving is a follow-on, not this bundle.

## Encryption

`seal.mjs` writes format `GRCV2`: a header with the scrypt parameters
(N = 2^17, r = 8, p = 1), a random 16-byte salt, and a random 12-byte
IV, followed by 1 MiB records, each sealed with AES-256-GCM and its own
tag. The whole header is authenticated with every record, and each
record's nonce and associated data carry its index and whether it is
the last one, so a changed, reordered, or truncated record fails.
Encryption and decryption stream, so bundle size is limited by disk,
not memory. Decryption writes plaintext only inside a fresh 0700
directory beside the output and moves it into place after every record
has verified; on any failure that directory is deleted.

## Restore

```bash
export GRATIS_RECOVERY_PROJECT=gratis-gis-prod
infra/recovery/restore.sh \
  --confirm-project gratis-gis-prod \
  --compose-file infra/docker-compose.prod.yml \
  --recovery-key-file /secure/recovery.key \
  --credential-key-file /secure/credential.key \
  --bundle /secure/recovery/latest.tar.enc \
  --maintenance-file /path/the/api/reads/maintenance.json \
  --status-file /secure/recovery/status.json
```

In order:

1. Check the project as above.
2. Decrypt into a 0700 staging directory under `TMPDIR`, extract with
   `safe_untar.py` (no traversal, links, or devices), and check every
   component's sha256 and the credential key fingerprint. Staging
   needs about three times the bundle size.
3. Version check. The manifest records each image the compose file
   resolved to (name and image id) and the latest applied Prisma
   migration. Restore compares both with the running stack and
   refuses a difference. Bring the stack to the bundle's version
   first, or pass `--allow-version-mismatch` if you have checked that
   the code can read the older data. On a rebuilt host, start the
   stack once so `portal-migrate` runs before you restore.
4. Check the MinIO volume and the object archive.
5. Only now: write the maintenance file and stop the same writers
   capture stops.
6. Safety bundle. Run `capture.sh --data-only` against the current
   state, sealed with the same recovery passphrase and credential key
   fingerprint, into `--safety-out` (default: a `pre-restore`
   directory beside the bundle). If it fails, nothing is restored.
   Its path is printed. Prune these yourself.
7. Restore Keycloak, then the portal database. Each runs as
   `pg_restore --clean --if-exists --exit-on-error --single-transaction`
   and must exit 0, so a failed database is rolled back, not half
   written.
8. Replace the MinIO data directory.
9. Start the containers this run stopped and remove the maintenance
   file.

A failure in steps 1 to 6 starts the stopped writers again and removes
the maintenance file. A failure in steps 7 or 8 is a partial restore:
the status file says `partial`, writers stay stopped, the maintenance
file stays so the API keeps returning 503, and the safety bundle path
is printed. To roll back, restore that safety bundle with the same
command (it carries the version of the stack it was taken from).

## Other tools

`unseal-secrets.sh --secrets-key-file /secure/secrets.key --sealed
/secure/recovery/latest-secrets.tar.enc --out /secure/unsealed` opens
the sealed secret files.

`offhost.sh --dest file:/path` copies the sealed file once (following
`latest.tar.enc` to the timestamped file), checks the sha256, and
clears write permission. A destination that already has the file
fails. A checksum mismatch deletes the copy and fails. This is a
verified secondary file copy. When the destination is on the same
disk, the status says so and does not call the copy off-site or
immutable. Clearing the write bit is not object-lock storage.

Point `GRATIS_RECOVERY_STATUS_FILE` at `status.json` on the API process
to show the failure sentence on the backup page. The status file has
no secrets. `announceRecoveryFailure` sends one mail through the
existing transport; it is not called on a health poll.

What is not in the data bundle: the recovery passphrase, and the
secret files you pass with `--secret-file`. Those files are sealed
separately with `--secrets-key-file`, a different file from the
recovery passphrase that is not inside either archive. Losing the
secrets key loses those files. Losing the recovery passphrase loses
the databases and objects. Role passwords are cluster-wide and a
database dump does not contain them.

## Tests

`recovery.test.sh` needs no stack. A fake `docker` answers the
read-only compose queries, so it checks the project, version, and
bundle refusals, maintenance cleanup, and a 50 MB streaming seal with
a tampered byte that leaves no plaintext.

`drill.sh` is a fixture. It does not boot the portal. `drill-portal.sh`
migrates the real schema and checks the portal API.
`compose.drill.yml` and `drill.sh` are the throwaway proof. They refuse
every project name except `gg-recovery-drill`.
