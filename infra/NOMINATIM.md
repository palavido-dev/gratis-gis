# Self-hosted Nominatim

GratisGIS ships with a `nominatim` service in `docker-compose.yml` that
hosts your own geocoder. The map-viewer search bar and any future
place-lookup features route through `/api/geocode` on portal-web,
which forwards to `NOMINATIM_URL` (the local container by default).

This doc covers what hardware you need for each deployment tier, what
to expect on first boot, and the operational levers.

## Hardware baseline

Nominatim's resource cost scales with the OSM extract you point it at.

| Tier | Disk (imported DB) | RAM | shm_size | First-boot import | CPU |
| --- | --- | --- | --- | --- | --- |
| Dev (Monaco) | 2 GB | 2 GB | 1 GB | 2 min | 2 cores |
| City (Berlin) | 10 GB | 4 GB | 2 GB | 30 min | 4 cores |
| State / small country | 40-80 GB | 16 GB | 4 GB | 4-12 hr | 8 cores |
| Continent (NA/EU) | 250-400 GB | 32 GB | 8 GB | 18-36 hr | 8-16 cores |
| **Planet** (the default) | **1.1-1.3 TB** | **64 GB+** | **16-32 GB** | **36-72 hr** | **16+ cores** |

Disk must be SSD. HDD-class latency makes the import thrash on
index creation and the ETA balloons past any estimate above.

If your workstation can't host planet, **don't run planet on it**.
Either dial down to a regional extract or stand up a separate box
(bare metal or a cloud instance with at least 64 GB RAM / 1.5 TB SSD)
as your geocoder host and point `NOMINATIM_URL` at it.

## Changing the extract

The container picks up its region and tuning knobs from env vars.
Drop them in `infra/.env` (same file the rest of the compose reads)
or export them in your shell before `docker compose up`.

### Default (planet)

Every variable unset; compose defaults apply. Make sure the box has
the hardware from the table above.

### Regional / country extract

```env
NOMINATIM_PBF_URL=https://download.geofabrik.de/north-america-latest.osm.pbf
NOMINATIM_REPLICATION_URL=https://download.geofabrik.de/north-america-updates/
NOMINATIM_IMPORT_WIKIPEDIA=false
NOMINATIM_SHM_SIZE=8gb
NOMINATIM_THREADS=8
```

Geofabrik publishes extracts at continent, country, and state level.
Use their browse interface to pick the smallest one that covers your
users. Replication URL must match the extract's region or diff
updates fail silently.

### Dev / CI (Monaco)

```env
NOMINATIM_PBF_URL=https://download.geofabrik.de/europe/monaco-latest.osm.pbf
NOMINATIM_REPLICATION_URL=https://download.geofabrik.de/europe/monaco-updates/
NOMINATIM_IMPORT_WIKIPEDIA=false
NOMINATIM_SHM_SIZE=1gb
NOMINATIM_THREADS=2
```

Monaco imports in under 2 minutes and gives the full pipeline a
smoke-test without chewing through disk. It is **not** useful for
actual geocoding: most real queries will return nothing.

## Import lifecycle

The first `docker compose up -d nominatim` does a lot:

1. Downloads the PBF to the container (resumable: partial downloads
   survive a container restart).
2. Optionally downloads the Wikipedia/Wikidata ranking data
   (`IMPORT_WIKIPEDIA=true`).
3. Builds the Postgres database inside the `nominatim-data` volume.
4. Creates the flat-node file inside `nominatim-flatnode` (large but
   essential for planet-size imports).
5. Pre-computes search indexes.
6. Starts the HTTP API on port 8081.

The container sets its state via a `/nominatim/init-complete` marker
file, so a crash mid-import is resumable: bring the container back up
and it picks up where it left off.

To track progress:

```bash
docker compose -f infra/docker-compose.yml logs -f nominatim
```

Expect periodic `Processing [region name]` lines during import, then
`Starting Apache2` once the API is ready.

## Operations

### Replication (keeping data fresh)

If `REPLICATION_URL` is set (compose default), Nominatim runs a
background updater that pulls OSM diffs. Minute updates mean your
geocoder reflects edits to OSM within an hour or so; daily updates
are lower churn but slightly staler. The planet default is minute
updates.

### Freeze

`NOMINATIM_FREEZE=true` (compose default) drops a chunk of tables and
indexes that aren't needed for query-time lookups, cutting the planet
footprint by ~30 %. Cost: you can't re-import or apply diffs without
a full rebuild. Turn it off (`false`) if you plan to reimport, or
leave on for a geocoder-only deployment.

### Resetting

To wipe everything and start over:

```bash
docker compose -f infra/docker-compose.yml stop nominatim
docker volume rm gratis-gis_nominatim-data gratis-gis_nominatim-flatnode
docker compose -f infra/docker-compose.yml up -d nominatim
```

The next boot will re-download the PBF and re-import from scratch.

## Alternatives if you don't want to host

Set `NOMINATIM_URL` on portal-web to a different endpoint:

- **Public OSM** (`https://nominatim.openstreetmap.org`): free, rate-
  limited to 1 req/sec per their usage policy. Acceptable for demos,
  not for any real user traffic.
- **Paid providers**: Mapbox Search, MapTiler, LocationIQ, etc.
  Usually need an API key; adapt the `/api/geocode` proxy to sign
  requests with that key. A note on top of the proxy makes this a
  10-minute change.
