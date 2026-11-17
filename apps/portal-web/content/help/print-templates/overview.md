---
id: print-templates-overview
title: Print template overview
summary: How print template items lay out a paper page for the Print widget and the map editor Print button — not document reports or DOCX.
category: print-templates
order: 10
complexity: basic
tags:
  - print-templates
  - print
related:
  - items-print-template
  - widget-print
  - print-templates-print-this-map
  - print-templates-parameters
  - print-templates-tokens
  - items-report-template
---

A **print template** is a paper layout item: one canvas at a
chosen page size, free-positioned elements (map, legend, text,
and so on), and optional parameters the Print form asks for at
run time. Output is the browser print / Save as PDF path against
that page. It is **not** a Word/DOCX document template and it is
**not** the unbuilt [report template](items-report-template)
item.

See [Print template](items-print-template) for the item-type
reference. This section is the authoring and workflow view.

## Print template vs Print widget vs report template

- **Print template** (this section). The layout item you author
  once and reuse.
- **Print widget**. The web-app control that lets a viewer pick a
  template, fill parameters, and print the bound map. See
  [Print widget](widget-print).
- **Map editor Print**. Opens or creates a template bound to the
  map you are editing. See
  [Print this map](print-templates-print-this-map).
- **Report template**. Would fill PDF/DOCX from layer rows or
  form submissions. **Not built.**

Pick a print template when the audience wants a paper map with
title block, legend, and scale. Do not expect per-feature
inspection reports or DOCX merge from this path.

## The lifecycle

1. **Create the template.** Create → Print template (blank Letter
   portrait scaffold), restore/use an org starter, or use a map's
   Print → create new layout.
2. **Set paper.** Size, orientation, margin on the designer
   canvas.
3. **Declare parameters.** Title, author, notes, dropdowns — each
   with id, label, type, optional default and required flag. See
   [Parameters](print-templates-parameters).
4. **Place elements.** Drag text, image, map, legend, scalebar,
   north-arrow, line, and rectangle boxes. Text uses literal
   segments plus parameter / dynamic chips. See
   [Template tokens](print-templates-tokens).
5. **Preview and print.** From the designer, a web app's Print
   widget, or the map editor Print chooser.
6. **Share.** Sharing follows the item. Public apps that print for
   anonymous viewers need public templates on the widget
   allowlist.

## See also

- [Print template](items-print-template). Item-type reference.
- [Parameters](print-templates-parameters). Runtime form inputs.
- [Template tokens](print-templates-tokens). Text chips and
  dynamic values.
- [Report template](items-report-template). Document reports
  (not built).
