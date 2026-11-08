# Host recovery

Opt-in. Nothing here runs from the portal scheduler.

The bundle is not the in-portal archive. That archive stays a version-1
`tar.gz` of a portal `pg_dump` and MinIO objects. This bundle is an
encrypted tar with three components: the portal database, the Keycloak
database, and the MinIO bucket. The recovery passphrase and
`CREDENTIAL_ENCRYPTION_KEY` are not in it. Restore refuses to start
unless the credential key file hashes to the fingerprint recorded at
capture.

Name the compose project in `GRATIS_RECOVERY_PROJECT` and pass the same
name to `--confirm-project`. `gratis-gis`, `gratis-gis-prod`, `default`,
and `compose` are refused. The scripts never list other compose
projects.

```bash
export GRATIS_RECOVERY_PROJECT=my-stack
export MINIO_ENDPOINT=http://127.0.0.1:9000
export MINIO_ACCESS_KEY=...
export MINIO_SECRET_KEY=...
infra/recovery/capture.sh \
  --confirm-project my-stack \
  --compose-file infra/docker-compose.prod.yml \
  --recovery-key-file /secure/recovery.key \
  --credential-key-file /secure/credential.key \
  --out /secure/recovery \
  --status-file /secure/recovery/status.json
```

Keep `recovery.key` and `credential.key` outside the bundle directory.
Both files are read from disk. They are not printed and they are not
passed as argument values.

`offhost.sh --dest file:/path` copies the sealed file once, checks the
sha256, and clears write permission. A destination that already has
the file fails. A checksum mismatch deletes the copy and fails. This
is a verified secondary file copy. When the destination is on the
same disk, the status says so and does not call the copy off-site or
immutable. Clearing the write bit is not object-lock storage.

Point `GRATIS_RECOVERY_STATUS_FILE` at `status.json` on the API process
to show the failure sentence on the backup page. The status file has
no secrets. `announceRecoveryFailure` sends one mail through the
existing transport; it is not called on a health poll.

What a successful restore brings back: Keycloak users and clients, the
portal database as dumped, and the bucket's objects. The bundle is
sealed with AES-256-GCM. A changed byte does not decrypt.

What is not in the bundle, and must be kept as its own files:
the recovery passphrase, `CREDENTIAL_ENCRYPTION_KEY`,
`POSTGRES_PASSWORD`, `KEYCLOAK_DB_PASSWORD`, the MinIO root
credentials, `KEYCLOAK_CLIENT_SECRET_WEB`,
`KEYCLOAK_ADMIN_CLIENT_SECRET`, and `NEXTAUTH_SECRET`. Role passwords
are cluster-wide and a database dump does not contain them. Capture
writes those names, not the values, to `required-separately.json`
beside the bundle. Without the passphrase the bundle does not open.
Without the credential key, restored credentials do not decrypt.
Without the env file that matches the cluster, the stack does not boot.

Writers that are defined and running are paused. A stopped service is
left stopped. A bucket policy that denies puts is written for the capture and
removed afterwards, including when a later step fails. On MinIO
RELEASE.2024-10-02T17-50-41Z that policy does not stop a user who
already has an IAM Allow, and it does not stop the root user. The
quiesce this image actually enforces is pausing writer containers
that are running. A stopped service is not started. A running writer
that will not pause fails the capture. Continuous WAL archiving is a
follow-on, not this bundle.

`drill.sh` is a fixture. It does not boot the portal. `drill-portal.sh`
migrates the real schema and checks the portal API.

`compose.drill.yml` and `drill.sh` are the throwaway proof. They refuse
every project name except `gg-recovery-drill`.
