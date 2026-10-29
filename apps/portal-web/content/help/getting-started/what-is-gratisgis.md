---
id: what-is-gratisgis
title: What is GratisGIS
summary: GratisGIS is a self-hosted open-source portal for publishing maps, datasets, forms, and apps. Familiar niche for teams coming from ArcGIS Online, without commercial licensing or a drop-in clone claim.
category: getting-started
order: 10
complexity: basic
tags:
  - overview
  - intro
related:
  - creating-your-first-map
  - coming-from-arcgis-online
---

GratisGIS is a portal you run yourself. It holds maps, datasets,
forms, dashboards, and the apps that consume them. The workflows
will feel familiar if you have used a cloud GIS portal before. The
differences are who owns the hardware, what the license says, and
that we are not a drop-in ArcGIS Online replacement.

## What it does

You upload data (Shapefile, GeoJSON, GeoPackage, KML), the portal
ingests it into PostGIS, and you can:

- **Style it on a map**. Symbology, labels, filters, popups.
- **Share it**. To specific users, to your whole organization, or
 publicly with a link.
- **Edit it from the field**. The field PWA works offline, syncs
 back when it sees the network.
- **Collect new features through forms**. The form designer
 produces a layer-backed survey; submissions land as real features
 in your layer.
- **Publish a web app**. Drag-and-drop builder with widgets
 (map, search, print, export, attribute table).
- **Analyze**. Derived layers chain steps like filter, calculate,
 spatial join, group-by, buffer, contour.

## What it isn't

- **A re-skin of QGIS.** The desktop app isn't in scope; GratisGIS
 is a portal for maps and data on the web.
- **A drop-in clone.** We deliberately don't use Esri's vocabulary
 where there's a clearer English word. *data layer* not *feature
 service*, *map* not *web map*, *contributor* not *publisher*. We
 also don't claim FeatureServer, Experience Builder, or Survey123
 parity.

## Who it's for

Small to medium organizations who:

- Want a portal-shaped workflow but can't or won't pay commercial
 portal prices.
- Need to keep data on-premise for compliance or sovereignty reasons.
- Want to extend the system themselves (it's AGPL-3.0).

## Where things live

Every addressable thing in GratisGIS is an **item**. Maps are items.
Data layers are items. Forms are items. Even basemaps and themes
are items. This consistency means sharing, deletion, dependency
tracking, and search all work the same way regardless of what you're
looking at.

The full list of item types lives at **Reference → Item types**.
