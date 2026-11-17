---
id: widget-print
title: Print widget
summary: Open a print template against the bound map, fill parameters, and print or save as PDF from the browser.
category: web-apps/widgets
order: 30
complexity: basic
controls:
  - id: widget-print-toggle
    label: "Print tile in the widget palette"
tags:
  - widget
  - print
  - export
related:
  - items-web-app
  - items-print-template
  - print-templates-overview
  - print-templates-print-this-map
---

The **Print** widget fills a **print template** against the map
widget it is bound to. The user picks a template, fills the
template's parameters, and opens a print page that triggers the
browser Print dialog (Save as PDF is the usual path).

This is map-on-paper output. It is not a data-driven document
report (that item type is not built; see
[Report template](items-report-template)).

## What it produces

- A **browser print page** sized to the template's paper
  (Letter / Legal / Tabloid / A3 / A4, portrait or landscape).
- The page includes whatever elements the template author placed:
  map frame, legend, scale bar, north arrow, text, images, lines,
  rectangles.
- The **map** content is a snapshot of the bound map's current
  view when the snapshot succeeds; otherwise the print page shows
  a placeholder for the map frame.

There is no server-side print archive from this widget. Recent
prints in the panel are links back to the same print URL for the
session.

## Layouts (print templates)

Layouts are **print template** items, not hard-coded widget
presets. Every org is seeded with starter templates (Letter
portrait / landscape, Letter landscape with large legend, Tabloid
landscape, Field summary). Authors create more from
**Create → Print template** or from a map's **Print** button.

In the widget properties:

- **Map widget.** Which map on the page to print.
- **Template allowlist** (optional). When set, the runtime
  dropdown shows only those templates (that the viewer can still
  read), in the order you configured. When empty, signed-in users
  see every print template they can read. For a **public** app,
  configure an allowlist so anonymous viewers can resolve those
  public templates; an empty allowlist leaves anon with no
  templates and a **Browser print** fallback.

## Runtime flow

1. User opens the Print panel and picks a template (pre-selected
   when only one is available).
2. The form shows that template's **parameters** (text, long text,
   number, date, dropdown) with defaults filled in.
3. **Print** opens `/print/<templateId>` with the values and a
   map snapshot token, then the browser print dialog runs.
4. If no templates resolve, the panel offers **Browser print**
   (`window.print` on the current app page) as a fallback.

## Notes

- **Pop-ups must be allowed** for the print tab to open.
- **External tiles** in the map snapshot follow the same
  cross-origin rules as the on-screen map; a failed snapshot
  still prints the template chrome with a map placeholder.
- **For paper from the map editor** without a web app, use
  [Print this map](print-templates-print-this-map).
- **For per-feature inspection PDFs / DOCX from layer rows**,
  that is a report template — not built. Use a print template
  when the deliverable is "this map view on paper."
