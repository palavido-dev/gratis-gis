---
id: coming-from-arcgis-terminology
title: Terminology map
summary: Word-for-word mapping between ArcGIS Online vocabulary and GratisGIS vocabulary.
category: coming-from-arcgis
order: 10
complexity: basic
tags:
  - migration
  - terminology
  - reference
related:
  - coming-from-arcgis-overview
---

The short version: when you'd say "X" in AGO, here you'd say
something else. Same thing, different label. We renamed where the
plain-English word was clearer; we kept the original where the
Esri vocabulary was already the clear word.

## Item types

| AGO term | GratisGIS term | Notes |
|---|---|---|
| Feature service | **Data layer** | The native, PostGIS-backed dataset item. |
| Hosted feature layer | **Data layer** | Same as above. |
| Web map | **Map** | An item composing layers, basemap, viewport. |
| Web AppBuilder app | **Web app** | Widget layout builder. Not a Web AppBuilder drop-in. |
| Experience Builder app | **Web app** | Nearby surface for a single-page widget layout. Not an Experience Builder drop-in. |
| Survey (Survey123) | **Form** | XLSForm import exists on the form designer. Not a Survey123 drop-in. The ArcGIS Online content importer skips surveys. |
| Survey responses | The form's **Responses** tab, backed by a paired data layer | A standalone form-submission item is not built. |
| Operations Dashboard | **Web app** (KPI Dashboard or Operations Board) | Dashboards are web-app layouts. There is no dashboard item type. |
| Field Maps | Field PWA and **data collection** | Offline capture and sync. Not a Field Maps drop-in. |
| Story Map | (no direct equivalent yet) | Future scope. |
| Notebook | (not built in; use a Tool item or external Jupyter against the data API) | Hosted notebooks deferred indefinitely. |
| Tile layer (cached map service) | **Tile layer** | Same term. PMTiles at rest. |
| Vector tile layer | **Tile layer** (vector kind) | Same item, different content. |
| Imagery layer | (no direct equivalent today) | Raster imagery support is on the roadmap; out of v1. |
| Geoenrichment / Routing services | (not built in) | Bring your own service via a tool item. |
| Solution template | (not built) | Layer packages and widget packages are reserved types with no editor. |

## Roles

| AGO role | GratisGIS role | Notes |
|---|---|---|
| Viewer | **Viewer** | Read-only access to shared items. |
| Data Editor | **Data editor** | Read + edit features on shared layers. |
| User | **User** | Standard signed-in user; same as AGO User. |
| Publisher | **Contributor** | Renamed because "publish" already means "make public." |
| Administrator | **Admin** | Full org control. |

## Sharing levels

| AGO sharing | GratisGIS sharing | Notes |
|---|---|---|
| Owner | **Owner only** | Item is private to you. |
| Organization | **Organization** | Visible to everyone in your org. |
| Public (everyone) | **Public** | Visible to anyone, including not signed in. |
| Groups | **Group** | Custom subsets within an org; same idea as AGO groups. |

## Geometry / data terms

| AGO term | GratisGIS term |
|---|---|
| Feature | **Feature** (same) |
| Attribute | **Field** (when talking schema) / **Attribute** (when talking row) |
| Domain (coded values) | **Pick list** (when shared across items) / **Field domain** (when inline) |
| Subtype | **Field subtype** (not a separate item type) |
| Relationship class | **Related sublayer** |
| Attachment | **Feature attachment** (same idea) |

## Operational terms

| AGO term | GratisGIS term |
|---|---|
| Credits | (none; self-hosted, no metering) |
| Tile generation job | **Tile layer upload** (we don't generate; you pre-tile and upload) |
| Geocoder service | **Geocoder** (a config, not a per-call charged service) |

## Why we renamed where we did

Two reasons. First, trademark hygiene: we're a different project,
and using Esri's specific vocabulary verbatim invites confusion.
Second, plainness: "data layer" tells you what the thing is in a
way "feature service" doesn't. "Contributor" is a recognizable
word; "publisher" is overloaded with "publish to the public."

Type names come from one place, so a chip, a badge and a list will
always call the same thing by the same name.
