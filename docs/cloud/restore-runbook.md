# Restore runbook: database point-in-time recovery

Status: draft for review (RB-18 stage 1). Not yet proven on a real
server; see [pitr-test-plan.md](pitr-test-plan.md). Design:
[backup-design.md](backup-design.md).

All commands run on the server, as root, from `/opt/gratis-gis`.
Times are UTC. Each restore brings back the **whole cluster**: the
portal database and the Keycloak database together.

## Before you start

- [ ] Decide what you need:
  - **Latest**: the server or the data volume is lost or broken, the
    data itself was fine. Go to A (same server) or C (new server).
  - **A time**: something wrote bad data or deleted data (bad
    import, wrong delete, bug). Go to B.
- [ ] For a time: pick the last good minute. Look at the portal's audit
  log and `docker logs` for when the bad change started. Pick a time a
  minute or two before it. Write it as `2026-11-24 14:05:00+00`.
- [ ] Have from the password manager: the **backup passphrase**
  ("GratisGIS backup passphrase"). For C, also the sealed recovery
  bundle key and `infra/.env.prod` (see `infra/recovery/README.md`).
- [ ] Tell the client(s) the portal is going down for a restore and
  roughly how long (use the last drill's measured time).
- [ ] Image must match: Postgres 17, `postgis/postgis:17-3.6`, built
  from `infra/postgres/Dockerfile` at the same release as the backup,
  with pgBackRest 2.59.3 or newer. A different Postgres major version
  cannot read the backup.

## A. Restore to latest, same server

Use when the data volume is damaged and the server is otherwise fine.

```sh
cd /opt/gratis-gis
infra/pitr-status.sh            # note the last archived WAL
infra/pitr-restore.sh --confirm-project gratis-gis-prod --latest
```

If the running database is already gone, the script cannot send its
last WAL and stops. Add `--accept-unarchived`: whatever was not
archived is lost anyway.

Then follow "After every restore" below.

## B. Restore to a time, same server

```sh
cd /opt/gratis-gis
infra/pitr-restore.sh --confirm-project gratis-gis-prod \
  --time '2026-11-24 14:05:00+00'
```

What the script does:

1. Refuses a time without a zone, in the future, or more than 14
   days back.
2. Prints a warning box and waits for you to type
   `RESTORE 2026-11-24 14:05:00+00` exactly.
3. Switches to a new WAL file and waits until every WAL file has
   reached the bucket, so the writes after your target time are kept
   in the repository (needed to undo, below).
4. Stops the whole stack (`docker compose stop`).
5. Runs `pgbackrest --delta --type=time --target=... --target-action=promote restore`
   in a one-off container on the same data volume.
6. Starts postgres alone and waits for WAL replay to finish (up to 4
   hours, progress every minute).
7. Prints quick checks (timeline, migrations, newest change, PostGIS,
   Keycloak users).

To look before opening the database for writes, add `--pause`.
Postgres stops at the target in read-only mode. Check the data with
`docker exec -it gratis-gis-prod-postgres psql -U gratisgis gratisgis`,
then either:

- accept: `SELECT pg_wal_replay_resume();`
- or pick another time: run the script again with a different
  `--time`.

### Undo a restore to a time

The writes after the target are still in the repository on the old
timeline for 14 days. To go back to how things were just before the
restore, restore from a backup taken **before** the target and follow
the old timeline to its end:

```sh
docker exec -u postgres gratis-gis-prod-postgres pgbackrest --stanza=gratisgis info
# pick the label of the newest backup older than the target, e.g. 20261122-021500F
docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.pitr.yml \
  --env-file infra/.env.prod stop
docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.pitr.yml \
  --env-file infra/.env.prod run --rm --no-deps -T -u postgres \
  --entrypoint pgbackrest postgres --stanza=gratisgis --delta \
  --set=20261122-021500F --target-timeline=1 restore
```

(`--target-timeline` is the timeline number the database was on before
the restore; the restore script prints the new one.) Then start
postgres and follow "After every restore".

## C. Restore onto a new server

Use when the server is lost. D12: expect hours, not minutes.

1. **Make sure the old server cannot write.** If it might still be
   running, power it off at the provider. Two servers archiving into
   one repository corrupt the WAL history. If you cannot reach it,
   delete its B2 application key in the B2 console and make a new key
   for the new server.
2. Create the server and install Docker (`infra/install.sh --check`
   lists what is missing). Clone the repository at the **same
   release** to `/opt/gratis-gis`.
3. Put back the secrets: `infra/.env.prod` and the credential key
   from the sealed recovery bundle (`infra/recovery/README.md`).
4. Create `infra/.env.pitr` from `infra/pitr/pitr.env.example`:
   bucket, endpoint, region, the server key (or the new key from step
   1), and the backup passphrase from the password manager.
   `chmod 600 infra/.env.pitr`.
5. Build the images without starting anything:
   ```sh
   docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.pitr.yml \
     --env-file infra/.env.prod build
   ```
   Do **not** run `deploy.sh` yet: it would start a new empty database.
6. Restore:
   ```sh
   infra/pitr-restore.sh --confirm-project gratis-gis-prod --latest --new-server
   ```
7. Point DNS at the new server (Caddy gets certificates on start).
8. Follow "After every restore".

## After every restore

1. **Read the quick checks** the script printed:
   - timeline went up by one (for a time restore);
   - migrations applied matches the release you expect;
   - newest item change is just before your target (time restore) or
     a few minutes before the loss (latest);
   - PostGIS answers;
   - Keycloak users is not 0.
2. **More checks**:
   ```sh
   docker exec -it gratis-gis-prod-postgres psql -U gratisgis gratisgis
   ```
   ```sql
   SELECT count(*) FROM "organization";
   SELECT count(*) FROM "item";
   SELECT ST_AsText(ST_Buffer(ST_MakePoint(0,0), 1));   -- PostGIS works
   SELECT name FROM pg_available_extensions WHERE installed_version IS NOT NULL;
   SHOW shared_preload_libraries;      -- must list pg_partman_bgw
   SHOW archive_mode;                  -- on (except on a drill server)
   ```
3. **Pause destructive housekeeping.** If an admin housekeeping
   schedule includes the orphaned-uploads purge, pause it for 14 days.
   Files uploaded after the target look like orphans now, and you may
   want them back.
4. **Start the stack**: `infra/deploy.sh` (it keeps the overlay because
   `infra/.env.pitr` exists).
5. **Sign in** as a normal user and as an admin. Open a map with
   layers. Open an item with attachments.
6. **Replay deleted-organization tombstones.**
   > **PLACEHOLDER (RB-21).** Organizations deleted after the restore
   > target come back with the database. RB-21 adds a script that
   > re-applies those deletions from the tombstone log kept outside
   > the database. Until RB-21 lands: check the operator's list of
   > organizations deleted in the last 14 days and delete any that
   > reappeared, before telling anyone the portal is back. Do not
   > skip this: a customer who left must not reappear.
7. **Missing objects** (below).
8. **New full backup**, so the next restore does not have to replay
   across the timeline switch:
   ```sh
   infra/pitr-backup.sh full
   infra/pitr-status.sh
   ```
9. **Tell people**: the client(s) in writing, with the restore time
   and what was lost (writes after the target, or after the last
   archived WAL). Update the status page.
10. **Record** the measured restore time in the drill log. It is the
    real recovery time.

## Missing objects

Files deleted after the restore target are hidden in the bucket, not
gone, for 14 days (bucket lifecycle `daysFromHidingToDeleting=14`).

1. List every key in the portal's file bucket, one per line. Either:
   ```sh
   # aws CLI (any S3-compatible endpoint)
   aws s3api list-objects-v2 --bucket <files-bucket> \
     --endpoint-url https://<s3-endpoint> --query 'Contents[].Key' \
     --output text | tr '\t' '\n' > /root/bucket-keys.txt
   # or rclone, with a remote named files
   rclone lsf -R --files-only files:<files-bucket> > /root/bucket-keys.txt
   ```
   For the local MinIO of a self-hosted stack, use the same commands
   against `http://localhost:9000` (or the MinIO port in your setup).
2. Compare with what the restored database refers to:
   ```sh
   infra/pitr-missing-objects.sh --bucket-list /root/bucket-keys.txt \
     --out /root/missing-keys.txt
   ```
3. For each missing key, find the hide marker and remove it. This
   needs a key with `deleteFiles` (the master key from the password
   manager; do not leave it on the server):
   ```sh
   aws s3api list-object-versions --bucket <files-bucket> \
     --endpoint-url https://<s3-endpoint> --prefix '<key>'
   # The entry under DeleteMarkers with IsLatest=true is the hide marker.
   aws s3api delete-object --bucket <files-bucket> \
     --endpoint-url https://<s3-endpoint> --key '<key>' --version-id '<marker version id>'
   ```
   The file is visible again. Run step 2 again: the list should be
   empty.
4. Keys still missing after 14 days are gone. List them for the client.

## Stale postmaster.pid

After a crash, the restore script stops with "postmaster.pid is still
in the data volume". First make sure no postgres runs on that volume:

```sh
docker ps --filter volume=gratis-gis-prod_pgdata
```

If nothing is listed, remove the file and run the restore again:

```sh
docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.pitr.yml \
  --env-file infra/.env.prod run --rm --no-deps -T -u postgres --entrypoint rm \
  postgres /var/lib/postgresql/data/postmaster.pid
```

## When the repository itself was attacked

If files in the backup bucket were hidden (someone used the server
key to "delete" them), pgBackRest can read the bucket as it was before:
add `--repo-target-time='<time before the attack>'` to the `restore`
or `info` command. Then remove the hide markers with the master key as
in "Missing objects", and rotate the server key.
