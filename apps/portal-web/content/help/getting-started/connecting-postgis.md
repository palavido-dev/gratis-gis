---
id: getting-started-connecting-postgis
title: Connecting to a PostgreSQL + PostGIS database
summary: Register a live connection to your PostGIS database so maps read tables on demand without copying data into the portal.
category: getting-started
order: 40
complexity: intermediate
tags:
  - postgis
  - postgresql
  - connection
  - live
related:
  - items-data-layer
---

If your organization already runs PostGIS, you can point a portal
map directly at it and skip the import step entirely. Layers read
their data on demand by bounding box; rows stay in your database.

## When this is the right tool

Use a live PostGIS connection when:

- The source data already lives in PostGIS and you don't want to
  duplicate it into the portal.
- The data changes frequently and you want every viewer to see the
  latest version without an export step.
- The tables are very large (millions of rows) and you want the
  database's GiST index to do the spatial work.

Skip it when:

- The data is small and infrequent (just upload a CSV / GeoPackage).
- The data is sensitive and you don't want the portal-api to hold
  connection credentials (use a read-only role with a narrow
  permission grant).

## Setup

1. Pick **PostgreSQL + PostGIS (live)** from the New Item page.
2. Give the connection a name and short description.
3. Fill in the connection details:
   - **Host** — DNS name or IP of your database.
   - **Port** — defaults to 5432.
   - **Database** — the database name.
   - **Role / username** — recommend creating a dedicated read-
     only role with SELECT-only permissions on the tables you
     want to expose. A regular login role works too; the portal
     never issues writes from this connection.
   - **Password** — stored encrypted on the server side. The
     browser never sees it after this form.
   - **Default schema** — the schema where the picker looks for
     tables by default. Other schemas stay reachable from the
     detail page.
4. Click **Test connection**. On success you see the PostGIS
   version and a capped preview of geometry tables in the default
   schema (name, geometry kind, SRID, and a planner row estimate
   when available). Fix any errors (firewall, wrong host, wrong
   password) before continuing.
5. Click **Save connection**. The portal probes the schema for
   geometry tables and registers each one as an available layer —
   the same set the preview listed, including any tables beyond
   the preview cap.

## Adding a layer to a map

Once a connection is registered, you can drop any of its tables
onto a map from the Add Layer dialog. Choose your saved
connection, pick the table, and the layer appears with the
correct geometry type. Every viewport move issues a bounding-box
SELECT against the database; only intersecting rows come back.

To narrow rows further, open the layer panel's **Filter** tab and
build clauses there. The portal compiles those filters into
parameterized SQL on the live read path. Power users can still
pass a free-form WHERE clause through the API; it is ANDed with
the structured filter.

## What gets cached vs read live

Nothing is cached. Every viewport move issues a fresh query. The
upside is that an analyst updating a table sees changes on the
map within seconds. The downside is that the database needs a
GiST index on the geometry column for any reasonable table size;
without it the query is a sequential scan and the map will lag.

## Permissions and security

- The PostGIS connection item itself follows the standard portal
  sharing model: only viewers with read access to the connection
  can see layers backed by it.
- The password is encrypted at rest using the portal's credential
  encryption key, the same way an ArcGIS service token is stored.
- Every query carries a `statement_timeout` (10 seconds by
  default) so a runaway query cannot tie up the database.
- The portal-api enforces a hard cap of 5000 features per
  request so a wide bounding box over a dense table can't fill
  the browser.
- Recommend a dedicated PostgreSQL role with SELECT-only
  permissions on the registered tables. Do not give it
  superuser or write privileges.

## Limitations

- Tables whose geometry column is not SRID 4326 are reprojected
  on read (`ST_Transform`): the bbox is transformed into the
  source SRID for the GiST index, and geometries go out as WGS84
  GeoJSON. Very large non-4326 tables still need a GiST index on
  the native geometry column.
- The connect wizard preview lists at most 50 geometry tables so
  a huge schema stays readable; Save still registers every
  geometry table in the default schema.
- Live connections are read-only from the portal. Editing still
  goes through a portal-managed data layer (or another write
  path you already run against the database).
- Single-instance pool. Cross-replica fanout (so two portal-api
  instances share connection pools) ships if the user count
  warrants it.

## Related

- [Data layer](items-data-layer) for portal-managed feature data
  (the alternative when you'd rather copy the rows into the
  portal database).
