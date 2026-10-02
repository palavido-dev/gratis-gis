---
id: items-web-app
title: Web app
summary: A standalone web page built from a map plus widgets. Nearby to Web AppBuilder. Not an Experience Builder drop-in.
category: items
order: 50
complexity: basic
tags:
  - web-app
  - item-type
  - app-builder
related:
  - items-map
  - web-apps-custom-app
  - web-apps-templates
---

A **web app** is an item that wraps a map with a chosen template,
a set of widgets, and a theme, producing a standalone web page
anyone with the link can open. This is how you give a non-portal
user something useful: not "go log into the portal and find this
map", but "here's a URL, click it".

## Templates

The web app item is template-driven. The current templates are:

- **Viewer**. Read-only map with optional widgets (search, layer
 list, basemap gallery, print, attribute table, measure).
- **Editor**. Same as viewer plus editing tools, scoped to the
 layers the viewer has edit rights on.
- **Survey response**. Single form, no map. The wrapper for a
 public-facing form.
- **Custom**. Drag-and-drop builder where you pick a layout and
 place widgets. The most flexible option.

Each template is its own runtime; switching templates is not in
scope (you'd create a new web app item).

## What's stored on the item

- **The bound map** (or form, for survey response).
- **Template choice**.
- **Widget configuration**. Per-widget settings (which fields show
 in attribute table, what layers print, etc.).
- **Theme**. Colors, fonts, logo.
- **Splash and disclaimer text**. Optional modal that opens on
 first visit.

## Sharing

A web app's URL respects the standard three-tier sharing. A
public web app gives anyone with the link read access; an
org-only web app requires a sign-in.

Sharing the web app does NOT automatically share its dependencies.
If the app references a data layer at Owner-only, public viewers
will see the map frame but no features. The dependency warning on
the detail page calls this out.

## Run vs. detail

- **Detail page**. Metadata, sharing, configure-launch buttons,
 dependency list. Find at `/items/<id>`.
- **Run page**. The standalone app a real user sees. Find at
 `/apps/<id>` (or whatever subdomain the org has configured).

The run page has no portal chrome. No top bar, no item nav. Just
the app.

## See also

- **Custom Web App**. The drag-and-drop builder for the Custom
 template.
- **Templates**. Side-by-side of which template fits which use case.
- **Theming web apps**. Color, font, logo per app.
