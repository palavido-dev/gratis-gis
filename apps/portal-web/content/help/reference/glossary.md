---
id: reference-glossary
title: Glossary
summary: Quick lookup of GratisGIS-specific terms. Each entry one or two sentences.
category: reference
order: 30
complexity: basic
tags:
  - reference
  - glossary
  - terminology
related:
  - coming-from-arcgis-terminology
  - reference-item-types
---

A flat lookup of terms used in the portal and in this
documentation. For the AGO term ↔ GratisGIS term mapping, see
**Terminology map** under Coming from ArcGIS Online.

## A

**Admin.** The role with full org control: user management, org
settings, housekeeping, backups, geocoders.

**ArcGIS service.** Item type wrapping a reference to an external
ArcGIS REST feature service or map service. Read-only proxy.

**As of (time slider).** A control in the map editor (and
attribute table) that shows the layer as it existed at a past
point in time. Powered by the engine's observation log.

**Attachment.** A file (typically a photo) bound to a specific
feature on a data layer. Stored in MinIO; the metadata row lives
in the `feature_attachment` table.

## B

**Basemap.** Item type wrapping a single base-layer reference
(style URL, tile URL, WMS, or portal map). Every map picks one.

**Bitemporal.** Stored with two time dimensions: when an event
happened in the world and when the system observed it. The
engine's observation log is bitemporal.

**Bundle export.** A `.zip` archive containing a layer's XLSX,
related-table rows, and attachments. The "give me the whole
thing" export option.

## C

**Calculate step.** A derived-layer step that adds a computed
column. Same expression dialect as filters.

**Class breaks.** A graduated-symbology mode where the value
range is divided into N classes, each rendered with its own
color or size.

**Cluster.** A run-time grouping of nearby point features into a
single rendered point. Configurable per map layer.

**Contributor.** A role that can publish items (data layers,
maps, forms, web apps). Formerly "publisher" in AGO vocabulary.

## D

**Data layer.** The native item type for feature data, owned by
the portal. One or more PostGIS-backed sublayers. The native
equivalent of an AGO feature service.

**Dependency.** A reference from one item to another. The portal
tracks dependencies in both directions so you can see what a
map references and what references a map.

**Derived layer.** Item type whose features are the materialized
result of an analysis pipeline. Lives in its own PostGIS table.

## E

**Engine.** The observation-log substrate underneath data
layers. Records every edit as an event; reads project the events
into the current state. Mostly invisible day-to-day.

## F

**Feature.** A single row in a layer. Has a geometry, attributes,
and (optionally) attachments.

**Feature service** (AGO term). Maps onto **data layer** in
GratisGIS. See **Terminology map**.

**Filter (map).** A per-map-layer condition that limits which
features render on that map. Doesn't alter the underlying layer.

**Folder.** Item type that groups other items by id. Items can
live in many folders simultaneously.

**Form.** Item type that collects responses from users. Bound to
a data layer (for spatial responses) or form submission
collection (non-spatial).

**Form submission collection.** Item type that backs a non-
spatial form. Holds responses with no geometry column.

## G

**Geo boundary.** Item type wrapping a reusable polygon
referenced by share limits, viewports, dashboard filters, clip
steps.

**Group by step.** A derived-layer step that rolls up rows by
key fields and computes aggregates per group.

## H

**Housekeeping.** The admin dashboard that surfaces stale items,
quiet users, and broken dependencies with bulk-action affordances.

## I

**Item.** Any addressable thing in the portal. Maps, data
layers, forms, web apps, dashboards, files, geo boundaries,
basemaps, tile layers, ... all items.

## L

**Layer.** A map layer reference. The map's per-layer style,
filter, popup config sits on the reference, not on the
underlying data layer.

**Layer package.** Item type wrapping an archive of a data
layer's schema + symbology + features for portable sharing.

## M

**Map.** Item type composing layers, basemap, viewport for
viewing or web-app rendering. Formerly "web map" in AGO
vocabulary.

## O

**Observation.** A single recorded event in the engine's log
("user U created feature F at time T", "user U set field X to
Y on feature F at time T"). Every edit is an observation.

**Organization.** The ownership boundary for content and
people. Every item and every user belongs to one org. A portal
serves a single organization; running a second one means
running a second portal.

## P

**Pick list.** Item type wrapping a reusable list of coded
values plus labels. Schema fields can reference a pick list.

**PMTiles.** The single-file tile container format used at rest
by Tile layer items. Range-readable over HTTP, no server
compute.

## R

**Report template.** Item type wrapping a parametrized document
layout that produces a populated PDF or DOCX on run.

## S

**Share geo limit.** A per-share polygon clip on a layer.
Restricts what the share's grantee can see to features inside
the polygon.

**Sharing.** The per-item access control. Three tiers (Owner
only, Organization, Public) plus optional per-user / per-group
shares.

**Sublayer.** One of the (potentially many) PostGIS-backed
tables inside a data layer. Each sublayer has its own schema and
geometry type.

## T

**Tile layer.** Item type wrapping a pre-rendered tile container
(PMTiles) uploaded to MinIO.

**Tool.** Item type wrapping a reusable analysis operation with
a declared signature. Runs on demand against caller-supplied
inputs.

## V

**Viewport.** A map's default center, zoom, bearing, pitch. Can
also include a bound geo-boundary so the default view follows the
polygon over time.

## W

**Web app.** Item type wrapping a standalone web page (map +
widgets) reachable at a URL. Template-driven.

**Widget package.** Item type wrapping an archive of a custom
Web App widget for installation.

**WMS.** The OGC Web Map Service protocol. GratisGIS supports
WMS as a basemap source kind.
