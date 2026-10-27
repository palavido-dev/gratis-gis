---
id: print-templates-print-this-map
title: Print this map
summary: Print or PDF-export a map directly from its editor without first building a custom web app wrapper.
category: print-templates
order: 1
complexity: basic
tags:
  - print
  - export
  - pdf
related:
  - items-print-template
---

The map editor has a Print button in the toolbar. Click it to
land in the print layout designer with the calling map already
wired up.

## What you can do from the Print chooser

When you click the Print button, you see two options:

- **Create a new print layout pre-bound to this map.** Opens
  the print layout designer with this map already pointing at
  the Map, Legend, Scalebar, and North arrow elements. You start
  with a blank Letter portrait canvas and drag elements onto it.
- **Use an existing layout.** Lists every print layout you can
  read in the portal. Clicking one opens the layout's designer
  with this map wired in so you can adjust if needed and then
  print.

## Why the entry point matters

Print layouts have been part of GratisGIS for a while, but they
lived inside the custom web app builder — you had to build an
app to print a map. The Print button on the map editor closes
that gap so an author can print directly from any map they're
working on.

## How smart binding works

Every print layout has elements that need to know which map to
render: the Map frame itself, the Legend, the Scale bar, the
North arrow. When you open the designer from a map's Print
button, those elements auto-bind to the calling map. You don't
have to click each one and pick a map from a dropdown.

If you save the layout and use it later from a different map,
the same auto-binding rule applies: whichever map you're on
when you open the Print chooser is the one the elements wire up
to. The layout remembers its original map only as a default for
preview in the designer.

## Markup on the sheet

Print includes the map's markup overlays (pins, lines, polygons)
when those drawing sets are visible on the saved map. Toggle a
set off in the Markup pane and save before printing if you want
it omitted from the PDF. Viewer-only local hide toggles that are
not saved do not change the print.

Server-side Puppeteer render (Phase 2) is the path Print uses
today: text stays text and map markup paints through the same
MapLibre overlay the editor uses.

## Related

- [Print template item](items-print-template) for the designer
  and the element vocabulary.
