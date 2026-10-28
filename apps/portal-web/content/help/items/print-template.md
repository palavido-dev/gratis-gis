---
id: items-print-template
title: Print template
summary: A paper layout (page size, map frame, legend, text, parameters) that a web app's Print tool or the map editor Print button fills in and renders for PDF.
category: items/maps-and-apps
order: 55
complexity: intermediate
tags:
  - print-template
  - item-type
  - print
  - pdf
related:
  - widget-print
  - print-templates-overview
  - print-templates-print-this-map
  - print-templates-parameters
  - print-templates-tokens
  - items-report-template
  - items-map
  - items-web-app
---

A **print template** is a first-class item that defines one paper
page for the Print tool. It is not a document report and it is
not Word/DOCX. Create one from **Create → Print template**, or
from a map editor's **Print** button (see
[Print this map](print-templates-print-this-map)).

Every org gets five starter layouts on first sign-in (Letter
portrait / landscape, Letter landscape with large legend, Tabloid
landscape, Field summary). Admins can edit or delete them like
any other item.

## What it stores

The item's blueprint (`print_template` data) holds:

- **Paper.** Size (`letter`, `legal`, `tabloid`, `a3`, `a4`),
  orientation (portrait / landscape), and a uniform margin in
  inches (default 0.25").
- **Parameters.** Inputs the Print form prompts for at run time
  (title, author, notes, and anything else you declare). Types
  are text, long text, number, date, and dropdown. See
  [Parameters](print-templates-parameters).
- **Elements.** Free-positioned boxes on the page: **text**,
  **image**, **map**, **legend**, **scalebar**, **north-arrow**,
  **line**, and **rectangle**. Map / legend / scalebar /
  north-arrow auto-bind to the print job's map; you do not wire
  a map id by hand.
- **Optional layout notes** and an optional **default map** hint
  (stamped when you create the template from a map's Print
  button; preview only).

## How it is used

1. **In a web app.** Drop a **Print** widget, bind it to a map
   widget, and optionally allowlist which print templates appear.
   At run time the user picks a template, fills parameters, and
   opens a print page that triggers the browser Print dialog
   (Save as PDF). See [Print widget](widget-print).
2. **From a map editor.** The toolbar **Print** chooser opens an
   existing template or creates a new one pre-bound to that map.

Server-side Puppeteer render is used for some map-editor print
paths; the web-app Print widget opens a client print page with a
snapshot of the live map when available.

## Print template vs report template

| | Print template | Report template |
| --- | --- | --- |
| Status | Ships | Not built |
| Shape | One paper canvas + positioned elements | Would be a document layout over rows / submissions |
| Output | Browser print / PDF of the map page | Would be PDF / DOCX / HTML from data |
| Entry | Create → Print template; map Print; Print widget | Create picker does not offer it |

## See also

- [Print template overview](print-templates-overview) for the
  authoring workflow.
- [Parameters](print-templates-parameters) and
  [Template tokens](print-templates-tokens) for the form and
  text chips.
- [Report template](items-report-template) for the document
  report that is not built.
