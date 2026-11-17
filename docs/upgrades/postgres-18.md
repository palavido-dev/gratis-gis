# Postgres 18 and PostGIS 3.6

This is a plan for a later release. Nothing here changes the running
database. `infra/postgres/Dockerfile` stays on
`postgis/postgis:17-3.5`, and the Compose files keep mounting the
data volume at `/var/lib/postgresql/data`.

Dependabot pull request
[#533](https://github.com/palavido-dev/gratis-gis/pull/533) bumped
that tag to `18-3.6` and was closed without merging. A Postgres major
is a cluster upgrade, not an image bump. This document is the upgrade
that should ship instead, after the checklist at the bottom passes.

PostgreSQL 17 is supported until November 2029
([versioning policy](https://www.postgresql.org/support/versioning/)).
There is no security deadline driving this. Ship it when the checks
below are green, in a major release, not as a quiet patch.

## Why move, and what we should not expect

PostgreSQL 18, released 25 September 2025
([release notes](https://www.postgresql.org/docs/18/release-18.html)):

- Asynchronous I/O for sequential scans, bitmap heap scans, and
  vacuum (`io_method`, default `worker`). The project measured up to
  3× on some I/O-bound workloads. That number is an upper bound, not
  a tile-latency target.
- `pg_upgrade` keeps planner statistics. Extended statistics are not
  kept. This only helps if the upgrade uses `pg_upgrade`. A logical
  restore does not load `pg_statistic`, so it still needs `ANALYZE`.
- B-tree skip scan: a multicolumn index can be used when the query
  does not constrain the leading column.
- `uuidv7()` for time-ordered UUIDs. `uuidv4()` is an alias of
  `gen_random_uuid()`.

Those are real, and they are a poor match for the hot path here.
Vector tiles are built in
`DataLayerEngine.computeMvtTileBytes`
(`apps/portal-api/src/engine/data-layer.ts`) off a GiST index on
`observation.geom` (`observation_geom_gix`) and a btree on
`(scope, entity, valid_from DESC)`. The tile query always supplies
`scope`, so skip scan does not change that plan. Async I/O does not
apply to an index scan. It can help vacuum of large observation
partitions, and any query that still chooses a sequential or bitmap
heap scan. Production already sets `random_page_cost=1.1`,
`effective_io_concurrency=200`, and `jit=off` in
`infra/docker-compose.prod.yml` because the planner was preferring
sequential scans. Leave `io_method` at the default until a before
and after `EXPLAIN (ANALYZE, BUFFERS)` on a real layer says
otherwise. Do not turn on `io_uring` in the same change as the
upgrade.

`uuidv7()` does not unlock anything the app is waiting on. The
engine already mints UUIDv7 in `packages/engine/src/uuid.ts` and does
not call the SQL function. That file's comment says Postgres 17
ships `uuidv7()`. The PostgreSQL 18 release notes list the function
as new in 18. Correct the comment when the upgrade lands. Do not
switch writers to the SQL function as part of the upgrade.

PostGIS comes along because the image we would move to is
`postgis/postgis:18-3.6` (Debian trixie, PostGIS 3.6.x). As of the
docker-postgis image table in October 2026 that tag is PostGIS
3.6.4. Pin the upgrade to an image whose
`postgis_full_version()` is at least 3.6.1. PostGIS 3.6.0 (1
September 2025) is the release that introduced the breaking changes
below. 3.6.1 (13 November 2025) fixes two of them.

## What breaks if the tag flips on its own

A PostgreSQL 17 data directory will not start under PostgreSQL 18.
Two separate facts stack:

1. Major versions do not read each other's data files. The 16 to 17
   move already required a dump and restore. The note in
   `infra/postgres/Dockerfile` records that, and the aborted attempt
   tracked as #306.
2. The official image changed its layout at 18
   ([docker-library/postgres#1259](https://github.com/docker-library/postgres/pull/1259)).
   `PGDATA` is `/var/lib/postgresql/18/docker`. The volume is
   `/var/lib/postgresql`, not `/var/lib/postgresql/data`. Our Compose
   files mount the volume at `/var/lib/postgresql/data`, and that
   volume's root is the PG17 cluster (`PG_VERSION` at the top).
   Starting the 18 image with the mount moved to
   `/var/lib/postgresql` still fails: the entrypoint finds
   `PG_VERSION` at the old path and exits with the "data in
   /var/lib/postgresql" error. It does not delete the files. v0.9.118
   hit this on the demo host and v0.9.119 put the 17 image back.
   See [UPGRADING.md](../UPGRADING.md).

There is a third incompatibility that a same-Postgres PostGIS bump
would also hit. `postgis/postgis:17-3.5` is Debian bullseye.
`postgis/postgis:*-3.6` is Debian trixie. bullseye's glibc and
trixie's glibc do not sort text the same way. The docker-postgis
README warns that upgrading across that boundary can corrupt text
indexes, and that a full dump and restore is the safe path. `pg_upgrade`
copies index pages through. A restore rebuilds them.

## PostGIS 3.6 against this codebase

Source: the PostGIS 3.6.0 and 3.6.1
[NEWS](https://github.com/postgis/postgis/blob/3.6.1/NEWS) files.
Every breaking change from 3.6.0 is listed here with what the repo
actually calls.

### ST_TileEnvelope clips to the tile plane (#5799)

`ST_TileEnvelope` grows past the Web Mercator world bounds when its
margin argument is positive and the tile sits on the edge of the
plane. 3.6 clips the returned polygon to that plane (the default
bounds are EPSG:3857, ±20037508.342789244). Callers that pass a
margin on an edge tile get a smaller envelope than they did on 3.5.

GratisGIS never passes the margin. Every call uses the three-argument
form, so margin stays 0 and the envelope is the tile itself, which
already lies inside the plane. The clip is a no-op for those calls,
apart from a possible one-ulp trim if floating point puts the last
column or row a hair past the plane. That is worth a byte comparison
on edge tiles. It is not a reason to rewrite the SQL.

All three calls are in `DataLayerEngine.computeMvtTileBytes`
(`apps/portal-api/src/engine/data-layer.ts`). There are no other
`ST_TileEnvelope` call sites in the repo.

| Use | SQL | Margin |
| --- | --- | --- |
| Candidate filter | `geom && ST_Transform(ST_TileEnvelope(z, x, y), 4326)` | default 0 |
| Latest-row filter | `l.geom && ST_Transform(ST_TileEnvelope(z, x, y), 4326)` | default 0 |
| Tile geometry | `ST_AsMVTGeom(ST_Transform(geom, 3857), ST_TileEnvelope(z, x, y), 4096, 64, true)` | default 0 |

The `64` is `ST_AsMVTGeom`'s buffer, in tile units, not
`ST_TileEnvelope`'s margin. `clip_geom` is true. The seam overlap
MapLibre needs is unchanged by #5799. Do not "fix" this by adding a
margin to `ST_TileEnvelope`. That is the call shape #5799 changes,
and the buffer is already applied one function out.

`ST_AsMVT` is called once, on the next line of the same query
(`ST_AsMVT(visible_features, 'features', 4096, 'geom')`). It is not
in the 3.6 breaking list. The only other mentions of `ST_AsMVT` are
comments (`tile-cache.service.ts`, the production Compose shm note,
`docs/architecture/observation-log-engine.md`).

Those bytes are served from three routes, all of which call
`mvtTile` and then `computeMvtTileBytes`:

- `GET` `tile/:z/:x/:y.mvt` in
  `apps/portal-api/src/data-layer/features.controller.ts`
- the public copy in
  `apps/portal-api/src/public/public.controller.ts`
- the OGC tiles copy in
  `apps/portal-api/src/public/ogc/tiles.controller.ts`

`pg_tileserv` is in the dev and prod Compose files and is not in the
NAS file. The portal does not draw its own layers through it
(`docs/truenas.md`). Its SQL is upstream's, not ours. No change.

Expected impact: interior tiles should be byte-identical aside from
MVT encoding noise that PostGIS already produces across versions.
Edge tiles of the world (column 0, column `2^z - 1`, row 0, row
`2^z - 1`) are the ones to diff. A difference there means the clip
trimmed the envelope, not that features moved. The checklist below
says how to compare them.

### geometry_columns no longer reads constraints in 3.6.0 (#5829, restored in 3.6.1 as #5978)

3.6.0 stopped parsing CHECK constraints to fill `geometry_columns`.
A column whose type and SRID live only in constraints then shows
`type = GEOMETRY` and `srid = 0`. 3.6.1 put constraint parsing back,
with a regex instead of the string split that threw on #5829
(`ERROR: invalid type integer input syntax` when an SRID check was
ANDed with another predicate). The upgrade image must report PostGIS
>= 3.6.1 so we do not ship the 3.6.0 view.

The app reads `geometry_columns` in two places, both for the
postgis-live connect wizard, not for the portal's own tables:

- `apps/portal-api/src/postgis-live/postgis-live.service.ts`
  (`probe`, `SELECT ... FROM geometry_columns WHERE f_table_schema = $1`)
- `apps/portal-api/src/postgis-live/postgis-table-preview.ts`
  (`listGeometryTablesPreview`, same view, plus `pg_class.reltuples`)

Those queries describe a database the user pointed at. Upgrading our
server does not change a remote server's view. It does change the
answer when someone points postgis-live at this install.

Our own geometry columns:

- `item.bbox_geom` is `geometry(Polygon, 4326)` (typmod). The view
  reads typmod first. Unaffected on 3.6.0 and later.
- Feature-service tables from `provisionTable` in
  `apps/portal-api/src/features/features.service.ts` use
  `GEOMETRY(Geometry, 4326)`. Typmod. Unaffected.
- `observation.geom` had its typmod dropped in migration
  `20260510140000_observation_allow_z_dimension`. It is bare
  `geometry` plus `CHECK (geom IS NULL OR ST_SRID(geom) = 4326)`.
  There is no `geometrytype()` constraint, so the type is `GEOMETRY`
  on 3.5 and on 3.6. The SRID check matches the 3.6.1 regex
  `srid\(\w+\)\s*=\s*(\d+)`, so 3.6.1+ still reports 4326. On 3.6.0
  exactly, that SRID would read as 0. Nothing in the portal lists
  `observation` through `geometry_columns`. The postgis-live probe
  would, if pointed at `public`.

No migration or service calls `AddGeometryColumn`.

### The other 3.6 breaking changes

- Topology domain upgrade (#3373) and bigint topology ids (#3110),
  plus the integer signatures replaced by bigint. `postgis_topology`
  is created in `infra/init-db.sql` and `infra/init-prod-db.sql`. No
  application SQL calls `topology.*` or `ST_NumGeometries` /
  `ST_GeometryN`. After a dump/restore the extension is created at
  3.6 by `CREATE EXTENSION`, so the 3.6.0 topogeometry corruption
  does not apply: that corruption is from `ALTER EXTENSION
  postgis_topology UPDATE` on a cluster that already had topogeometry
  columns. Still run `SELECT * FROM topology.layer` after the
  upgrade. An empty result is what this codebase produces. If it is
  not empty, run the 3.6.1 repair before serving traffic:

  ```sql
  SELECT topology.FixCorruptTopoGeometryColumn(
    schema_name, table_name, feature_column)
  FROM topology.layer;
  ```

- `ST_NumGeometries` / `ST_GeometryN` treat TIN and PolyhedralSurface
  as one geometry (GT-252). Use `ST_NumPatches` / `ST_PatchN` for
  patches. No call sites. The contour tool
  (`apps/portal-api/src/derived-layers/tools/contour.ts`) builds a
  triangulation with `ST_DelaunayTriangles` and dumps points. It does
  not call `ST_NumGeometries`.
- Tiger geocoder uses `@extschema@` and typmod (#5359, #5897). We do
  not call tiger functions. The base `postgis/postgis` entrypoint
  creates `fuzzystrmatch` and `postgis_tiger_geocoder` in the
  application database on first boot. A logical restore recreates
  the extension at the version in the new image. No application
  change.
- `st_approxquantile(raster, double precision)` was removed (#5498).
  No call sites. The app does not run raster SQL inside Postgres.

## Keycloak and the extensions we install

Production (`infra/docker-compose.prod.yml`) and the NAS stack
(`infra/docker-compose.nas.yml`) run Keycloak 26.0
(`quay.io/keycloak/keycloak:26.0`) with
`KC_DB_URL=jdbc:postgresql://postgres:5432/keycloak` on the same
Postgres instance. The dev stack does not: `infra/docker-compose.yml`
sets `KC_DB: dev-file` (H2). The image's init script still creates a
`keycloak` role and database in dev, because
`infra/postgres/Dockerfile` copies `init-prod-db.sh` into the image
and the dev Compose file does not mask it. That dev database is
unused.

Keycloak 26.5.0 is the release whose upgrade notes add PostgreSQL 18
("The latest major release of PostgreSQL 18 is now supported"). The
`26.0` tag does not float up to 26.5. A report against 26.4.5
([keycloak#44274](https://github.com/keycloak/keycloak/issues/44274))
said an informal test worked and that 18 was not in the supported
list yet. Do not upgrade Postgres to 18 while the image pin stays
`26.0`. The same release that flips Postgres should move Keycloak to
a 26.5 or later tag and then check realm import, password login, and
the admin users API. Dev H2 is unaffected.

Extensions, and where they come from:

| Extension | Created by | Binary |
| --- | --- | --- |
| `postgis`, `postgis_topology` | `infra/init-db.sql`, `infra/init-prod-db.sql`, and the Prisma init migration | the PostGIS image |
| `fuzzystrmatch`, `postgis_tiger_geocoder` | the upstream `postgis/postgis` first-boot script, not our SQL | the PostGIS image |
| `pgcrypto`, `pg_trgm`, `uuid-ossp` | init SQL and `20260417214222_init` | PostgreSQL contrib, in the server package |
| `pg_stat_statements` | `infra/init-prod-db.sql` only | contrib. Prod and NAS preload it. Dev does not. Existing installs that predate v0.9.107 still need the one-shot `CREATE EXTENSION` in [UPGRADING.md](../UPGRADING.md). A logical restore of a database that already has it brings it back. |
| `pg_partman` | migration `20260508081000_partition_observation_table`, schema `partman` | `postgresql-17-partman` today. The background worker is load-bearing: premake is 4, and the Compose command sets `shared_preload_libraries=pg_partman_bgw`. |
| `pg_repack` | not created by a migration. The orphan-cleanup migration only mentions it | `postgresql-17-repack` is installed in the image so an operator can run it |

`pg_trgm` backs geocoding (`apps/portal-api/src/geocoding/geocoding.service.ts`)
and per-field GIN indexes. Those indexes are collation-sensitive
enough to be part of the glibc warning above. A dump and restore
rebuilds them. `pg_upgrade` would not.

The 18 image has to install `postgresql-18-partman` and
`postgresql-18-repack` from current PGDG. Both packages exist for
PostgreSQL 18. The bullseye archive rewrite in the Dockerfile must
go away in that same change: trixie has no `/etc/apt/sources.list`
(deb822 lives in `/etc/apt/sources.list.d/debian.sources`), and
`postgresql-17-partman` is the wrong major. That is also why pull
request 533's CI failed. Details are in the checklist.

`uuid-ossp` stays. New code uses `gen_random_uuid()` (built in since
Postgres 13, and provided by `pgcrypto` before that). Leave the
extension installed so a restored dump that still names
`uuid_generate_v4()` loads.

Init SQL runs only when the data directory is empty. A restored
cluster does not re-run it. The dump has to carry the extensions,
the `tiles` schema, and the Keycloak role's database. The fresh 18
boot runs the scripts once, before the restore drops those databases
and loads the dump. The procedure below does that on purpose.

## Upgrade paths

### Dump and restore, recommended

`pg_dump` / `pg_restore` (and `pg_dumpall` for roles) works on any
host that can run the current container, including TrueNAS SCALE and
Dockge. It does not need both server binaries, and it rebuilds
indexes with trixie's glibc. That is the path docker-postgis
recommends across the bullseye to trixie jump, and it is the path
the Dockerfile comment has pointed at since the 16 to 17 move.

Cost, stated honestly: the restore writes every row again and then
`ANALYZE` has to rebuild planner stats. `pg_upgrade` on 18 would
have kept those stats. Until `ANALYZE` finishes, plans can be worse
than they were on 17. `vacuumdb --analyze-in-stages` is the first
command after the restore for that reason. Downtime is the whole
window from stopping the writers through the end of the restore.
Take the disk measurement in the procedure before you start. You
need room for the dump files, a preserved copy of the PG17 volume,
and the new cluster growing during restore.

Use custom-format dumps, not a single `pg_dumpall` script, once the
application database is more than a toy. `pg_dumpall` is plain SQL,
one stream, and it cannot be restored in parallel. Two `-Fc` dumps
plus a globals file is the same logical backup and is what the steps
use. A small install can still use one `pg_dumpall` if someone
prefers it. The steps below are the ones to follow.

What the in-app backup is, and is not: Admin, Backup, runs
`pg_dump -Fc --no-owner --no-privileges` against `DATABASE_URL` only
(`BackupService.runPgDump` in
`apps/portal-api/src/backup/backup.service.ts`) and tars that with
the object store. Restore runs `pg_restore --clean --if-exists` and
then puts the objects back (`backup-restore.service.ts`). That
archive does not contain the `keycloak` database, roles, or
`infra/.env.prod`. [deployment.md](../deployment.md) already says an
archive restores only on the install that created it, because the
encryption key and the Keycloak realm live outside it. Take one
anyway before this upgrade. It is the copy of portal rows and
uploads you can put back if the application data in the new cluster
is wrong. It cannot roll Postgres back from 18 to 17, and it cannot
rebuild Keycloak users. Rolling the major back means starting the 17
image on the preserved volume.

`pg_dump` will not dump a newer server than itself. The API image
installs `postgresql-client-17`
(`apps/portal-api/Dockerfile`) so backups match the server. The
upgrade release has to move that package to `postgresql-client-18`
in the same change. Until it does, scheduled backups fail. A dump
taken by client 17 restores with `pg_restore` 18, which is what the
steps use (the client inside the new Postgres container).

`infra/snapshot-golden.sh` shells `pg_dump` inside the Postgres
container, so it follows the server version on its own. The API
backup does not.

### pg_upgrade in a one-shot container

A `tianon/postgres-upgrade:17-to-18` style container runs
`pg_upgrade` with both binaries mounted on one volume. PostgreSQL 18
adds `--swap` and keeps planner stats, and `--link` is fast when the
old and new directories are on one filesystem. That is the appeal,
and it is a poor fit here:

- The published helper is vanilla Postgres. `pg_upgrade` needs the
  PostGIS, `pg_partman`, and `pg_repack` libraries for both majors.
  A useful helper is an image we would have to build and publish,
  with 17 and 18 side by side.
- Our volume root is the PG17 data directory. The helper expects a
  versioned layout (`17/data` next to `18/data`, or the official
  image's `17/docker` and `18/docker`). Someone has to move the files
  into that layout before `pg_upgrade`, and the 18 image will refuse
  to start if any old `PG_VERSION` is left in the wrong place.
- Indexes come across as bytes. bullseye to trixie is a glibc change.
  Text indexes then have to be `REINDEX`ed or they can return the
  wrong rows. `pg_trgm` indexes and the btree indexes on names and
  slugs are in that set. After a mandatory `REINDEX`, a lot of the
  speed advantage is gone, and the glibc risk remains until the
  reindex finishes.
- TrueNAS and Dockge pull images. They do not build this repo. An
  operator would `docker run` a second image against the volume from
  the NAS shell. The failure mode is mounting the wrong path and
  upgrading an empty directory while the real data sits next to it.

Use `pg_upgrade` only if a rehearsal shows the logical restore will
not finish in a window you can take, and only with a helper image
that contains both PostGIS builds, followed by `REINDEX DATABASE`
on `gratisgis` and on `keycloak`, then `ANALYZE`. It is not the
procedure below.

### Recommendation

Dump and restore, as written in the next section. Do it once, in a
major release, with the image, the volume mount, the client package,
the partman package, and the Keycloak tag moving together. Do not
teach `deploy.sh` to do it unattended. Do publish a helper script
with that release. The script should wrap these steps, refuse to
delete a volume it has not copied, and never be called by
`deploy.sh`. `deploy.sh` itself should, in that release, read
`PG_VERSION` and exit before starting Postgres 18 on a 17 cluster.
Build the script and the guard in the upgrade release. This document
does not add them.

## Before you start

Do this on a copy first if you have one. The demo host's 16 to 17
move kept the old data directory as a renamed volume. Do the same
here. The portal is down from the moment writers stop until the new
cluster is restored and Keycloak is healthy.

1. Read the release notes of the version you are moving to. The line
   that starts `Breaking:` is the one that says the image has
   actually flipped. If that line is absent, do not run this
   procedure. You are not on the upgrade release.
2. In the portal, create a backup and download it off the host.
   Copy `infra/.env.prod` (or, on a NAS, confirm the `boot` volume
   is intact). `CREDENTIAL_ENCRYPTION_KEY` is not in the archive.
3. Confirm the running server is 17 and PostGIS 3.5, so you do not
   dump an 18 you already upgraded:

   ```bash
   docker exec CONTAINER psql -U gratisgis -d gratisgis \
     -c 'SHOW server_version' \
     -c 'SELECT postgis_full_version()'
   ```

4. Check disk. You need free space for the two dump files, a second
   copy of the Postgres volume, and the new cluster. Stop if you do
   not. `docker system df` and `df -h` on the disk that holds
   `/var/lib/docker`.

`CONTAINER` and the volume name differ per install. Look them up.
Do not guess, and do not remove `boot`, `miniodata`, `caddy-data`,
or `portal-api-backups`.

```bash
docker ps --filter name=postgres --format '{{.Names}}'
docker inspect CONTAINER --format '{{range .Mounts}}{{.Name}} {{.Destination}}{{"\n"}}{{end}}'
```

The destination today is `/var/lib/postgresql/data`. The named
volume on that line is `PGVOL`. On a default prod checkout `PGVOL`
is `gratis-gis-prod_pgdata` and `CONTAINER` is
`gratis-gis-prod-postgres` (the Compose project name is
`gratis-gis-prod`). Dev is project `gratis-gis`, container
`gratis-gis-postgres`, volume `gratis-gis_pgdata`. A NAS app often
prefixes the volume with the app name. Trust `docker inspect`.

## Docker Compose install

These commands assume the prod checkout at `/opt/gratis-gis` and
the files from [deployment.md](../deployment.md). Set `COMPOSE` once:

```bash
cd /opt/gratis-gis
COMPOSE="docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod"
```

Stay on the old release for the dump. `./infra/deploy.sh` on the
upgrade release would try to start 18 against this volume and the
container would exit. The data would still be there, and you would
have to start 17 again to dump it. Dump first.

Stop writers, then start Postgres on its own. Several services
open database connections (`portal-api`, `portal-worker`,
`script-runner`, `pointcloud-worker`, Keycloak). Stopping the whole
project and starting `postgres` is the list that stays correct when
a service is added.

```bash
$COMPOSE stop
$COMPOSE up -d postgres
```

Dump roles, the application database, and the Keycloak database.
`gratisgis` is the superuser the image created (`POSTGRES_USER`).

```bash
mkdir -p "$HOME/gratis-gis-pg17-backup"
BACKUP="$HOME/gratis-gis-pg17-backup"
docker exec CONTAINER pg_dumpall -U gratisgis --globals-only \
  > "$BACKUP/globals.sql"
docker exec CONTAINER pg_dump -U gratisgis -Fc -d gratisgis \
  > "$BACKUP/gratisgis.dump"
docker exec CONTAINER pg_dump -U gratisgis -Fc -d keycloak \
  > "$BACKUP/keycloak.dump"
ls -l "$BACKUP"
```

The globals file is the safety copy of roles. A stock install has
two roles, `gratisgis` and `keycloak`, and the new image's init
scripts recreate both from `POSTGRES_PASSWORD` and
`KEYCLOAK_DB_PASSWORD`. You do not restore `globals.sql` onto that
stock cluster. Keep the file. If you have created roles by hand,
restore it later with `ON_ERROR_STOP` off and expect `already
exists` on the two built-in roles. Check that the `ALTER ROLE`
passwords still match the env file.

Stop the stack and copy the volume. `down` removes containers. It
does not remove named volumes. Do not pass `-v`.

```bash
$COMPOSE down
docker volume create "${PGVOL}_pg17"
docker run --rm \
  -v "$PGVOL":/from:ro \
  -v "${PGVOL}_pg17":/to \
  alpine:3.20 \
  sh -c 'cd /from && cp -a . /to'
docker run --rm -v "${PGVOL}_pg17":/data alpine:3.20 \
  sh -c 'cat /data/PG_VERSION && du -sb /data'
```

`PG_VERSION` must print `17`. Compare `du -sb` with the source
volume. If they disagree, stop and copy again. Then remove only the
original volume so the next start creates an empty one:

```bash
docker volume rm "$PGVOL"
```

Check out the upgrade release (the one whose notes contain the
`Breaking:` line). The Compose files in that release mount `pgdata`
at `/var/lib/postgresql`. The Dockerfile installs
`postgresql-18-partman` and `postgresql-18-repack` and does not
rewrite `/etc/apt/sources.list`. Start Postgres only.

```bash
git fetch origin --tags
git checkout V2_TAG
$COMPOSE up -d postgres
$COMPOSE ps postgres
```

Wait until it is healthy. The first boot runs
`init-prod-db.sql` and `init-prod-db.sh`, which create extensions
and the Keycloak role and database. Confirm the new server, then
drop those two databases and restore the dumps into empty ones.
Connect to the `postgres` maintenance database for the drops.

```bash
docker exec CONTAINER psql -U gratisgis -d postgres \
  -c 'SHOW server_version' \
  -c "SELECT name, default_version FROM pg_available_extensions WHERE name IN ('postgis','postgis_topology','pg_partman','pg_repack','pg_trgm','pgcrypto','uuid-ossp','pg_stat_statements')"
```

`postgis` must be 3.6.1 or newer. `pg_partman` and `pg_repack` must
be present. If `pg_partman` is missing, the image was not rebuilt.
Do not restore yet.

```bash
docker exec CONTAINER psql -U gratisgis -d postgres -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
 WHERE datname IN ('gratisgis', 'keycloak')
   AND pid <> pg_backend_pid();
DROP DATABASE gratisgis;
DROP DATABASE keycloak;
CREATE DATABASE gratisgis OWNER gratisgis;
CREATE DATABASE keycloak OWNER keycloak;
SQL
docker cp "$BACKUP/gratisgis.dump" CONTAINER:/tmp/gratisgis.dump
docker cp "$BACKUP/keycloak.dump" CONTAINER:/tmp/keycloak.dump
docker exec CONTAINER pg_restore --exit-on-error -U gratisgis \
  -d gratisgis /tmp/gratisgis.dump
docker exec CONTAINER pg_restore --exit-on-error -U gratisgis \
  -d keycloak /tmp/keycloak.dump
docker exec CONTAINER rm -f /tmp/gratisgis.dump /tmp/keycloak.dump
```

`docker cp` writes the dump into the container layer. If the dump
is larger than the free space on the docker disk, mount `$BACKUP`
into a one-shot container on the Compose network instead of copying
it. The network name is `gratis-gis-prod_gratis-net`. Use the
Postgres image you just built, and pass `PGPASSWORD` from
`.env.prod`, because a TCP connection is not the local trust socket.

Then statistics, the topology check, and the extension versions:

```bash
docker exec CONTAINER vacuumdb -U gratisgis --all --analyze-in-stages
docker exec CONTAINER psql -U gratisgis -d gratisgis \
  -c 'SELECT postgis_full_version()' \
  -c 'SELECT extname, extversion FROM pg_extension ORDER BY 1' \
  -c 'SELECT parent_table, partition_interval, premake FROM partman.part_config' \
  -c 'SELECT count(*) AS topology_layers FROM topology.layer'
```

`partman.part_config` should list `public.observation`. If
`topology_layers` is not 0, run `FixCorruptTopoGeometryColumn` as
shown above before starting the API. Then start the rest of the
stack:

```bash
$COMPOSE up -d
```

Sign in as an existing user, not only the bootstrap admin. Open a
map that was rendering tiles before the upgrade. Create a backup
from the admin page and confirm it completes. That last check fails
if the API image is still on `postgresql-client-17`.

### Dev Compose

`infra/docker-compose.yml` is the same Postgres image and the same
mount. The container is `gratis-gis-postgres`, the volume is
`gratis-gis_pgdata`, and the project name is `gratis-gis`. Keycloak
data is the H2 file in the Keycloak container, not the `keycloak`
database. Still dump that database so the restore matches the init
script, then restore it the same way. You do not need a Keycloak
login test against Postgres in dev. You do need the application
database.

## TrueNAS SCALE and Dockge

The NAS stack is `infra/docker-compose.nas.yml`, documented in
[truenas.md](../truenas.md). There is no git checkout and no
`deploy.sh`. Images are
`ghcr.io/palavido-dev/gratis-gis/postgres:${GG_IMAGE_TAG:-edge}`.
The upgrade release has to be published before you pull it. Dump
while the old image is still the one that is running.

The Compose project `name:` is `gratis-gis`, and the volume key is
`pgdata`, mounted at `/var/lib/postgresql/data`. TrueNAS and Dockge
both prefix volume names with the app or stack name. Use `docker
inspect`, as above. Do not delete the `boot` volume. It holds the
generated passwords, the realm JSON, and the Caddy config. Deleting
it is a new install, not an upgrade.

From the NAS shell, or Dockge's terminal, with the app still
running and Postgres healthy:

```bash
CONTAINER=$(docker ps --filter name=postgres --format '{{.Names}}' | head -n 1)
echo "$CONTAINER"
docker inspect "$CONTAINER" --format '{{range .Mounts}}{{.Name}} {{.Destination}}{{"\n"}}{{end}}'
mkdir -p /mnt/tank/gratis-gis-pg17-backup
BACKUP=/mnt/tank/gratis-gis-pg17-backup
docker exec "$CONTAINER" pg_dumpall -U gratisgis --globals-only > "$BACKUP/globals.sql"
docker exec "$CONTAINER" pg_dump -U gratisgis -Fc -d gratisgis > "$BACKUP/gratisgis.dump"
docker exec "$CONTAINER" pg_dump -U gratisgis -Fc -d keycloak > "$BACKUP/keycloak.dump"
ls -l "$BACKUP"
```

Use a dataset path that is actually on your pool. `/mnt/tank` is a
placeholder.

Also create and download an admin backup, as in
[truenas.md](../truenas.md). Then stop the app in the TrueNAS UI, or
stop the stack in Dockge. `restart: unless-stopped` stays stopped
after `docker stop`. Do not remove the app, and do not choose the
checkbox that deletes volumes.

Copy `PGVOL` to `${PGVOL}_pg17` with the same `alpine:3.20` `cp -a`
used above. Check `PG_VERSION` is `17`. Only then
`docker volume rm "$PGVOL"`.

Paste the upgrade release's `docker-compose.nas.yml` over the app
(TrueNAS, Edit, or the Dockge stack). Keep `GRATIS_HTTP_PORT` and
`GRATIS_BASE_URL` if you changed them. That file's Postgres service
mounts `pgdata` at `/var/lib/postgresql` and pulls the new image.
Save and start.

The app will also start Keycloak and the API. Stop those
containers as soon as they appear, and leave Postgres up. A Keycloak
boot against the empty database just created by init will import the
realm from the `boot` volume and race the restore.

```bash
docker ps --format '{{.Names}}'
docker stop KEYCLOAK_NAME API_NAME
# Stop the worker and Chromium too if they are up. Leave Postgres.
```

If a restart policy or the UI brings them back, stop them again.
Then run the same drop, `docker cp`, and `pg_restore` steps as in
the Compose section, using this `CONTAINER`. `vacuumdb
--analyze-in-stages`, check `partman.part_config` and
`topology.layer`, then start the containers you stopped (or start
the app again from the UI).

Sign in as an existing user. The bootstrap log does not print the
password again. The realm you restored is the one from the dump,
including users created after the first boot. If you skip the
Keycloak dump and let Keycloak import the realm JSON instead, you
get the first-boot realm and you lose those users.

Dockge is the same shell commands. The stack directory is wherever
Dockge keeps the pasted file. You do not need it for the dump. You
need it only if you prefer `docker compose exec` over `docker exec`.

## Rollback

Two cases.

The new image refused to start and you have not removed the volume.
The PG17 files are untouched. Check out the previous release so the
mount is `/var/lib/postgresql/data` and the image is 17 again, and
start. No restore.

You removed the volume, started 18, and want 17 back.

```bash
$COMPOSE down
docker volume rm "$PGVOL"          # this is the new, empty-or-restored 18 volume
docker volume create "$PGVOL"
docker run --rm \
  -v "${PGVOL}_pg17":/from:ro \
  -v "$PGVOL":/to \
  alpine:3.20 \
  sh -c 'cd /from && cp -a . /to'
git checkout PREVIOUS_TAG
$COMPOSE up -d
```

On a NAS, paste the previous `docker-compose.nas.yml` (mount at
`/var/lib/postgresql/data`) instead of `git checkout`. Do not delete
`${PGVOL}_pg17` until you have signed in on the restored cluster.

Anything written after the dump is not in the PG17 copy. The admin
backup archive, if you took it at the same time, matches that dump
for portal rows and uploads only.

A failed `pg_restore` on the new volume is not a rollback. Drop the
database and restore again, or go back to the PG17 volume as above.
Do not point the 17 image at the 18 volume.

## Testing checklist before that release ships

The upgrade release is not this document. It is the change that
flips the image. All of the following belong in that change, and
the release does not ship until they pass.

Fresh install:

- Empty volume, new image, `prisma migrate deploy` from zero.
- `pg_extension` lists `postgis` >= 3.6.1, `postgis_topology`,
  `pg_partman`, `pg_trgm`, `pgcrypto`, `uuid-ossp`, and, on prod,
  `pg_stat_statements`. `pg_available_extensions` lists `pg_repack`.
- `partman.part_config` has `public.observation` after migrations.
  The log shows the partman background worker connected.
- Keycloak on the new tag imports the realm, a user can sign in, and
  the admin users page can read the realm (the NAS grant of
  realm-management roles still runs).

Upgraded install:

- A seeded database (demo seed or a golden snapshot) run through the
  procedure above. Compare `count(*)` on `item`, `observation`, and
  Keycloak `user_entity` before and after.
- Sign in as a user who existed before the upgrade.
- `ANALYZE` has been run. `EXPLAIN` on a tile query uses the GiST
  index, as it did on 17.

Tiles:

- For one real layer, fetch the same `z/x/y` before and after at an
  interior tile and at the four edges of the Web Mercator plane
  (column 0, column `2^z-1`, row 0, row `2^z-1`), at a low zoom and
  a high zoom. Decode both MVTs and compare feature ids. The SQL
  under test is `computeMvtTileBytes`. A mismatch on an interior
  tile is a bug. A mismatch only on an edge tile is #5799 and needs
  a decision before release. Also look at the rendered map along a
  tile boundary for seams. The 64-unit buffer is what prevents those
  seams, and it is independent of the clip.
- The pg specs in `data-layer.pg.spec.ts` already cover tombstones,
  filters, and via-tiles. Run them against the 18 image
  (`REQUIRE_PG_SPECS=1`). They do not cover the antimeridian. Add
  one edge-tile case, or do the manual fetch above and record it.

`geometry_columns`:

- On the upgraded database, `observation.geom` still reports SRID
  4326, and `item.bbox_geom` still reports `POLYGON` / 4326.
- A throwaway table created with `AddGeometryColumn(..., use_typmod
  => false)` still reports its type and SRID. That is the #5978
  case, and it is why 3.6.0 is not acceptable.
- postgis-live test-connection against this server still lists the
  typmod feature-service table.

CI, in that same release:

- `.github/workflows/ci.yml` service image, today
  `postgis/postgis:17-3.5`. The comment above it names
  `postgresql-client-17`.
- `apps/portal-api/Dockerfile` client package, 17 to 18, or admin
  backups fail in production.
- Comments in `data-layer.pg.spec.ts`, `search-index.pg.spec.ts`,
  and `search-index.service.ts` that tell a developer to run
  `postgis/postgis:17-3.5`.
- The Dockerfile apt layer, as fixed for the failure below. The
  fresh-clone job builds that Dockerfile. The verify job does not.
  Updating only the `FROM` line turns the fresh-clone job red and
  leaves verify green. That is what happened on #533.

Backup feature:

- After the client bump, an admin backup on 18 completes and
  restores onto a scratch database.
- An archive produced on 17 (`pg_dump -Fc` from client 17) restores
  with `pg_restore` from the 18 client. That is the forward
  direction Postgres supports.

### Why the fresh-clone job failed on #533

Job `Fresh-clone pnpm dev` on run
[41398758072](https://github.com/palavido-dev/gratis-gis/actions/runs/41398758072),
job id `125125741493`, 2 November 2026. It failed in about thirty
seconds. It never reached migrations or `pnpm dev`.

That job is the one that builds our image. The step is
`docker compose -f infra/docker-compose.yml up -d --wait postgres`
(`.github/workflows/ci.yml`). Dependabot changed only the `FROM`
line, to `postgis/postgis:18-3.6` (pulled as
`sha256:4a43e3c3e5d55b9208240fc71db543b79c638766280c625a425bd0a2390989c4`).
The next `RUN` still edits `/etc/apt/sources.list`, which exists on
the bullseye-based `17-3.5` image and does not exist on the
trixie-based `18-3.6` image:

```text
sed: can't read /etc/apt/sources.list: No such file or directory
```

The build stopped at `infra/postgres/Dockerfile` line 59, exit code
2. The same `RUN` would have failed on the next line anyway: it
installs `postgresql-17-partman` and `postgresql-17-repack`.

Every other job on that run was green, including `Lint, typecheck,
test, build`. The verify job's Postgres service is the stock
`postgis/postgis:17-3.5` image, hardcoded, not the Dockerfile
Dependabot edited. A green verify job on a Postgres bump does not
mean the image builds.

The upgrade's Dockerfile change has to delete that bullseye rewrite,
install the 18 partman and repack packages from the live PostgreSQL
apt repository, and be built by the fresh-clone job before the
release tag moves.

## Rollout

Ship the image flip as **v2.0.0**, not as a 1.x release.
[VERSIONING.md](../VERSIONING.md) puts breaking deployment changes
in a major. An unprepared `deploy.sh` against this upgrade takes
Postgres down. That is a breaking change even though the HTTP API
does not move.

Draft release-note line, for that version's changelog, not for this
document's release:

```text
Breaking: Postgres moves from 17 / PostGIS 3.5 to 18 / PostGIS 3.6.
A PG17 data directory does not start on the new image. Before you
deploy, dump the application database and the Keycloak database and
follow docs/upgrades/postgres-18.md. deploy.sh does not convert the
volume. The admin backup is not a substitute for that dump: it does
not include Keycloak.
```

Also say, in the same section, that Keycloak moves to the 26.5 or
later tag chosen for the release, and that the API image's
`pg_dump` client is 18.

Build `infra/upgrade-postgres-18.sh` in that release. It should dump,
copy the volume, and restore, and it should refuse to `docker volume
rm` the source until the copy's `PG_VERSION` reads 17 and the sizes
match. It should not call `pg_upgrade`. It should not run from
`deploy.sh`. `deploy.sh` should detect a 17 data directory and exit
with a pointer at this document. Write both of those then. They are
not in the tree today.

Until that release, Dependabot ignores major bumps of
`postgis/postgis` (`.github/dependabot.yml`, the
`/infra/postgres` entry). Minor and patch tags still open. A future
`17-3.6` pull request is a PostGIS minor on Postgres 17, and it is
still the trixie image and the `ST_TileEnvelope` change. Review it
against this document. Do not merge it as a routine dependency bump.
