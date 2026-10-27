---
id: items-arcgis-service
title: ArcGIS service
summary: An item that points at an external ArcGIS REST feature service or map service. Lets you reference AGO or Pro-published data from a GratisGIS map without copying it.
category: items
order: 130
complexity: intermediate
tags:
  - arcgis-service
  - item-type
  - external
related:
  - items-map
  - items-data-layer
  - coming-from-arcgis-feature-service
---

An **ArcGIS service** is an item that wraps a URL to an external
ArcGIS REST endpoint: a feature service, a map service, or a
tiled image service. By default the portal does not copy the
bytes; it queries the upstream service at render time and stores
only the URL plus auth details on this item.

When you want a local PostGIS copy, open the item and use
**Copy selected layers to data layer** (FeatureServer URLs, or a
MapServer that has a FeatureServer twin). That creates a new
**data layer** with the selected sublayers; the ArcGIS service
item stays a live pointer. Interactive copies stop at 50,000
features — use **Admin → Migrations → From ArcGIS Online** for a
full hosted-service cutover.

## When to use this vs. a data layer

Pick ArcGIS service when:

- The authoritative data lives on someone else's AGO portal or
 ArcGIS Server and you don't own it.
- You're consuming a public REST service (USGS, FEMA, state GIS
 portals) and want it to appear as a citable item in your portal.
- You want changes upstream to appear immediately, without an
 ingest step.

Pick **Data layer** instead when:

- You can re-host the data and want the portal to own it
 (filtering, edits, derived layers, offline use, faster query).
- The upstream service is rate-limited, slow, or unreliable, and
 you'd rather cut the dependency.

## Auth

Three modes:

- **Anonymous**. Public services with no token.
- **Token (static)**. An ArcGIS token you obtained once and pasted
 in. The portal proxies requests, attaching the token. Tokens
 expire; the item carries a warning if it's within a week of
 expiry.
- **Token (refreshable)**. Federated credentials. The portal
 refreshes the token automatically.

Tokens are stored encrypted at rest. The detail page never
displays them; you can replace but not read.

## What's stored

- **Service URL** and service type (feature service, map service,
 image service).
- **Auth config** (one of the modes above).
- **Cached metadata**. Layer list, schema, extent, the upstream
 server's reported max-record-count. Refreshed daily and on
 demand.

## Use on a map

In the map builder, add as you would any other layer; the layer
picker lists ArcGIS-service items the user can read. Each
sublayer becomes its own map layer reference with its own styling,
filter, and popup config. The portal renders by streaming
features (or tiles, for image services) from the upstream
service through its proxy.

## Notes

- **No edits.** Even on a feature service that supports editing
 upstream, the portal proxies in read-only mode by default. There
 is no "publish edits to AGO from here" path.
- **Pagination and limits**. The portal honors the upstream's
 max-record-count; large queries page through in the background.
 A layer with millions of features may render slowly compared to
 a native data layer.
- **Going dark**. If the upstream service moves or expires, every
 map that references it shows a broken-layer marker. The
 dependency panel surfaces this.
