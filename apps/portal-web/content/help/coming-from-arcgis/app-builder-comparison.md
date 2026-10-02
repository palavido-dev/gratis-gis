---
id: coming-from-arcgis-app-builder
title: App builders comparison
summary: How Experience Builder, Web AppBuilder, and Operations Dashboard map onto GratisGIS web apps. Not a drop-in for any of them.
category: coming-from-arcgis
order: 50
complexity: basic
tags:
  - migration
  - web-app
  - dashboard
  - app-builder
related:
  - items-web-app
  - items-dashboard
  - web-apps-custom-app
---

If you are used to building apps in Esri's tooling, the nearby
surface in GratisGIS is a web app. It is not a drop-in for
Experience Builder, Web AppBuilder, or Operations Dashboard.

## Esri Web AppBuilder → GratisGIS Custom Web App

AGO's Web AppBuilder is a drag-and-drop widget builder bound to a
web map. A GratisGIS **custom** web app is the nearby surface:
pick a layout, place widgets, bind them to a map, configure each
widget, save. The widget sets are not the same, so this is not a
drop-in.

Widget catalog overlap (incomplete, growing): map, layer list,
basemap gallery, search, attribute table, legend, print, measure,
draw, splash, swipe, edit, layer effects. Several Esri-specific
widgets (Smart Editor with detailed editing config, Near Me,
Coordinate) don't have direct equivalents and are tracked as
follow-up work.

## Esri Experience Builder → GratisGIS Custom Web App

Experience Builder is more flexible than Web AppBuilder (full-page
layouts, multi-page apps, data injection between widgets). The
GratisGIS Custom template handles single-page widget composition;
**multi-page** custom apps are tracked as future scope. For now,
if you'd build an Experience with two pages, build two GratisGIS
web app items and link between them.

If you're recreating an Experience that was just "a map with
widgets" (most are), the Custom template covers that today.

## AGO Operations Dashboard → GratisGIS web app

There is no dashboard item. Create a web app and pick **KPI
Dashboard** or **Operations Board**. Those layouts ship indicator,
chart, table, and map widgets, and the templates refresh on a
schedule. A dashboard here can grow into any other web-app layout.
It is not an Operations Dashboard drop-in.

## AGO Instant Apps → GratisGIS Web app (Viewer / Editor)

Esri's Instant Apps are templated single-purpose apps (Sidebar,
Media Map, Compare, etc.). GratisGIS has two templated single-
purpose web app variants today: **Viewer** (read-only map) and
**Editor** (read + edit on permitted layers). The other Instant
App patterns (Compare, Story-style) are tracked as future scope.

## AGO Survey123 web app → GratisGIS Web app (Survey response)

The Survey123 default web app for taking a survey corresponds to
the GratisGIS **Survey response** web app template: a single
form, no surrounding map, public-friendly URL.

## What's missing today

Honest list of Esri concepts that don't have an equivalent right
now:

- **StoryMaps**. The narrative-with-embedded-maps format. Tracked
 as future scope.
- **Workforce / Field Maps configuration**. The GratisGIS field
 PWA is the field-facing surface; the configuration concepts
 (assignments, dispatcher) are simpler today.
- **GeoForm** (the older AGO survey app). Use **Form** with a
 Survey response template instead.

## See also

- **Web app**. The item type docs.
- **Dashboard**. The item type docs.
- **Custom Web App**. The drag-and-drop builder.
