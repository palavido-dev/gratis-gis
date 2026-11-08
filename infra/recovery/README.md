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
Both files are read by OpenSSL and by the fingerprint check. They are
not printed.

`offhost.sh --dest file:/path` copies the sealed file once, checks the
sha256, and clears write permission. That is a verified off-host copy
on a directory the operator already has. It is not object-lock storage.
A destination that already has the file fails. A checksum mismatch
deletes the copy and fails.

Point `GRATIS_RECOVERY_STATUS_FILE` at `status.json` on the API process
to show the failure sentence on the backup page. The status file has
no secrets. `announceRecoveryFailure` sends one mail through the
existing transport; it is not called on a health poll.

What a successful restore brings back: Keycloak users and clients, the
portal database as dumped, and the bucket's objects. What it does not
bring back: the credential key, the recovery key, or any write that
happened after the dump. Writers that are defined and running are
paused for the dump. A writer that will not pause fails the capture.
Continuous WAL archiving is a follow-on, not this bundle.

`compose.drill.yml` and `drill.sh` are the throwaway proof. They refuse
every project name except `gg-recovery-drill`.
