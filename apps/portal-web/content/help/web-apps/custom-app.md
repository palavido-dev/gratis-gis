---
id: web-apps-custom-app
title: Custom Web App
summary: The drag-and-drop builder for the Custom web app template. Layout, widgets, theme, and configuration on one canvas.
category: web-apps
order: 10
complexity: basic
tags:
  - web-app
  - custom-app
  - widgets
related:
  - items-web-app
  - web-apps-templates
  - web-apps-themes
---

The **Custom Web App** builder is the drag-and-drop editor for
web app items whose template is **Custom**. Pick a layout, drag
in widgets, configure them, save, share the URL.

## The four canvas panels

- **Layout outline** (left rail). The grid structure: header,
 left dock, map area, right dock, footer. Each slot can hold one
 or more widgets.
- **Widget catalog** (palette). The available widgets, grouped
 by category (Map, Search, Editing, Layout, Custom).
- **Canvas** (center). The visual preview, near-WYSIWYG.
- **Widget config** (right). Settings for the currently-selected
 widget.

## Picking a layout

The layout is a coarse template:

- **Map full screen** (default). Map fills the page; left/right
 docks slide in over.
- **Map with sidebar**. Map takes 70%, a fixed sidebar takes 30%.
 Sidebar widgets live always-on rather than slide-in.
- **Map with header bar**. A wide top bar above a full-width
 map.
- **Survey first**. A form / dialog dominates the page; the map
 is secondary.

Pick at app creation; switching layouts later preserves widgets
where possible.

## Adding widgets

Drag from the catalog into the slot you want. Each widget has
a default config; click the widget on the canvas to open its
config panel. Common config options:

- **Bound map**. Most map-related widgets reference the app's
 default map; some can override.
- **Bound layers**. A subset of the map's layers the widget
 acts on (the print widget's "what to include", the attribute
 table's "which layers to show").
- **Position**. Which dock/slot the widget lives in.
- **Visibility**. Always visible, hidden until opened, or
 opened by default on first load.

## Saving and previewing

- **Save** persists the app config; the app item updates.
- **Preview** opens the run-page in a new tab. The preview
 honors the current user's sharing permissions, so what you see
 in preview is what an org user with the same role would see.

## Publishing

Save + share. The detail page's sharing tier controls who can
open the app's URL. A Public app is reachable to anyone; an
Org-only app requires sign-in.

## Notes

- **Widget order matters for tab navigation.** Use the layout
 outline to set the order assistive tech walks the widgets.
- **No nested layouts** in v1. The Custom template is one-page;
 if you need a multi-page experience, create separate web app
 items and link between them.
- **The Custom template's runtime is shared** across web apps
 (one bundle, configured per app). Updating the runtime
 updates every Custom app at once on the next page load.
- **A phone gets a stacked layout.** Below a tablet width the
 canvas stops using the 192-column grid. Indicators that share
 a row sit two across, and maps, charts, and tables each take
 the width of the screen. Widen the window and the authored
 grid comes back.
