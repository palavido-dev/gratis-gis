---
id: reference-api
title: The HTTP API
summary: The routes the Python client calls, for anyone working in another language.
category: reference
order: 48
complexity: advanced
tags:
  - api
  - integration
  - rest
  - ogc
related:
  - reference-python-client
  - reference-api-keys
---

Everything in the portal goes through one HTTP API, and an API key
reaches all of it. The [Python client](/help/reference/python-client)
is the easiest way in; this page is for anyone working in another
language, or wanting to know what the client is actually doing.

Base URL is your portal plus `/api`. Authenticate with a bearer token:

```bash
curl -H "Authorization: Bearer ggk_..." \
  https://your-portal.example/api/users/me
```

## The routes worth knowing

`:id` is a data layer item's id. `:layer` is the id of a layer inside
it, which you get from the item's `data.layers[].id` and which is not
the layer's display name.

### Identity

| | |
|---|---|
| `GET /api/portal-info` | Portal name, version, which features are on. No auth needed. |
| `GET /api/users/me` | Who this key acts as. |

### Items

| | |
|---|---|
| `GET /api/items?type=&q=&limit=&full=` | Search. `q` is the search text. Total count comes back in the `X-Total-Count` header. |
| `GET /api/items/:id` | One item, including its `data` payload. |
| `POST /api/items` | Create. Body is `{type, title, data, ...}`. |
| `PATCH /api/items/:id` | Sparse update; only the keys you send change. |

Creating a data layer means posting an item whose `data` is
`{version: 3, storageType: "postgis", layers: [...]}`. Nothing needs
provisioning afterwards; the item takes features straight away.

### Features

| | |
|---|---|
| `GET /api/items/:id/layers/:layer/features` | GeoJSON FeatureCollection. |
| `POST /api/items/:id/layers/:layer/features` | Append. `{features: [...]}`, up to 5000 per call. |
| `PATCH /api/items/:id/layers/:layer/features/:fid` | Update one feature's geometry or properties. |
| `DELETE /api/items/:id/layers/:layer/features/:fid` | Remove one feature. |
| `GET /api/items/:id/layers/:layer/features-search?q=&fields=` | Text containment search. |

Read parameters: `limit`, `cursor`, `at`, `bbox`, `parentFk` +
`parentId`, `timeField` + `timeFrom` + `timeTo`.

**Paging.** Pass `limit` and you get one page plus `nextCursor` and
`asOf`. Send `nextCursor` back as `cursor`, and `asOf` back as `at` so
every page reads the same snapshot. Stop when `nextCursor` is null, not
when a page comes back empty: deleted rows occupy page slots, so an
empty page can still have data behind it.

Without `limit` you get the entire layer in one response, which on a
large layer is slow and large.

**Filtering.** There is no `where` and no query language. `parentFk`
with `parentId` is exact equality on one field; `timeField` with
`timeFrom`/`timeTo` is an inclusive date range. An unrecognised field
name in either is **ignored**, and you get the unfiltered layer back, so
check your spelling against the layer's `fields`.

### Export

| | |
|---|---|
| `GET /api/items/:id/layers/:layer/geoparquet` | GeoParquet. Streams the whole layer. |
| `GET /api/items/:id/layers/:layer/csv?geometry=none\|wkt\|lonlat\|auto` | CSV. Caps at 100,000 rows. |
| `GET /api/items/:id/layers/:layer/geojson` | GeoJSON. |

The first two need **download** permission and return 403 without it.

### OGC API Features

Read-only, standards-compliant, and public where the item is:

```
GET /api/public/ogc/collections
GET /api/public/ogc/collections/{id}/items?bbox=&limit=&offset=
```

Core, GeoJSON, and CRS conformance classes. No CQL filtering and
`sortby` is rejected; both are planned.

## Errors

Standard status codes, with a JSON body carrying a `message` written
for a person.

| | |
|---|---|
| `400` / `422` | The request was malformed or failed validation |
| `401` / `403` | Key missing, revoked, or lacking permission |
| `404` | No such item, layer, or feature |
| `409` | Conflict |
| `429` | Rate limited; see the `Retry-After` header |

An API key is refused outright on admin endpoints, and a read-only key
is refused on any write, whatever the sharing says.

## The full specification

The portal generates an OpenAPI document from the code itself. It is
served at `/docs` and is enabled by default outside production; on a
production portal an administrator turns it on with `ENABLE_SWAGGER=1`.
It is off by default because it publishes the entire surface, including
routes that are not meant to be interesting to the public.

Running locally, `http://localhost:4000/docs` gives you the browsable
version of everything above and a good deal more.

## See also

- [Python client](/help/reference/python-client) — a wrapper around all of this
- [API keys](/help/reference/api-keys) — authentication
