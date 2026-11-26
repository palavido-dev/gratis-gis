# Self-hosted open-geocode

[open-geocode](https://github.com/open-geocode-rs/open-geocode)
(Apache 2.0) is a geocoder that serves a region from one
memory-mapped file. It needs no database. GratisGIS can use it for map
address search and for spreadsheet address import in place of
Nominatim.

**Most portals do not need this page.** Admin -> Geocoding builds and
serves an open-geocode index inside portal-worker: pick regions, click
Build. See the Geocoding help page. What follows is for running your
own open-geocode server elsewhere.

Set `OPEN_GEOCODE_URL` on portal-web and portal-api (the VPS and NAS
compose files pass it through). It takes precedence over the managed
geocoder. When it is set:

- Map, field app and custom app address search ask open-geocode. There
  is no fallback to the public Nominatim service.
- A spreadsheet with an address column and no coordinates is geocoded
  in batches, up to 10,000 rows (Nominatim: 200). Rows that only match
  a town or a postcode are left unplaced. The new layer gets a
  `geocode_accuracy` column: `rooftop`, `interpolated`, `street` or
  `centroid`.

## What it costs

Measured for West Virginia (2026-11, open-geocode 1.0.0, 12-core
desktop), OSM plus Census TIGER plus OpenAddresses:

| | |
| --- | --- |
| Build | about 2 minutes, 2 GB peak memory |
| Pack file | 68 MB |
| Memory while serving | under 0.5 GB |
| 6,000-row spreadsheet | about 2.5 seconds |

The first build also downloads about 2.3 GB of TIGER archives, which
can be deleted afterwards. Compare a state-sized Nominatim: 40 to 80
GB of disk and 16 GB of RAM (infra/NOMINATIM.md).

## Build a pack

Download the release for your platform from
<https://github.com/open-geocode-rs/open-geocode/releases>. Then build
the region you need. Region ids are in the project's catalog, for
example `us/west-virginia` or `canada/ontario`.

```sh
og build --region us/west-virginia --tiger
```

- `--tiger` adds U.S. Census address ranges. Use it for any U.S. state.
- `--openaddresses` adds OpenAddresses points, which give rooftop
  matches where OpenStreetMap has few addresses. It needs a free API
  token from <https://batch.openaddresses.io> in `OA_TOKEN`. Sources
  whose licence forbids commercial use are left out by default.
- Repeat `--region` to put several regions in one pack.

Packs land in the og home folder: `OG_HOME` when set, otherwise
`~/.local/share/open-geocode` on Linux and
`%LOCALAPPDATA%\open-geocode` on Windows.

## Serve it

```sh
og serve us-west-virginia --bind 0.0.0.0:8080
```

Then set `OPEN_GEOCODE_URL=http://<host>:8080` for the portal and
restart it. Keep the port off the public internet: the portal calls it
from the server side, and browsers never need to reach it.

With Docker, mount the pack folder and use the published image:

```sh
docker run -d --name open-geocode -p 127.0.0.1:8080:8080 \
  -v /srv/og-packs:/packs:ro \
  ghcr.io/open-geocode-rs/open-geocode \
  serve --pack /packs/us-west-virginia --bind 0.0.0.0:8080
```

## Updating

Rebuild the pack on any machine and copy the new pack folder over the
old one. The server picks up the new generation on restart. A monthly
rebuild keeps up with OpenStreetMap closely enough for address search.

## Check it

```sh
curl http://<host>:8080/readyz
curl "http://<host>:8080/geocode?q=10+Main+St,+Elkins,+WV"
```

portal-api logs `Address geocode of <file> (open-geocode): ...,
placed=N/M` for each spreadsheet import.
