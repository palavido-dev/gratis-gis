# Continuous backup test plan

Status: draft (RB-18 stage 1). Parts B to E have **not been run yet**.
Run them in order before turning this on for any client. Record
results and times at the bottom.

Design: [backup-design.md](backup-design.md). Restore steps:
[restore-runbook.md](restore-runbook.md).

## A. Already checked without Docker (2026-11-24)

The sandbox where this was written had no working Docker daemon, so
only these ran:

- `bash infra/pitr/lib-pitr.test.sh`: version check, target time
  rules, env file rules, alert rules, metrics lines, missing-key
  diff. All passed.
- `python3 -m unittest infra/test_prod_config.py`: the overlay repeats
  every base postgres flag and adds the archive flags; the base file
  has no archiving; secrets are not in the templates; `.env.pitr` is
  git-ignored; deploy.sh adds the overlay. All passed. Also checked
  that dropping one flag from the overlay makes it fail.
- `docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.pitr.yml config`
  renders, with the archive flags, the env file and the config mount.
  Without the overlay, no archive setting appears.
- `shellcheck -x` on every new script: clean.
- `systemd-analyze verify` and `systemd-analyze calendar` on the new
  units: only "file not found" for `/opt/gratis-gis` paths.

Not checked: the image build, any pgBackRest command, any restore,
and `.github/workflows/postgres-image.yml` (it runs on GitHub when a
pull request touches `infra/postgres/**`; only its YAML was parsed).

## B. Local proof with MinIO (any Docker host)

Needs Docker, about 2 GB of disk, and a checkout of this branch. Uses
only the postgres service of the prod compose file and a throwaway
MinIO. Nothing here touches B2 or a real server.

```sh
cd gratis-gis               # this branch
export C="docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.pitr.yml --env-file /tmp/pitr-proof/env.prod"
mkdir -p /tmp/pitr-proof/certs

# 1. Dummy prod env with only what compose requires.
grep -oE '\$\{[A-Z0-9_]+:\?' infra/docker-compose.prod.yml | sort -u \
  | sed -E 's/\$\{([A-Z0-9_]+):\?/\1=proof-only-value/' > /tmp/pitr-proof/env.prod

# 2. Build the image and check pgBackRest is in it.
$C build postgres
docker run --rm -u postgres gratis-gis-postgres:prod pgbackrest version   # 2.59.3 or newer

# 3. MinIO with TLS (pgBackRest's S3 driver connects over HTTPS).
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=pitr-minio \
  -addext subjectAltName=DNS:pitr-minio \
  -keyout /tmp/pitr-proof/certs/private.key -out /tmp/pitr-proof/certs/public.crt
docker network create gratis-gis-prod_gratis-net 2>/dev/null || true
docker run -d --name pitr-minio --network gratis-gis-prod_gratis-net \
  -e MINIO_ROOT_USER=proofadmin -e MINIO_ROOT_PASSWORD=proof-password-123 \
  -v /tmp/pitr-proof/certs:/root/.minio/certs:ro \
  minio/minio server /data
docker run --rm --network gratis-gis-prod_gratis-net --entrypoint sh minio/mc -c \
  'mc --insecure alias set p https://pitr-minio:9000 proofadmin proof-password-123 && mc --insecure mb p/pitr-proof'

# 4. .env.pitr pointing at MinIO. VERIFY_TLS=n is for this proof only.
cat > infra/.env.pitr <<'EOF'
PGBACKREST_REPO1_S3_ENDPOINT=pitr-minio:9000
PGBACKREST_REPO1_S3_REGION=us-east-1
PGBACKREST_REPO1_S3_BUCKET=pitr-proof
PGBACKREST_REPO1_S3_KEY=proofadmin
PGBACKREST_REPO1_S3_KEY_SECRET=proof-password-123
PGBACKREST_REPO1_STORAGE_VERIFY_TLS=n
PGBACKREST_REPO1_CIPHER_PASS=CHANGE_ME
EOF
chmod 600 infra/.env.pitr

# 5. Setup: new key, restart postgres with archiving, stanza, check, full backup.
PITR_PROD_ENV=/tmp/pitr-proof/env.prod \
  infra/pitr-setup.sh --confirm-project gratis-gis-prod --new-key   # type SAVED
PITR_PROD_ENV=/tmp/pitr-proof/env.prod infra/pitr-status.sh         # expect OK
```

Pass: setup ends with `info` showing one full backup; status prints OK.

### B1. Restore to a time returns exactly the rows before it

```sh
P() { docker exec -u postgres gratis-gis-prod-postgres psql -X -At -U gratisgis -d gratisgis -c "$1"; }
P "CREATE TABLE pitr_mark (id int PRIMARY KEY, at timestamptz DEFAULT clock_timestamp())"
for i in $(seq 1 50); do P "INSERT INTO pitr_mark (id) VALUES ($i)"; done
sleep 2
T="$(P "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')")+00"
sleep 2
for i in $(seq 51 100); do P "INSERT INTO pitr_mark (id) VALUES ($i)"; done
sleep 70                                   # archive_timeout plus upload
PITR_PROD_ENV=/tmp/pitr-proof/env.prod infra/pitr-status.sh   # WAL waiting: 0

PITR_PROD_ENV=/tmp/pitr-proof/env.prod \
  infra/pitr-restore.sh --confirm-project gratis-gis-prod --time "$T"   # type RESTORE <T>
P "SELECT pg_get_wal_replay_pause_state()"                              # expect paused
P "SELECT count(*), max(id) FROM pitr_mark"                             # expect 50|50
P "SELECT pg_wal_replay_resume()"
sleep 5; P "SELECT pg_is_in_recovery()"                                 # expect f
P "INSERT INTO pitr_mark (id) VALUES (51)"                              # writes work again
```

Pass: paused at the target, exactly `50|50` while paused, and writable
after resume. Any row 51 or above before the insert is a failure.

### B2. Losing the volume and the server process loses under 5 minutes

```sh
P "CREATE TABLE IF NOT EXISTS pitr_loss (id serial PRIMARY KEY, at timestamptz DEFAULT clock_timestamp())"
for i in $(seq 1 240); do P "INSERT INTO pitr_loss DEFAULT VALUES" >/dev/null; sleep 1; done
LAST_WRITE="$(date -u +%s)"
docker kill -s KILL gratis-gis-prod-postgres
$C rm -f postgres
docker volume rm gratis-gis-prod_pgdata          # the "lost disk"
PITR_PROD_ENV=/tmp/pitr-proof/env.prod infra/pitr-restore.sh \
  --confirm-project gratis-gis-prod --latest --new-server   # type RESTORE LATEST
P "SELECT extract(epoch FROM max(at))::bigint FROM pitr_loss"
```

Pass: `LAST_WRITE` minus that value is under 300 seconds. Record it.
(Expected: up to about 60 seconds, from `archive_timeout`.)

### B3. Stalled archiving alerts

```sh
docker stop pitr-minio
P "SELECT pg_switch_wal()"; P "INSERT INTO pitr_loss DEFAULT VALUES"; P "SELECT pg_switch_wal()"
sleep 660
PITR_PROD_ENV=/tmp/pitr-proof/env.prod infra/pitr-status.sh; echo "exit=$?"
docker start pitr-minio
```

Pass: an `ALERT ... WAL file(s) waiting` line and `exit=1`. After
MinIO is back, status returns to OK within a few minutes.

### B4. Repository is encrypted

```sh
docker run --rm --network gratis-gis-prod_gratis-net --entrypoint sh minio/mc -c \
  'mc --insecure alias set p https://pitr-minio:9000 proofadmin proof-password-123 >/dev/null &&
   mc --insecure find p/pitr-proof --name "*.zst" | head -n 1 | xargs -I{} mc --insecure cat {} | head -c 8 | od -c'
```

Pass: the first 8 bytes are `Salted__` (OpenSSL-style encrypted
file), not a zstd header. Also `grep -r` for the passphrase in a copy
of the bucket finds nothing.

### Clean up

```sh
$C down -v
docker rm -f pitr-minio
docker network rm gratis-gis-prod_gratis-net
rm -f infra/.env.pitr; rm -rf /tmp/pitr-proof
```

## C. Staging server with a real B2 bucket

An hourly server (D12), a **test bucket** with the production bucket
settings from the design (object lock, lifecycle, SSE-B2), and the two
restricted keys. Full stack, so Keycloak sign-in can be tested.

1. Deploy the branch, then `infra/pitr-setup.sh --confirm-project
   gratis-gis-prod --new-key`. Install the timers. Pass: status OK.
2. **The server key cannot destroy.** From a laptop, with the server
   key:
   ```sh
   aws s3api list-object-versions --bucket <test-bucket> --endpoint-url https://<endpoint> --max-items 1
   aws s3api delete-object --bucket <test-bucket> --endpoint-url https://<endpoint> \
     --key <that key> --version-id <that version id>
   ```
   Pass: the delete is refused (access denied).
3. **Expiry works with that key and object lock on.** Run three full
   backups, then force expiry on staging only:
   ```sh
   docker exec -u postgres gratis-gis-prod-postgres pgbackrest --stanza=gratisgis \
     --repo1-retention-full-type=count --repo1-retention-full=1 expire
   docker exec -u postgres gratis-gis-prod-postgres pgbackrest --stanza=gratisgis info
   ```
   Pass: expire exits 0 and `info` shows one full backup; the expired
   files are hidden (visible in `list-object-versions` with a delete
   marker), not gone. If expire fails, the bucket design needs
   changing before going further.
4. **Both databases come back.** Create a test user in Keycloak and an
   item in the portal; note time T; delete both; restore to T with
   `infra/pitr-restore.sh --time`; follow "Inspect before opening" in
   the runbook, resume, then start the stack. Pass: the user can sign
   in and sees the item.
5. **Missing objects.** Upload an attachment before T, delete it after
   T, restore to T, run the "Missing objects" steps of the runbook.
   Pass: the script lists the key, un-hiding it makes the attachment
   open again, the script then lists nothing.
6. **Abrupt loss.** Write continuously, `docker kill -s KILL` postgres,
   delete the volume, restore `--latest`. Pass: under 5 minutes of
   writes lost. Record the number.
7. **Restore onto a new server** (runbook part C) on a second hourly
   server, with the drill key. Record the wall-clock time from "server
   created" to "user signed in".
8. **Self-host unaffected.** On a server without `infra/.env.pitr`, run
   `infra/deploy.sh`, then
   `docker inspect gratis-gis-prod-postgres --format '{{json .Config.Cmd}}'`.
   Pass: no `archive_mode` in the command.
9. Delete the test bucket's contents with the master key when done.

## D. Monthly drill (throwaway server)

RB-18 step 7 schedules this from the cloud repo. Manual version:

1. Create an hourly server at the same provider, same image release.
2. `infra/.env.pitr` with the **drill key** (read-only) and the
   passphrase.
3. Build images (runbook part C, step 5).
4. `infra/pitr-restore.sh --confirm-project gratis-gis-prod --drill --time "<now minus 1 hour, UTC>+00"`.
   `--drill` turns archiving off on the restored server and skips the
   typed confirmation. The database stays paused (read-only) at the
   target, which is all the checks below need.
5. Checks: migrations count matches production; row counts of
   `organization`, `item`, `feature_attachment` within a few percent
   of production; `SELECT postgis_full_version()` works; newest
   `item.updated_at` within a few minutes before the target.
6. Record: date, target, restore duration printed by the script,
   pass or fail.
7. Delete the server.

A drill that has not passed in 35 days is an alert (RB-24).

## E. Results

| Date | Part | Result | Restore time | Data lost | Who |
| --- | --- | --- | --- | --- | --- |
| | | | | | |
